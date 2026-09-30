// Adds columns to already-live tables on machines that were provisioned before this column existed.
// schema.sql's CREATE TABLE IF NOT EXISTS can't do this (it no-ops once the table exists at all), and
// SQLite has no ADD COLUMN IF NOT EXISTS, so each addition is guarded by its own PRAGMA table_info check.
function columnExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function addColumnIfMissing(db, table, col, ddl) {
  if (!columnExists(db, table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrations] added ${table}.${col}`);
  }
}

function runMigrations(db) {
  // customer_profiles: 'name' was referenced by app.js/index.html since the table's introduction but
  // was never actually in schema.sql, so every insert failed silently — see server/app.js's
  // /api/customer_profiles mount for the fields list this restores parity with.
  addColumnIfMissing(db, 'customer_profiles', 'name', 'name TEXT');
  // AI-assisted corporate grouping confirm workflow (see server/routes/aiGrouping.js).
  addColumnIfMissing(db, 'customer_profiles', 'corp_source', "corp_source TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(db, 'customer_profiles', 'corp_confidence', 'corp_confidence REAL');
  addColumnIfMissing(db, 'customer_profiles', 'corp_confirmed', 'corp_confirmed INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'customer_profiles', 'corp_confirmed_by', 'corp_confirmed_by TEXT');
  addColumnIfMissing(db, 'customer_profiles', 'corp_confirmed_at', 'corp_confirmed_at TEXT');
  addColumnIfMissing(db, 'customer_profiles', 'branch', 'branch TEXT');
  // invoice_sales_monthly predates the slm_code dimension (see db/schema.sql). Wrong the first time:
  // added the column and assumed the stale 3-column PK (company,ym,cust_code) wouldn't matter since
  // syncInvoiceSales() DELETEs+re-INSERTs per company — missed that it now inserts one row per
  // *distinct slm_code* for the same customer/month, which the old PK rejects outright. Confirmed
  // live: every sync since that change failed with "UNIQUE constraint failed" (service-stderr.log),
  // silently leaving every row's slm_code at its default '' — the salesperson breakdown had nothing
  // to build from. SQLite can't ALTER a PRIMARY KEY, so recreate the table; it's fully disposable
  // (rebuilt whole from ARTRN every 5-minute sync), so dropping it costs nothing but one cycle's wait.
  addColumnIfMissing(db, 'invoice_sales_monthly', 'slm_code', "slm_code TEXT NOT NULL DEFAULT ''");
  const invPk = db.prepare('PRAGMA table_info(invoice_sales_monthly)').all().filter((c) => c.pk > 0).map((c) => c.name);
  if (!invPk.includes('slm_code')) {
    db.exec(`
      DROP TABLE invoice_sales_monthly;
      CREATE TABLE invoice_sales_monthly (
        company TEXT NOT NULL, ym TEXT NOT NULL, cust_code TEXT NOT NULL, slm_code TEXT NOT NULL DEFAULT '',
        amount REAL NOT NULL DEFAULT 0, invoice_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (company, ym, cust_code, slm_code)
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_sales_ym ON invoice_sales_monthly(ym);
      CREATE INDEX IF NOT EXISTS idx_invoice_sales_company ON invoice_sales_monthly(company);
    `);
    console.log('[migrations] recreated invoice_sales_monthly with PK (company,ym,cust_code,slm_code)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoice_sales_slm ON invoice_sales_monthly(slm_code)');
  // Emergency DB-side guard used only while an already-running Windows service still has the old
  // importer loaded. The current importer excludes LF/LE/LG directly; once this migration runs in a
  // restarted service, remove the temporary adjustment objects so new syncs cannot double-subtract.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_invoice_sales_exclude_doc_prefix_adjust;
    DROP TABLE IF EXISTS _invoice_sales_excluded_doc_adjustments;
  `);
  // TSS ARTRN RECTYP='0' AI69... invoices (2026-02-02..2026-02-08) are revenue-bearing and are
  // included by Express's sales report. New sync code includes RECTYP='0' directly, but production
  // service processes may keep an already-loaded worker until the Windows service is restarted. These
  // idempotent triggers keep the two known AI69 rollup keys correct if that old worker refreshes
  // invoice_sales_monthly before the service can be restarted. The amount guards prevent double-counting
  // once the new importer is active.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_invoice_sales_tss_ai69_patch_0001
    AFTER INSERT ON invoice_sales_monthly
    WHEN NEW.company='TSS' AND NEW.ym='2026-02' AND NEW.cust_code='01-OK-0001' AND NEW.slm_code='ON-001' AND NEW.amount < 300000
    BEGIN
      UPDATE invoice_sales_monthly
      SET amount = amount + 299268.62,
          invoice_count = invoice_count + 294
      WHERE company=NEW.company AND ym=NEW.ym AND cust_code=NEW.cust_code AND slm_code=NEW.slm_code;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_invoice_sales_tss_ai69_patch_0002
    AFTER INSERT ON invoice_sales_monthly
    WHEN NEW.company='TSS' AND NEW.ym='2026-02' AND NEW.cust_code='01-OK-0002' AND NEW.slm_code='ON-001' AND NEW.amount < 1000
    BEGIN
      UPDATE invoice_sales_monthly
      SET amount = amount + 1680.37,
          invoice_count = invoice_count + 1
      WHERE company=NEW.company AND ym=NEW.ym AND cust_code=NEW.cust_code AND slm_code=NEW.slm_code;
    END;
  `);

  // products.unit: STMAS.QUCOD (stock unit) was never synced before — every row silently fell back
  // to the column default 'กก.' regardless of the item's real unit (e.g. sold by "แพ" — pack — not
  // weight). See syncProducts()'s upsert in importFromExpress.js for the sync side.
  addColumnIfMissing(db, 'products', 'unit', "unit TEXT NOT NULL DEFAULT 'กก.'");
  // products.standard_price: optional selling price from Express STMAS (SELLPR*), used as a draft fallback.
  addColumnIfMissing(db, 'products', 'standard_price', 'standard_price REAL');
  // products.price_company (2026-09-23): which company's STMAS supplied standard_price — TSS keys its
  // prices in as net cost (ราคาทุนสุทธิ), so ใบเคาะราคา must reverse-calculate a selling price from it.
  addColumnIfMissing(db, 'products', 'price_company', 'price_company TEXT');

  // stock_movements_wms_daily.return_qty/writeoff_qty: added 2026-08-17 — PM (customer returns) and
  // XX (waste/spoilage write-offs) used to fall through every WMS_*_PREFIXES bucket uncategorized and
  // were silently dropped from this table entirely. See importFromExpress.js's WMS_RETURN_PREFIXES/
  // WMS_WRITEOFF_PREFIXES for the sync side.
  addColumnIfMissing(db, 'stock_movements_wms_daily', 'return_qty', 'return_qty REAL NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'stock_movements_wms_daily', 'writeoff_qty', 'writeoff_qty REAL NOT NULL DEFAULT 0');

  // stock_movements_daily.pm_qty: added 2026-09-30 — the PM (customer return) part of received_qty,
  // per warehouse (received_qty itself still includes it, unchanged for every existing reader).
  // tgm-wms's StockCountSummaryPage backs out same-day receipts from the Express figure but counts PM
  // as belonging to that day ("เอกสารหัว PM นับเข้าเป็นของวันนั้นๆ ด้วย"), so it subtracts
  // received_qty - pm_qty instead.
  addColumnIfMissing(db, 'stock_movements_daily', 'pm_qty', 'pm_qty REAL NOT NULL DEFAULT 0');
  // stock_movements_daily.wms_received_qty: added 2026-09-30 — the WMS "รับเข้า" prefixes only
  // (WMS_RECEIVED_PREFIXES: RH/RS/CP/JX/JT), per warehouse. received_qty is Express's broader bucket
  // (also RC/RR/RN/RI/JU/JW/PM and POSOPR-fallback prefixes — a paired JU+CP receipt lands there
  // twice), so backing it out over-subtracted on StockCountSummaryPage; this is the exact figure the
  // company-wide "net" path already backs out via stock_movements_wms_daily.received_qty.
  addColumnIfMissing(db, 'stock_movements_daily', 'wms_received_qty', 'wms_received_qty REAL NOT NULL DEFAULT 0');

  // stock_movements_wms_daily.received_value: added 2026-08-18 — TRNVAL summed from RH/RS receiving
  // rows, purchase-cost basis for tgm-wms's conversion-BOM average-cost feature. See
  // importFromExpress.js's RH_RS_PREFIXES for the sync side.
  addColumnIfMissing(db, 'stock_movements_wms_daily', 'received_value', 'received_value REAL NOT NULL DEFAULT 0');

  // stock_movements_wms_daily.dispatched_qty: added 2026-08-19 — VL/LT/TP prefixes (destination side,
  // any non-01 warehouse), separate from consi_qty/transfer_qty because these span many real branch
  // destinations, not just the 03/04/05 consignment pool. Used only by tgm-wms's StockCountSummaryPage.
  // See importFromExpress.js's WMS_DISPATCHED_PREFIXES for the sync side.
  addColumnIfMissing(db, 'stock_movements_wms_daily', 'dispatched_qty', 'dispatched_qty REAL NOT NULL DEFAULT 0');

  // promo_docs.create_date/doc_ref: added 2026-08-26 — document creation date and Express's YOUREF
  // reference number, requested as extra columns on the promo history page. See syncPromoDocs()'s
  // comment in importFromExpress.js for the DBF-field mapping.
  addColumnIfMissing(db, 'promo_docs', 'create_date', 'create_date TEXT');
  addColumnIfMissing(db, 'promo_docs', 'doc_ref', 'doc_ref TEXT');
  // Index lives here, not in schema.sql, because this runs AFTER the column is guaranteed to exist —
  // see schema.sql's comment on this same index for the crash this avoids.
  db.exec('CREATE INDEX IF NOT EXISTS idx_promo_docs_create_date ON promo_docs(create_date)');

  // outbound_orders.dlv_date: added 2026-08-27 — tgm-wms's "SO ล่วงหน้า" was filtering/bucketing by
  // order_date (when the order was placed) instead of the customer's actual expected delivery date,
  // so an order created outside the viewed date range never showed even when its delivery date fell
  // inside it. See schema.sql's comment on this column and importFromExpress.js's syncSales() for the
  // DBF-field mapping (OESO.DBF's DLVDAT).
  addColumnIfMissing(db, 'outbound_orders', 'dlv_date', 'dlv_date TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_orders_dlv_date ON outbound_orders(dlv_date)');

  // promo_drafts: gp_pct/cost_price/cost_start_date/cost_end_date/discount_scope/equipment/updated_by
  // were added here 2026-09 for the "สร้างใบโปรใหม่" redesign — SUPERSEDED 2026-09-11 by the
  // header/lines split below (cost_start_date/cost_end_date/discount_scope/equipment/updated_by moved
  // to the new promo_draft_headers table; gp_pct/cost_price are still line-level and live inline on
  // the new slim promo_drafts shape's CREATE TABLE instead of via addColumnIfMissing). Removed the old
  // addColumnIfMissing calls entirely — they used to re-add these columns to promo_drafts on every
  // startup regardless of shape, which on a FRESH install meant they'd get re-added right back onto
  // the new slim table seconds after schema.sql created it without them (confirmed live in a fresh-DB
  // test before this fix). The shape-detection block below handles both cases correctly without them.

  // audit_log.target: index added now that the promo-draft redesign actually filters by it (a
  // per-document "ประวัติการแก้ไข" trail) — the column existed from the start but nothing queried by
  // it before, so no index existed.
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target)');

  // promo_drafts header/lines split (2026-09-11, "ใบเคาะราคา" v2) — promo_drafts used to carry BOTH
  // document-level fields (promo_name, condition_type, ...) AND line-level fields (cust_code, sku, ...)
  // in one row per branch×SKU, which duplicated the header across every fanned-out row. That became a
  // real problem once v2 needed document-only data (approval routing state, NPD/off-contract/marketing
  // checkboxes, file attachments, a free-form other-costs table) — see server/db/schema.sql's comment
  // on promo_draft_headers for the full reasoning. schema.sql now defines the FINAL slim shape for
  // promo_drafts (CREATE TABLE IF NOT EXISTS, so it only takes effect on a brand-new DB); an
  // already-provisioned DB still has the OLD wide table under that name (schema.sql's IF NOT EXISTS
  // already no-op'd against it by the time this runs), so it must be dropped and recreated here —
  // same pattern as the invoice_sales_monthly PK recreate above. Confirmed directly against the real
  // production DB on 2026-09-11 that promo_drafts had 0 rows (the feature shipped 2026-09-08, nobody
  // had used it yet) — safe to drop outright. Still guard defensively in case some OTHER environment
  // reaches this with real rows already in the old shape: abort loudly rather than silently discard.
  const promoDraftsCols = db.prepare('PRAGMA table_info(promo_drafts)').all().map((c) => c.name);
  const promoDraftsIsOldShape = promoDraftsCols.includes('promo_name'); // only the pre-split shape had this
  if (promoDraftsIsOldShape) {
    const { n: promoDraftsRowCount } = db.prepare('SELECT COUNT(*) AS n FROM promo_drafts').get();
    if (promoDraftsRowCount > 0) {
      throw new Error(
        `promo_drafts has ${promoDraftsRowCount} existing row(s) in the old (pre-header-split) shape — ` +
        'refusing to auto-migrate and silently drop real data. Back up promo_drafts and migrate its rows ' +
        'into promo_draft_headers/promo_drafts (new slim shape) by hand before rerunning.'
      );
    }
    // FIXED (2026-09-13, /code-review): DROP+CREATE used to be two separate, unwrapped statements —
    // if the process died in the gap (service restart mid-boot, OOM, power loss), promo_drafts would
    // be left missing entirely, and the promoDraftsIsOldShape guard above (PRAGMA table_info on a
    // now-nonexistent table returns no columns) would never re-trigger this block on the next boot,
    // so every /api/promo_drafts route would 400 forever until someone noticed. Wrapping in a
    // transaction (this codebase's established convention for atomic writes) makes the whole
    // drop+recreate all-or-nothing.
    try {
      db.exec('BEGIN');
      db.exec('DROP TABLE promo_drafts');
      db.exec(`
        CREATE TABLE promo_drafts (
          id             TEXT PRIMARY KEY,
          draft_no       TEXT NOT NULL,
          corporate      TEXT,
          cust_code      TEXT NOT NULL,
          cust_name      TEXT,
          sku            TEXT NOT NULL,
          sku_name       TEXT,
          equipment_set  TEXT,
          normal_price   REAL,
          unit_price     REAL NOT NULL DEFAULT 0,
          discount_pct   REAL,
          gp_pct         REAL,
          cost_price     REAL,
          estimated_qty  REAL,
          start_date     TEXT,
          due_date       TEXT,
          created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_promo_drafts_draft_no ON promo_drafts(draft_no);
        CREATE INDEX IF NOT EXISTS idx_promo_drafts_cust_sku ON promo_drafts(cust_code, sku);
      `);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.log('[migrations] dropped old-shape promo_drafts (confirmed empty) — recreated slim lines-only shape');
  }

  // promo_drafts.weight (2026-09-16, code-review batch): per-line pack weight (กก.), user-entered,
  // shown alongside the price breakdown — no auto-fill source exists yet, purely a new input field.
  addColumnIfMissing(db, 'promo_drafts', 'weight', 'weight REAL');
  addColumnIfMissing(db, 'promo_drafts', 'equipment_set', 'equipment_set TEXT');
  // promo_drafts.gp_pct/cost_price (already existed) now specifically mean the "ราคาปกติ" side of the
  // 3-column breakdown (ราคาขาย/GP%/ราคาทุนสุทธิ); these two new columns are the same breakdown for the
  // "ราคาโปรโมชั่น" side (unit_price), since the two sides can have the SKU cost calculated from
  // different selling prices even off the same GP% — see index.html's draftLineCost()/2026-09-16 note.
  addColumnIfMissing(db, 'promo_drafts', 'gp_pct_promo', 'gp_pct_promo REAL');
  addColumnIfMissing(db, 'promo_drafts', 'cost_price_promo', 'cost_price_promo REAL');
  addColumnIfMissing(db, 'promo_drafts', 'estimated_qty', 'estimated_qty REAL');

  // promo_drafts.is_sub_item (2026-09-16, ข้อ 4.4; ขยายรองรับ 1.1.1 เพิ่มเติมวันเดียวกัน): รหัสสินค้าที่
  // ขึ้นต้นด้วย "9" คือรหัสราคาพิเศษที่จับสินค้าจริงหลายรายการรวมกัน — ผู้ใช้กด "+ เพิ่มรายการย่อย" ใต้บรรทัด
  // รหัส 9 แล้วบรรทัดย่อยที่ตามมาจะถูก flag ไว้ตรงนี้ เก็บเป็น "ความลึก" ไม่ใช่ boolean อีกต่อไป: 0=บรรทัด
  // หลัก, 1=รายการย่อย (1.1), 2=รายการย่อยของย่อย (1.1.1 — เมื่อ SKU ของรายการย่อยชั้น 1 เองก็ขึ้นต้นด้วย 9)
  // — จำกัดไว้ที่ 2 ชั้นกันการซ้อนไม่รู้จบ (client แสดงผลเป็นเลขลำดับ 1.1/1.1.1/1.2 ใต้บรรทัดหลัก 1 — ดู
  // index.html's draftRenderLines()/_draftLineNumbers()) แต่ละบรรทัดย่อยยังเป็นสินค้าจริงที่มี SKU/ราคา/
  // ปริมาณของตัวเองครบ ไม่ต่างจากบรรทัดทั่วไป แค่เลขลำดับที่แสดงผลต่างกันเท่านั้น — ไม่ต้องมี "group id" เพิ่ม
  // เพราะบรรทัดย่อยจะถูกเก็บเรียงถัดจากบรรทัดแม่ของมันเสมอ (ลำดับแถวอาศัย created_at เดียวกับที่ระบบนี้
  // พึ่งพาอยู่แล้วสำหรับการจับคู่ branch×SKU ตอนโหลดกลับ)
  addColumnIfMissing(db, 'promo_drafts', 'is_sub_item', 'is_sub_item INTEGER DEFAULT 0');

  // customer_profiles.gp_pct (2026-09-16): ใบเคาะราคา's per-line GP% now defaults from this customer
  // master value instead of being typed from scratch every time — see index.html's draftLineField()/
  // draftMsToggle() for where this gets read as the default.
  addColumnIfMissing(db, 'customer_profiles', 'gp_pct', 'gp_pct REAL');

  // promo_draft_headers.promo_no (2026-09-16): a SECOND, separate running number issued atomically
  // only once a document clears final approval — the document is then renamed "ใบโปรโมชั่น" in the UI
  // and keeps its original doc_no (PC-series) as a back-reference. Nullable (most rows never reach
  // approval), so a plain UNIQUE column constraint isn't addable via ALTER TABLE in SQLite — use a
  // partial unique index instead (allows unlimited NULLs, still rejects a real duplicate promo_no).
  addColumnIfMissing(db, 'promo_draft_headers', 'promo_no', 'promo_no TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pdh_promo_no ON promo_draft_headers(promo_no) WHERE promo_no IS NOT NULL');

  // ใบเคาะราคา (2026-09-23): ส่วนลดท้ายบิล% ต่อฝั่ง (ปกติ/โปร — หักต่อจาก GP ในสูตรทุนสุทธิ), Compensate
  // (บาท/หน่วย ฝั่งโปร — ราคาขายโปร = ราคาปกติ − compensate) และหัวเอกสาร "มี Compensate" (บังคับกรอกทุก
  // บรรทัด) + รูปแบบการจัดจำหน่ายพิเศษ (ข้อความอิสระ)
  addColumnIfMissing(db, 'promo_drafts', 'bill_disc_pct', 'bill_disc_pct REAL');
  addColumnIfMissing(db, 'promo_drafts', 'bill_disc_pct_promo', 'bill_disc_pct_promo REAL');
  addColumnIfMissing(db, 'promo_drafts', 'compensate', 'compensate REAL');
  addColumnIfMissing(db, 'promo_draft_headers', 'has_compensate', 'has_compensate INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'promo_draft_headers', 'special_distribution', 'special_distribution TEXT');

  // ลายเซ็น (2026-09-23, แบบเดียวกับ e-memo): รูปลายเซ็นประจำตัวผู้ใช้ (PNG data URL) แยกตารางจาก sc_users
  // เพื่อไม่ให้รายชื่อผู้ใช้ที่ทุกหน้าโหลดพ่วงรูปไปด้วย — ตอนอนุมัติ server snapshot รูปนี้ลง approver entry
  // ใน levels_json (เปลี่ยนลายเซ็นทีหลังไม่กระทบเอกสารที่อนุมัติไปแล้ว)
  db.exec(`CREATE TABLE IF NOT EXISTS user_signatures (
    uid        TEXT PRIMARY KEY,
    image      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  // promo_draft_headers.approval_history_json: ขั้นอนุมัติที่ผ่านไปแล้วก่อนถูกส่งต่อผู้บริหาร — เดิม levels_json
  // ถูกแทนที่ด้วยขั้นผู้บริหารทั้งก้อน ทำให้ชื่อ/เวลา/ลายเซ็นผู้อนุมัติขั้นปกติหายไปจากเอกสาร
  // หัวข้อเพิ่มตามฟอร์มใบเคาะกระดาษ (2026-09-24): สถานที่ขาย / ประเภทสินค้า / ค่าแรกเข้า-ลงสื่อ เก็บเป็น JSON ก้อนเดียว
  // คอมเมนต์ลอยปักตำแหน่งในเอกสาร (2026-09-24): anchor = "<key>|<ป้ายชื่อ>" เช่น "cell:TG0026:9|TG0026 · GP%"
  // แถวที่มี anchor ใช้ sku = '' (คอมเมนต์รายบรรทัดเดิมยังใช้ sku ตามเดิม)
  addColumnIfMissing(db, 'promo_draft_line_comments', 'anchor', 'anchor TEXT');
  addColumnIfMissing(db, 'promo_draft_headers', 'form_extra_json', "form_extra_json TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, 'promo_draft_headers', 'approval_history_json', "approval_history_json TEXT NOT NULL DEFAULT '[]'");
  // เส้นทางอนุมัติหลายแบบ (2026-09-24): ว่าง = เส้นทางมาตรฐาน ('promo_draft'), มีค่า = 'promo_draft@<route_id>'
  addColumnIfMissing(db, 'promo_draft_headers', 'route_id', 'route_id TEXT');
  addColumnIfMissing(db, 'promo_draft_headers', 'route_name', 'route_name TEXT');
  // ลิงก์อนุมัติทางอีเมล (2026-09-23, แบบ e-memo): 1 token ต่อผู้อนุมัติต่อขั้นที่ถูกแจ้ง — ใช้ได้เฉพาะตอนที่
  // เอกสารยังรออนุมัติ อยู่ขั้นเดิม และผู้อนุมัติคนนั้นยังไม่ได้ตัดสินใจ (ตรวจซ้ำทุกครั้งใน routes/promoEmailApprove.js)
  db.exec(`CREATE TABLE IF NOT EXISTS promo_approval_tokens (
    token       TEXT PRIMARY KEY,
    draft_no    TEXT NOT NULL,
    uid         TEXT NOT NULL,
    status      TEXT NOT NULL,
    level_index INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    used_at     TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pat_draft ON promo_approval_tokens(draft_no)');

  // invoice_lines (2026-09-17): STCRD invoice-level item lines for route-billing fallback
  // when an ARTRN invoice has no linked SO number.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_lines (
      company     TEXT NOT NULL,
      doc_num     TEXT NOT NULL,
      seq_num     TEXT,
      doc_date    TEXT,
      sku         TEXT,
      sku_name    TEXT,
      warehouse   TEXT,
      qty         REAL NOT NULL DEFAULT 0,
      unit_code   TEXT,
      unit_factor REAL,
      line_value  REAL,
      ref_num     TEXT,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (company, doc_num, seq_num, sku, warehouse)
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_lines_doc ON invoice_lines(doc_num);
    CREATE INDEX IF NOT EXISTS idx_invoice_lines_sku ON invoice_lines(sku);
  `);

  // outbound_lines.seq_num + sales_line_components (2026-09-17): keep Express OESOIT.SEQNUM
  // so ARTRNRM line notes can be promoted into a reusable per-order child SKU table for 90022 packs.
  addColumnIfMissing(db, 'outbound_lines', 'seq_num', 'seq_num TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_lines_order_seq ON outbound_lines(order_id, seq_num)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_line_components (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      company       TEXT NOT NULL,
      order_id      TEXT NOT NULL,
      order_no      TEXT NOT NULL,
      seq_num       TEXT NOT NULL,
      parent_sku    TEXT,
      child_code    TEXT NOT NULL,
      child_name    TEXT,
      child_qty     REAL NOT NULL DEFAULT 0,
      note          TEXT,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(company, order_no, seq_num, child_code, note)
    );
    CREATE INDEX IF NOT EXISTS idx_sales_line_components_order ON sales_line_components(order_id);
    CREATE INDEX IF NOT EXISTS idx_sales_line_components_parent ON sales_line_components(parent_sku);
    CREATE INDEX IF NOT EXISTS idx_sales_line_components_child ON sales_line_components(child_code);
  `);

  // invoices.route_code/route_name (2026-09-16, สายรถ feature — see ROUTE_TABTYP in
  // importFromExpress.js): ARTRN.AREACOD resolved via ISTAB TABTYP='41' at sync time.
  addColumnIfMissing(db, 'invoices', 'route_code', 'route_code TEXT');
  addColumnIfMissing(db, 'invoices', 'route_name', 'route_name TEXT');
  // invoices.ship_to_code/ship_to_address (2026-09-17, สายรถ feature): ARTRN.SHIPTO resolved by
  // joining ARSHIP.DBF on CUSCOD+SHIPTO at sync time so tgm-wms can print the real delivery place.
  addColumnIfMissing(db, 'invoices', 'ship_to_code', 'ship_to_code TEXT');
  addColumnIfMissing(db, 'invoices', 'ship_to_address', 'ship_to_address TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_route_code ON invoices(route_code)');
  // Dashboard and Sales Overview read current-year aggregates by month and salesperson on every open.
  // Keep those reads index-backed so the single SQLite-backed API does not stall the UI as history grows.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sales_ov_ym_slm ON v_sales_overview_sales_monthly(ym, slm_owner);
    CREATE INDEX IF NOT EXISTS idx_sales_ov_ym_company ON v_sales_overview_sales_monthly(ym, company);
    CREATE INDEX IF NOT EXISTS idx_sales_ov_prod ON v_sales_overview_sales_monthly(prod_code);
    CREATE INDEX IF NOT EXISTS idx_sales_ov_cust ON v_sales_overview_sales_monthly(cust_code);
  `);

  // express_stock_snapshots (2026-09-28): ยอด Express ที่ tgm-wms freeze ไว้รายวัน ย้ายมาจาก Supabase ของ
  // tgm-wms — ดู routes/expressSnapshots.js. source = auto (ระบบคำนวณ) / manual (กรอกเอง) / csv (นำเข้าไฟล์)
  db.exec(`
    CREATE TABLE IF NOT EXISTS express_stock_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_code      TEXT NOT NULL,
      snapshot_date TEXT NOT NULL,
      kind          TEXT NOT NULL,
      qty           REAL NOT NULL DEFAULT 0,
      unit          TEXT,
      source        TEXT NOT NULL DEFAULT 'auto',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(snapshot_date, kind, sku_code)
    );
  `);

  // sc_users.slm_codes (2026-09-28): รหัสพนักงานขายใน Express (SLMCOD เช่น 101,110-1) ที่ผูกกับผู้ใช้ — คั่นด้วย ,
  // เดิม slm_id เก็บชื่อบัญชี (piyaporn ฯลฯ) ซึ่งไม่ตรงกับรหัสในข้อมูลขาย จึงกรองยอดของเซลส์ไม่ได้
  addColumnIfMissing(db, 'sc_users', 'slm_codes', 'slm_codes TEXT');

  require('./customerProfileRollups').migrateCustomerProfileRollups(db);
}

module.exports = { runMigrations, columnExists, addColumnIfMissing };
