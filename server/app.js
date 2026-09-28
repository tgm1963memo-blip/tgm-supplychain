const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const { makeCrudRouter } = require('./lib/crud');
const { requireAuth, requireRole } = require('./middleware/auth');
const usersRoutes = require('./routes/users');

const ARCHIVE_COMPANY = {
  'TSS-67': 'TSS',
  'TSS-68': 'TSS',
  'TSSN-67': 'TSS-NV',
  'TSSN-68': 'TSS-NV',
  'CONSI-67': 'CONSI',
};

function normalizeCompanyScope(value) {
  const s = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('TGM')) return 'TGM';
  if (s.startsWith('CONSI')) return 'CONSI';
  if (s === 'TSSNV' || s.startsWith('TSSN') || s.includes('NV')) return 'TSSNV';
  if (s.startsWith('TSS')) return 'TSS';
  return s || 'TSS';
}

function dedupeArchiveRows(rows, keyFields) {
  const keyOf = (row, company) => [normalizeCompanyScope(company || row.company), ...keyFields.map((k) => String(row[k] ?? '').trim())].join('|');
  const primaryKeys = new Set();
  for (const row of rows || []) {
    const raw = String(row.company || '').trim().toUpperCase();
    if (ARCHIVE_COMPANY[raw]) continue;
    primaryKeys.add(keyOf(row, raw));
  }
  return (rows || []).filter((row) => {
    const raw = String(row.company || '').trim().toUpperCase();
    const canonical = ARCHIVE_COMPANY[raw];
    if (!canonical) return true;
    return !primaryKeys.has(keyOf(row, canonical));
  });
}

// NOTE on route naming: paths below intentionally match the exact Supabase table/view names used
// throughout index.html's `.from('table_name')` calls (snake_case, not REST-ish kebab-case) —
// the client's makeLocalClient() shim builds URLs as `${API_BASE}/${table}`, so the two must agree.
function buildApp(db, opts = {}) {
  const { triggerSyncNow } = opts;
  const app = express();
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  // Temporary outer gate for exposing this server through a tunnel for remote testing (2026-07-17,
  // requested by user) — set TUNNEL_ACCESS_PASSWORD to require HTTP Basic Auth on every request
  // ahead of the app's own login; leave it unset for normal LAN operation (no extra prompt). Remove
  // the env var (or restart without it set) once the tunnel test is done.
  if (process.env.TUNNEL_ACCESS_PASSWORD) {
    const expected = 'Basic ' + Buffer.from(`tgm:${process.env.TUNNEL_ACCESS_PASSWORD}`).toString('base64');
    app.use((req, res, next) => {
      if (req.headers.authorization === expected) return next();
      res.set('WWW-Authenticate', 'Basic realm="TGM Supply Chain (testing)"');
      res.status(401).send('Authentication required');
    });
  }

  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
  // Confirmed live 2026-08-26 (user reported "the whole system feels slow"): every JSON response from
  // every endpoint was being sent uncompressed — curl with Accept-Encoding: gzip,br got no
  // Content-Encoding back at all. That compounds with the current temporary Cloudflare tunnel's
  // measured ~87ms/request overhead (vs ~1.4ms hitting the server directly on localhost) — smaller
  // payloads matter more when every byte crosses that hop. threshold skips tiny responses (health
  // checks etc.) where gzip's own overhead isn't worth it; level 6 is zlib's default speed/ratio
  // balance, appropriate for the DB PC's modest CPU.
  app.use(compression({ threshold: 1024, level: 6 }));
  app.use(express.json({ limit: '5mb' }));

  // Serves only this one file (never a directory listing) so index.html can be opened through the
  // same tunnel/port as the API — do not switch this to express.static() on the repo root, which
  // would also expose server/.env, server/db/tgm.db, and the rest of the source tree over HTTP.
  app.get('/shared/approval-workflow.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'shared', 'approval-workflow.js')));
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/auth', require('./routes/passwordReset')(db));
  app.use('/api/perms', require('./routes/perms')(db));
  app.use('/api/vision', require('./routes/vision')(db));

  const { scUsers, safeView } = usersRoutes(db);
  app.use('/api/sc_users', scUsers);
  app.use('/api/v_sc_users_safe', safeView);

  const authed = requireAuth(db);
  // Master-data writes (product/customer/salesman overlays, product parent-child mapping) are
  // restricted to these roles — sc_users.role is free-text with no enum; only 'superadmin' has any
  // real row today (the seeded SADM user). Create a role='planning' user to exercise the 403 path.
  const MASTER_DATA_ROLES = ['superadmin', 'admin', 'planning', 'planning_manager', 'planning_officer', 'planning_worker'];
  // FIXED (2026-09-13, /code-review): po_emails' PATCH (change status new/imported/ignored) had no
  // role gate at all — moved the mount here (was above, before MASTER_DATA_ROLES existed) so it can
  // reuse the same Planner-facing role list tgm-wms's PO review flow already implies.
  app.use('/api/po_emails', require('./routes/poEmails')(db, MASTER_DATA_ROLES));
  // ยอด Express ที่ tgm-wms freeze ไว้รายวัน (ย้ายมาจาก Supabase 2026-09-28) — เขียน/ลบต้องมี token ผู้ใช้ tgm-wms ด้วย
  app.use('/api/express_stock_snapshots', authed, require('./routes/expressSnapshots')(db));
  app.use('/api/invoice_detail', authed, require('./routes/invoiceDetail')(db));
  // สิทธิ์เขียนใบโปรร่าง (promo_drafts, 2026-09-03) — ให้ตรงกับ role ที่เข้าหน้า promo_history ได้อยู่แล้ว
  // (MASTER_DATA_ROLES ด้านบนไม่มี role ฝ่ายขายเลย ใช้ไม่ได้กับฟีเจอร์นี้)
  const PROMO_DRAFT_ROLES = ['superadmin', 'admin', 'sales_manager', 'sales_officer', 'sales_worker', 'sales'];
  // สิทธิ์เขียนของตัวอย่าง (sample_requests, 2026-09) — หน้านี้ให้ทั้งฝ่ายขาย (สร้าง/อนุมัติ) และฝ่าย
  // planning/warehouse (เตรียม/จัดส่ง) เขียนได้ ต้องรวม role ทั้งสองฝั่ง (MASTER_DATA_ROLES ไม่มี role
  // ฝ่ายขาย/คลังเลย ใช้ไม่ได้กับฟีเจอร์นี้เหมือนกับ PROMO_DRAFT_ROLES ด้านบน)
  const SAMPLE_REQUEST_ROLES = ['superadmin', 'admin', 'manager',
    'sales', 'sales_manager', 'sales_officer', 'sales_worker',
    'planning', 'planning_manager', 'planning_officer', 'planning_worker', 'warehouse'];
  // สิทธิ์เขียนข้อมูลลูกค้า/ไฟล์แนบ (custreg_subs, custreg_attachments, 2026-09) — ตรงกับ canCreate ใน
  // pgSample()-style gate ของหน้านี้เอง (index.html: sales/manager/superadmin สร้างได้ — ไม่มี planning/
  // warehouse เกี่ยวข้องกับฟีเจอร์นี้ ต่างจาก sample_requests)
  const CUSTREG_ROLES = ['superadmin', 'admin', 'manager', 'sales', 'sales_manager', 'sales_officer', 'sales_worker'];
  // แก้ workflow config (pgCrWorkflowSettings) เป็นงาน admin ล้วนๆ แยกจากสิทธิ์สร้างคำขอปกติ
  const APPROVAL_WORKFLOW_ROLES = ['superadmin', 'admin', 'manager'];

  // ADDED (2026-08-20 ตามที่ผู้ใช้ระบุ "โหลดใหม่ทันทีเลยได้ไหม" หลังพบ Z:\ExpressI หลุดชั่วคราวแล้วต่อกลับมา):
  // ปกติไม่มีทางสั่ง sync ทันทีได้เลย ต้องรอ cron ทุก 5 นาที — เปิด endpoint นี้ให้เรียก worker เดิมได้ตามต้องการ
  // แทน (ดู server.js's triggerSyncNow) กัน authed เฉยๆ ไม่จำกัด MASTER_DATA_ROLES เหมือนตารางอื่นด้านล่าง
  // เพราะผู้เรียกจริงมีแค่ tgm-wms เดียว (ผ่าน WMSAPI service account, role='service_readonly') และฝั่ง
  // tgm-wms เองก็กด ADMIN/SUPER_ADMIN เท่านั้นถึงจะเห็นปุ่มนี้อยู่แล้ว — การ resync ไม่ใช่การเขียนทับ master
  // data ใดๆ เป็นแค่รันงานเดิมที่ cron ทำอัตโนมัติทุก 5 นาทีอยู่แล้วให้เร็วขึ้นเท่านั้น ไม่มีความเสี่ยงเพิ่ม
  app.post('/api/admin/sync_now', authed, async (req, res) => {
    if (!triggerSyncNow) return res.status(501).json({ error: 'sync trigger not wired up on this server instance' });
    try {
      await triggerSyncNow();
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // ── mirror tables (sourced from Express DBF import) — read-only from the app's perspective.
  //    Edits belong in the overlay tables below (customer_profiles/sku_settings/salesmen_profiles/
  //    consi_bom_master); a write here would just be silently reverted by the next 5-minute sync,
  //    so these mounts no longer expose write verbs at all. ──
  app.use('/api/products', authed, makeCrudRouter(db, 'products', {
    pk: 'code',
    fields: ['code', 'name', 'group_name', 'unit', 'lead_time', 'moq', 'min_stock', 'shelf_life', 'plant', 'is_active', 'note', 'standard_price', 'price_company'],
    readOnly: true,
  }));

  app.use('/api/customers', authed, makeCrudRouter(db, 'customers', {
    pk: 'code',
    fields: ['code', 'name', 'cust_group', 'slm_id', 'is_active'],
    readOnly: true,
  }));

  app.use('/api/salesmen', authed, makeCrudRouter(db, 'salesmen', {
    pk: 'slm_id',
    fields: ['slm_id', 'name'],
    readOnly: true,
  }));

  // FIXED (2026-08-05, security review): unlike every sibling Express-mirrored table above, this
  // one was missing `readOnly: true` — any authenticated bearer token (including the leaked
  // read-only WMSAPI service account) could POST/PATCH/DELETE rows here, silently reverted only by
  // the next 5-minute sync in the meantime. Read paths (GET) are completely unaffected.
  app.use('/api/sales_history', authed, makeCrudRouter(db, 'sales_history', {
    pk: 'id',
    fields: ['slm_id', 'sku', 'ym', 'qty', 'amount'],
    touch: [],
    readOnly: true,
  }));

  app.use('/api/sales_transactions', authed, makeCrudRouter(db, 'sales_transactions', {
    pk: 'id',
    fields: ['company', 'tx_date', 'sku', 'cust_code', 'slm_id', 'qty', 'amount', 'so_ref'],
    touch: [],
    readOnly: true,
  }));

  app.use('/api/outbound_orders', authed, makeCrudRouter(db, 'outbound_orders', {
    pk: 'id',
    fields: ['id', 'company', 'order_no', 'order_date', 'dlv_date', 'cust_code', 'slm_id', 'doc_status', 'total'],
    readOnly: true,
  }));

  app.use('/api/outbound_lines', authed, makeCrudRouter(db, 'outbound_lines', {
    pk: 'id',
    fields: ['order_id', 'seq_num', 'sku', 'qty', 'unit_price', 'line_value'],
    touch: [],
    readOnly: true,
  }));

  app.use('/api/sales_line_components', authed, makeCrudRouter(db, 'sales_line_components', {
    pk: 'id',
    fields: ['company', 'order_id', 'order_no', 'seq_num', 'parent_sku', 'child_code', 'child_name', 'child_qty', 'note', 'updated_at'],
    touch: [],
    readOnly: true,
  }));

  // stock is written only by the DBF import job — read-only, per-warehouse rows.
  // FIXED (2026-08-03): this used to be a hand-rolled handler that only understood a bare `eq.`
  // prefix (stripped via regex) — any other operator (confirmed broken: `warehouse=in.(09,14,...)`,
  // used by tgm-wms's getReservedStock() for the Stock Summary "SO จอง" column) got bound as a
  // literal, useless string comparison and silently returned zero rows every time, with no error
  // anywhere in the chain. It also dropped ORDER BY direction (`.desc`/`.asc` suffix) and ignored
  // limit/offset entirely. Switched to the same makeCrudRouter+pgQuery machinery every other
  // read-only synced table already uses (stock_movements_daily et al, right below) — that machinery
  // already correctly implements eq/neq/gt/gte/lt/lte/in/is/not, direction-aware ORDER BY, and real
  // LIMIT/OFFSET. No composite-PK issue: the readOnly router never touches `pk` at all (GET only).
  app.use('/api/stock', authed, makeCrudRouter(db, 'stock', {
    pk: 'sku',
    fields: ['sku', 'warehouse', 'qty', 'unit', 'last_updated'],
    orderBy: 'sku',
    readOnly: true,
  }));

  // Daily stock movement ledger (Express's real STCRD.DBF stock-card log) — see db/schema.sql and
  // syncStockMovements() in importFromExpress.js for the category/sign mapping.
  app.use('/api/stock_movements_daily', authed, makeCrudRouter(db, 'stock_movements_daily', {
    pk: 'sku',
    fields: ['sku', 'warehouse', 'day', 'received_qty', 'sold_qty', 'converted_qty', 'transferred_qty', 'other_qty'],
    readOnly: true,
  }));

  // WMS's own stock-movement report (tgm-wms, a separate app) — same STCRD.DBF source as above,
  // re-categorized to their spec. Consumed cross-app over this same authed API (Bearer token from
  // a dedicated read-only service account) rather than mirrored into WMS's own database.
  app.use('/api/wms_stock_movements_daily', authed, makeCrudRouter(db, 'stock_movements_wms_daily', {
    pk: 'sku',
    fields: ['sku', 'day', 'received_qty', 'general_sale_qty', 'consi_qty', 'transfer_qty', 'converted_qty', 'reserved_qty', 'return_qty', 'writeoff_qty', 'received_value', 'dispatched_qty'],
    readOnly: true,
  }));


  // Invoice-level STCRD lines for tax-invoice fallback in tgm-wms route billing.
  app.use('/api/invoice_lines', authed, makeCrudRouter(db, 'invoice_lines', {
    pk: 'doc_num',
    fields: ['company', 'doc_num', 'seq_num', 'doc_date', 'sku', 'sku_name', 'warehouse', 'qty', 'unit_code', 'unit_factor', 'line_value', 'ref_num', 'updated_at'],
    readOnly: true,
  }));

  // Child SKU rows parsed from ARTRNRM for invoice 90022 parent lines.
  app.use('/api/invoice_line_components', authed, makeCrudRouter(db, 'invoice_line_components', {
    pk: 'id',
    fields: ['company', 'doc_num', 'seq_num', 'parent_sku', 'source_doc_num', 'source_seq_num', 'child_code', 'child_name', 'child_qty', 'note', 'updated_at'],
    touch: [],
    readOnly: true,
  }));

  // ── app-owned operational tables (written directly from the web UI, never synced to Express) ──
  app.use('/api/customer_profiles', authed, makeCrudRouter(db, 'customer_profiles', {
    pk: 'code',
    // gp_pct added 2026-09-16: ใบเคาะราคา's per-line GP% now defaults from here (customer master)
    // instead of being typed from scratch every time — see index.html's draftLineField().
    fields: ['code', 'name', 'corporate', 'category', 'branch', 'slm', 'edited_by', 'gp_pct',
      'corp_source', 'corp_confidence', 'corp_confirmed', 'corp_confirmed_by', 'corp_confirmed_at', 'updated_at'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/salesmen_profiles', authed, makeCrudRouter(db, 'salesmen_profiles', {
    pk: 'slm_id',
    fields: ['slm_id', 'display_name', 'nickname', 'phone', 'email', 'is_active', 'note', 'edited_by', 'updated_at'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/consi_bom_master', authed, makeCrudRouter(db, 'consi_bom_master', {
    pk: 'id',
    fields: ['parent_code', 'parent_name', 'child_code', 'child_name', 'child_unit', 'ratio', 'note',
      'is_confirmed', 'confirmed_by', 'confirmed_at', 'updated_at'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/ai/corporate-grouping', authed, requireRole(...MASTER_DATA_ROLES), require('./routes/aiGrouping')(db));

  // FIXED (2026-08-05, security review — reapplied same day after a revert): these 6 app-owned
  // operational tables had no `writeRoles` at all, so `authed` alone (any logged-in bearer token,
  // including the leaked read-only WMSAPI service account) could POST/PATCH/DELETE freely. GET
  // (read) is untouched by this — this does NOT affect anyone viewing stock/forecasts/etc., only
  // who can create/edit/delete them. Restricted writes to MASTER_DATA_ROLES, same convention already
  // used by customer_profiles/salesmen_profiles/consi_bom_master/sku_settings above.
  app.use('/api/forecasts', authed, makeCrudRouter(db, 'forecasts', {
    pk: 'id',
    idPrefix: 'FC',
    fields: ['id', 'created_by', 'slm_id', 'sku', 'cust_code', 'qty', 'deliv_date', 'note',
      'is_approved', 'approved_by', 'approved_at', 'edited_by'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/po_plans', authed, makeCrudRouter(db, 'po_plans', {
    pk: 'id',
    idPrefix: 'PO-',
    fields: ['id', 'sku', 'qty', 'deliv_date', 'customer', 'cust_code', 'branch', 'status',
      'so_ref', 'note', 'version', 'created_by', 'edited_by'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/reservations', authed, makeCrudRouter(db, 'reservations', {
    pk: 'id',
    idPrefix: 'RES',
    fields: ['id', 'sku', 'qty_requested', 'qty_approved', 'cust_code', 'cust_name', 'need_date',
      'status', 'requested_by', 'approved_by', 'approved_at', 'note', 'ref_forecast_id', 'ref_po_id'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/bookings', authed, makeCrudRouter(db, 'bookings', {
    pk: 'id',
    idPrefix: 'BK',
    fields: ['id', 'type', 'sku', 'sku_name', 'qty', 'cust_name', 'cust_code', 'receive_date',
      'stock_status', 'status', 'created_by', 'updated_by'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/prod_orders', authed, makeCrudRouter(db, 'prod_orders', {
    pk: 'id',
    idPrefix: 'PRD',
    fields: ['id', 'sku', 'sku_name', 'qty', 'plan_date', 'receive_date', 'line', 'status', 'edited_by', 'edited_at'],
    touch: [],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/sku_settings', authed, makeCrudRouter(db, 'sku_settings', {
    pk: 'sku',
    fields: ['sku', 'min_stock', 'shelf_life', 'moq', 'lead_time', 'note', 'updated_by', 'updated_at'],
    writeRoles: MASTER_DATA_ROLES,
  }));

  app.use('/api/stock_lots', authed, makeCrudRouter(db, 'stock_lots', {
    pk: 'id',
    fields: ['sku', 'warehouse', 'lot_no', 'qty', 'exp_date', 'in_date', 'note'],
    touch: [],
    writeRoles: MASTER_DATA_ROLES,
  }));

  // "รับเข้าจริง" ของหน้าเปรียบเทียบผลิต (2026-09) — เดิม local-only, ย้ายขึ้น server แล้ว
  app.use('/api/stock_in_actual', authed, makeCrudRouter(db, 'stock_in_actual', {
    pk: 'id',
    fields: ['date', 'sku', 'qty', 'note', 'imported_by'],
    touch: [],
    orderBy: 'date',
    writeRoles: MASTER_DATA_ROLES,
  }));

  // ของตัวอย่าง (2026-09) — เดิม local-only, ย้ายขึ้น server แล้ว
  app.use('/api/sample_requests', authed, makeCrudRouter(db, 'sample_requests', {
    pk: 'id',
    idPrefix: 'SR',
    fields: ['id', 'cust_code', 'cust_name', 'contact', 'phone', 'purpose', 'delivery_date', 'address', 'note',
      'items', 'test_result', 'status', 'by', 'by_name', 'date', 'ts',
      'approved_by', 'approved_at', 'rejected_by', 'rejected_at', 'reject_reason',
      'prep_by', 'prep_at', 'disp_by', 'disp_at', 'recv_by', 'recv_at', 'submitted_at', 'updated_by'],
    jsonFields: ['items', 'test_result'],
    orderBy: 'ts',
    writeRoles: SAMPLE_REQUEST_ROLES,
  }));

  // Workflow อนุมัติแบบ multi-level ใช้ร่วมกันหลาย entity (2026-09) — ดู db/schema.sql
  app.use('/api/approval_workflow_templates', authed, require('./middleware/validateWorkflow')(db), makeCrudRouter(db, 'approval_workflow_templates', {
    pk: 'entity_type',
    fields: ['entity_type', 'levels_json', 'updated_by'],
    jsonFields: ['levels_json'],
    writeRoles: APPROVAL_WORKFLOW_ROLES,
  }));

  // ข้อมูลลูกค้า (2026-09) — เดิม local-only, ย้ายขึ้น server แล้ว ไฟล์แนบจริงแยกไป custreg_attachments
  app.use('/api/custreg_subs', authed, makeCrudRouter(db, 'custreg_subs', {
    pk: 'id',
    idPrefix: 'CR',
    fields: ['id', 'doc_no', 'shop', 'sales', 'sales_uid', 'created_by_uid', 'owner_sales_uid', 'owner_sales_name',
      'request_type', 'existing_cust', 'drive_link', 'external_emails', 'tax_addr', 'tax_zip', 'phone', 'taxid',
      'crdays', 'price', 'date', 'note', 'final_note', 'levels_json', 'current_level', 'approvers_json',
      'status', 'custcode', 'ts'],
    jsonFields: ['levels_json', 'approvers_json'],
    orderBy: 'ts',
    writeRoles: CUSTREG_ROLES,
  }));
  app.use('/api/custreg_attachments', require('./routes/custregAttachments')(db, CUSTREG_ROLES));

  // FIXED (2026-08-05, security review): was writable via the public API by any authenticated user
  // (including a leaked read-only credential) — DELETE/PATCH here let anyone erase or forge their
  // own audit trail. Internal audit writes (auditLogin() in routes/auth.js, etc.) always go via a
  // direct db.prepare(INSERT) call, never through this router, so making the HTTP API read-only
  // doesn't break logging. GET (viewing the log) is unaffected.
  const auditLogRouter = makeCrudRouter(db, 'audit_log', {
    pk: 'id',
    fields: ['uid', 'role', 'action', 'target', 'detail', 'ip_addr'],
    jsonFields: ['detail'],
    touch: [],
    orderBy: 'ts DESC',
    readOnly: true,
  });
  // ADDED (2026-09) — the client's audit(action, target, detail) helper (index.html) has been calling
  // SB.audit() -> POST /api/audit_log this whole time, silently 404ing since the mount above never
  // registered a POST route (readOnly:true). Every audit(...) call anywhere in the app has therefore
  // been a no-op. Needed now for the promo-draft redesign's per-document "ประวัติการแก้ไข" trail — but
  // this must NOT just flip readOnly off, since the client's own payload carries a `uid` it thinks is
  // the actor (CURRENT_USER.uid) — trusting that would let anyone forge another user's entry in their
  // own audit trail. So this is a narrow, hand-written INSERT-only addition to the SAME router object,
  // deriving uid/role from the authenticated session (req.user, set by `authed` above) and ignoring
  // whatever the client body claims. Still no PATCH/DELETE — an audit trail must not be editable or
  // erasable by the user who wrote it.
  auditLogRouter.post('/', (req, res) => {
    const { action, target, detail } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action is required' });
    db.prepare('INSERT INTO audit_log (uid, role, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(
      req.user.uid, req.user.role || null,
      String(action), target != null ? String(target) : null, detail !== undefined ? JSON.stringify(detail) : null
    );
    res.status(201).json({ ok: true });
  });
  app.use('/api/audit_log', authed, auditLogRouter);

  // ── read-only SQL views (see db/schema.sql) — all 9 views index.html calls are now mounted, so the
  //    old try/catch "view unavailable, fall back to base table" paths in SB.getSalesHistory() etc.
  //    should no longer trigger in normal operation. ──
  app.use('/api/v_stock_planning', authed, makeCrudRouter(db, 'v_stock_planning', {
    pk: 'code',
    fields: ['code', 'name', 'group_name', 'lead_time', 'stock_qty', 'min_stock', 'effective_lt', 'avg3_monthly', 'days_remaining'],
    readOnly: true,
  }));

  app.use('/api/v_stock_by_warehouse', authed, makeCrudRouter(db, 'v_stock_by_warehouse', {
    pk: 'sku',
    fields: ['sku', 'sku_name', 'warehouse', 'warehouse_name', 'qty', 'unit', 'last_updated'],
    readOnly: true,
  }));

  app.use('/api/warehouses', authed, makeCrudRouter(db, 'warehouses', {
    pk: 'code',
    fields: ['code', 'name', 'description'],
    readOnly: true,
  }));

  app.use('/api/v_reservation_status', authed, makeCrudRouter(db, 'v_reservation_status', {
    pk: 'id',
    fields: ['id', 'sku', 'sku_name', 'qty_requested', 'qty_approved', 'cust_code', 'cust_name',
      'need_date', 'status', 'requested_by', 'approved_by', 'stock_available', 'stock_status', 'created_at'],
    readOnly: true,
  }));

  app.use('/api/v_sc_sales_customer_codes', authed, makeCrudRouter(db, 'v_sc_sales_customer_codes', {
    pk: 'cust_code',
    fields: ['cust_code'],
    readOnly: true,
  }));

  // Individual tax-invoice headers (added 2026-08-06) — see db/schema.sql's `invoices` table comment.
  // Powers tgm-wms's "จ่ายสินค้า by ใบกำกับภาษี" dispatch flow: filter by so_num=is.null to find
  // invoices with no linked SO (need manual-entry dispatch) vs so_num=not.is.null (link to the
  // existing SO-based pick flow instead). Read-only, same reasoning as /api/products above — this
  // mirrors Express every 5 minutes, a write here would just be reverted by the next sync cycle.
  app.use('/api/invoices', authed, makeCrudRouter(db, 'invoices', {
    pk: 'doc_num',
    // route_code/route_name added 2026-09-16 for tgm-wms's "สายรถ" delivery-route billing feature —
    // see importFromExpress.js's ROUTE_TABTYP comment for where these come from.
    fields: ['doc_num', 'doc_date', 'cust_code', 'slm_code', 'so_num', 'total', 'rectyp', 'route_code', 'route_name', 'ship_to_code', 'ship_to_address', 'updated_at'],
    orderBy: 'doc_date',
    readOnly: true,
  }));

  app.use('/api/promo_docs', authed, makeCrudRouter(db, 'promo_docs', {
    pk: 'sonum',
    fields: ['company', 'sonum', 'seqnum', 'cust_code', 'cust_name', 'sku', 'sku_name', 'unit_price', 'start_date', 'due_date', 'docstat', 'create_date', 'doc_ref', 'updated_at'],
    orderBy: 'start_date',
    readOnly: true,
  }));

  // "ใบเคาะราคา" v2 (2026-09-11) — header/lines split (ดู server/db/schema.sql's comment บน
  // promo_draft_headers สำหรับเหตุผลเต็ม) แทนที่ promo_drafts เดี่ยวๆ เดิม 3 mount:
  //   promo_draft_headers — เอกสารระดับหัว (doc_no/routing state/checkbox พิเศษ/ค่าใช้จ่ายอื่นๆ) — เขียน
  //     เอง (ไม่ใช่ makeCrudRouter) เพราะต้องออก doc_no แบบอะตอมมิก + derive created_by จาก session เท่านั้น
  //   promo_drafts — เหลือแค่ฟิลด์ราย SKU/สาขา (บรรทัดสินค้า) อ้าง draft_no กลับไปที่ header
  //   promo_draft_attachments — ไฟล์แนบ (BLOB, คัดลอกโครง custreg_attachments)
  app.use('/api/promo_draft_headers', require('./routes/promoDraftHeaders')(db, PROMO_DRAFT_ROLES));
  app.use('/api/promo_draft_attachments', require('./routes/promoDraftAttachments')(db, PROMO_DRAFT_ROLES));

  // Comment ต่อแถวสินค้า (ต่อ SKU ต่อเอกสาร, 2026-09-11) — mount แบบเดียวกับ audit_log (readOnly:true
  // จาก makeCrudRouter แล้วต่อ POST เองทีหลัง): uid ต้อง derive จาก session เท่านั้น ห้ามเชื่อค่าที่ client
  // ส่งมา (คนละเหตุผลกับ draft_no/doc_no ของ header ข้างบน แต่หลักการเดียวกัน — กัน forge ตัวตนผู้เขียน
  // comment) ไม่มี PATCH/DELETE เหมือน audit_log (comment ที่เขียนแล้วไม่ควรแก้/ลบทีหลัง)
  const promoDraftLineCommentsRouter = makeCrudRouter(db, 'promo_draft_line_comments', {
    pk: 'id',
    fields: ['draft_no', 'sku', 'anchor', 'uid', 'text'],
    touch: [],
    orderBy: 'created_at',
    readOnly: true,
  });
  // FIXED (2026-09-13, /code-review): this POST had no requireRole check at all — any authenticated
  // user of any role, including one with no access to promo drafts whatsoever, could write a comment
  // onto any draft_no/sku. Every sibling promo-draft mount (headers/attachments/lines) already gates
  // writes to PROMO_DRAFT_ROLES; this one must too.
  // (2026-09-24) นอกจาก role ฝ่ายขาย ผู้จัดทำและผู้อนุมัติทุกขั้นของเอกสารนั้นคอมเมนต์ได้ด้วย (ผู้อนุมัติต่างแผนก)
  // รับได้ทั้งคอมเมนต์รายบรรทัด (sku) และคอมเมนต์ลอยปักตำแหน่ง (anchor)
  const isDraftParticipant = (draftNo, uid) => {
    const h = db.prepare('SELECT created_by, levels_json, approval_history_json FROM promo_draft_headers WHERE draft_no = ?').get(draftNo);
    if (!h) return false;
    if (h.created_by === uid) return true;
    const levels = [h.levels_json, h.approval_history_json].flatMap(v => { try { return JSON.parse(v || '[]'); } catch { return []; } });
    return levels.some(lv => (lv.approvers || []).some(a => a.uid === uid));
  };
  promoDraftLineCommentsRouter.post('/', (req, res) => {
    const { draft_no, sku, anchor, text } = req.body || {};
    if (!draft_no || (!sku && !anchor) || !String(text || '').trim()) return res.status(400).json({ error: 'draft_no, sku หรือ anchor และ text จำเป็น' });
    if (!PROMO_DRAFT_ROLES.includes(req.user.role) && !isDraftParticipant(String(draft_no), req.user.uid)) return res.status(403).json({ error: 'ไม่มีสิทธิ์คอมเมนต์เอกสารนี้' });
    const info = db.prepare('INSERT INTO promo_draft_line_comments (draft_no, sku, anchor, uid, text) VALUES (?, ?, ?, ?, ?)')
      .run(String(draft_no), anchor ? '' : String(sku), anchor ? String(anchor).slice(0, 300) : null, req.user.uid, String(text).slice(0, 2000));
    const saved = db.prepare('SELECT * FROM promo_draft_line_comments WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(saved);
  });
  app.use('/api/promo_draft_line_comments', authed, promoDraftLineCommentsRouter);

  // ลายเซ็นประจำตัว (2026-09-23, แบบ e-memo) — อ่านได้ทุกคนที่ login (ใช้แสดงในเอกสาร), เขียน/ลบได้เฉพาะ
  // ของตัวเอง (uid มาจาก session เสมอ ไม่เชื่อค่าจาก client) รับเฉพาะ PNG/JPEG data URL ไม่เกิน 300KB
  const SIGNATURE_MAX_CHARS = 300 * 1024;
  const signaturesRouter = express.Router();
  signaturesRouter.get('/', (req, res) => {
    const uids = String(req.query.uids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!uids.length) return res.json([]);
    const rows = db.prepare(`SELECT uid, image, updated_at FROM user_signatures WHERE uid IN (${uids.map(() => '?').join(',')})`).all(...uids);
    res.json(rows);
  });
  signaturesRouter.put('/me', (req, res) => {
    const image = String(req.body?.image || '');
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image)) return res.status(400).json({ error: 'ลายเซ็นต้องเป็นรูป PNG/JPEG' });
    if (image.length > SIGNATURE_MAX_CHARS) return res.status(400).json({ error: 'รูปลายเซ็นใหญ่เกินไป' });
    db.prepare(`INSERT INTO user_signatures (uid, image, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(uid) DO UPDATE SET image = excluded.image, updated_at = excluded.updated_at`).run(req.user.uid, image);
    res.json(db.prepare('SELECT uid, image, updated_at FROM user_signatures WHERE uid = ?').get(req.user.uid));
  });
  signaturesRouter.delete('/me', (req, res) => {
    db.prepare('DELETE FROM user_signatures WHERE uid = ?').run(req.user.uid);
    res.status(204).end();
  });
  app.use('/api/user_signatures', authed, signaturesRouter);
  // อนุมัติใบเคาะราคาผ่านลิงก์ในอีเมล — ไม่ต้อง login (ใช้ token ส่วนตัว) ดู routes/promoEmailApprove.js
  app.use('/api/promo_approve', require('./routes/promoEmailApprove')(db));

  app.use('/api/promo_drafts', authed, makeCrudRouter(db, 'promo_drafts', {
    pk: 'id',
    idPrefix: 'PMD',
    // weight/gp_pct_promo/cost_price_promo added 2026-09-16 — the "ราคาปกติ"/"ราคาโปรโมชั่น" columns
    // each got their own 3-part breakdown (ราคาขาย/GP%/ราคาทุนสุทธิ); gp_pct/cost_price now specifically
    // mean the ราคาปกติ side, these two new columns are the same breakdown for ราคาโปร (unit_price).
    // is_sub_item added 2026-09-16 (ข้อ 4.4) — flag ว่าบรรทัดนี้เป็นรายการย่อย (1.1/1.2) ใต้บรรทัดรหัส 9 ก่อนหน้า
    fields: ['id', 'draft_no', 'corporate', 'cust_code', 'cust_name', 'sku', 'sku_name', 'equipment_set', 'weight',
      'normal_price', 'unit_price', 'discount_pct', 'gp_pct', 'cost_price', 'gp_pct_promo', 'cost_price_promo',
      'estimated_qty', 'start_date', 'due_date', 'is_sub_item', 'bill_disc_pct', 'bill_disc_pct_promo', 'compensate'],
    orderBy: 'created_at',
    writeRoles: PROMO_DRAFT_ROLES,
  }));

  app.use('/api/v_sc_dashboard_sales_monthly', authed, makeCrudRouter(db, 'v_sc_dashboard_sales_monthly', {
    pk: 'prod_code',
    fields: ['ym', 'company', 'prod_code', 'prod_name', 'prod_group', 'qty', 'amount', 'invoice_count'],
    readOnly: true,
  }));

  app.use('/api/v_sales_history_company', authed, makeCrudRouter(db, 'v_sales_history_company', {
    pk: 'sku',
    fields: ['slm_id', 'sku', 'ym', 'qty', 'amount', 'company', 'product_name', 'group_name', 'plant'],
    readOnly: true,
  }));

  // Real invoiced revenue (Express's AR ledger, ARTRN.DBF) — see db/schema.sql's invoice_sales_monthly
  // comment. No SKU/product dimension exists on this table, only company+month+customer.
  app.use('/api/invoice_sales_monthly', authed, makeCrudRouter(db, 'invoice_sales_monthly', {
    pk: 'cust_code',
    fields: ['company', 'ym', 'cust_code', 'slm_code', 'amount', 'invoice_count'],
    readOnly: true,
  }));

  app.get('/api/dashboard_sales_summary', authed, (req, res) => {
    const startYm = String(req.query.startYm || '').slice(0, 7);
    const endYm = String(req.query.endYm || '').slice(0, 7);
    const slmId = String(req.query.slmId || '').trim();
    if (!/^\d{4}-\d{2}$/.test(startYm) || !/^\d{4}-\d{2}$/.test(endYm)) {
      return res.status(400).json({ error: 'startYm and endYm are required in YYYY-MM format' });
    }

    // Keep this endpoint cheap enough for the Dashboard's first screen. The previous implementation
    // selected every monthly customer/product row into Node and then reduced it in JavaScript. On the
    // live DB that meant hundreds of thousands of rows per page-open and could block the single SQLite
    // connection long enough for the browser to show "page unresponsive". Aggregate in SQLite instead;
    // only the final company totals and Top 10 lists cross the process boundary. Archive branch tables
    // are intentionally excluded here; this Dashboard endpoint is for the current operating year.
    const where = ['ym >= ?', 'ym <= ?'];
    const params = [startYm, endYm];
    if (slmId) {
      // ผู้ใช้หนึ่งคนผูกได้หลายรหัส Express (sc_users.slm_codes) — client ส่งมาเป็น "101,110-1"
      const codes = [...new Set(slmId.split(',').map(s => s.trim()).filter(Boolean))];
      where.push(`slm_owner IN (${codes.map(() => '?').join(',')})`);
      params.push(...codes);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const archiveListSql = `'TSS-67','TSS-68','TSSN-67','TSSN-68','CONSI-67'`;
    const canonicalCompanySql = `
      CASE
        WHEN UPPER(TRIM(company)) IN ('TSS-67','TSS-68') THEN 'TSS'
        WHEN UPPER(TRIM(company)) IN ('TSSN-67','TSSN-68') THEN 'TSSNV'
        WHEN UPPER(TRIM(company)) = 'CONSI-67' THEN 'CONSI'
        WHEN UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) LIKE 'TGM%' THEN 'TGM'
        WHEN UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) LIKE 'CONSI%' THEN 'CONSI'
        WHEN UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) IN ('TSSNV')
          OR UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) LIKE 'TSSN%'
          OR UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) LIKE '%NV%' THEN 'TSSNV'
        WHEN UPPER(REPLACE(REPLACE(TRIM(company),'-',''),'_','')) LIKE 'TSS%' THEN 'TSS'
        ELSE COALESCE(NULLIF(UPPER(TRIM(company)),''),'TSS')
      END
    `;
    const baseCte = `
      WITH src AS (
        SELECT *, UPPER(TRIM(company)) AS raw_company, ${canonicalCompanySql} AS company_key
        FROM v_sales_overview_sales_monthly
        ${whereSql}
      ), filtered AS (
        SELECT *
        FROM src
        WHERE raw_company NOT IN (${archiveListSql})
      )
    `;
    const companyRows = db.prepare(`
      ${baseCte}
      SELECT company_key AS company,
             SUM(COALESCE(qty,0)) AS qty,
             SUM(COALESCE(amount,0)) AS amount,
             SUM(COALESCE(invoice_count,0)) AS invoice_count,
             COUNT(*) AS count
      FROM filtered
      GROUP BY company_key
    `).all(...params);
    const topProducts = db.prepare(`
      ${baseCte}
      SELECT prod_code,
             COALESCE(MAX(NULLIF(prod_name,'')), prod_code) AS prod_name,
             SUM(COALESCE(qty,0)) AS qty,
             SUM(COALESCE(amount,0)) AS amount
      FROM filtered
      WHERE COALESCE(prod_code,'') <> ''
      GROUP BY prod_code
      HAVING amount <> 0 OR qty <> 0
      ORDER BY amount DESC, qty DESC
      LIMIT 10
    `).all(...params);
    const topCustomers = db.prepare(`
      ${baseCte}
      SELECT COALESCE(NULLIF(corporate,''), NULLIF(cust_name,''), NULLIF(cust_code,''), 'ไม่ระบุ') AS name,
             COUNT(DISTINCT NULLIF(cust_code,'')) AS branches,
             SUM(COALESCE(qty,0)) AS qty,
             SUM(COALESCE(amount,0)) AS amount
      FROM filtered
      GROUP BY name
      HAVING amount <> 0 OR qty <> 0
      ORDER BY amount DESC, qty DESC
      LIMIT 10
    `).all(...params);
    const companySales = {};
    for (const r of companyRows) {
      const company = normalizeCompanyScope(r.company);
      companySales[company] = {
        qty: Number(r.qty) || 0,
        amount: Number(r.amount) || 0,
        invoices: Number(r.invoice_count) || 0,
        count: Number(r.count) || 0,
      };
    }
    res.json({
      startYm,
      endYm,
      deduped: true,
      companySales,
      totalAmount: companyRows.reduce((a, r) => a + (Number(r.amount) || 0), 0),
      totalQty: companyRows.reduce((a, r) => a + (Number(r.qty) || 0), 0),
      topProducts: topProducts.map((r) => ({
        code: r.prod_code,
        name: r.prod_name || r.prod_code,
        qty: Number(r.qty) || 0,
        amount: Number(r.amount) || 0,
      })),
      topCustomers: topCustomers.map((r) => ({
        name: r.name || 'ไม่ระบุ',
        branches: Number(r.branches) || 0,
        qty: Number(r.qty) || 0,
        amount: Number(r.amount) || 0,
      })),
    });
  });

  app.use('/api/v_sales_overview_sales_monthly', authed, makeCrudRouter(db, 'v_sales_overview_sales_monthly', {
    pk: 'prod_code',
    fields: ['ym', 'company', 'slm_owner', 'category', 'corporate', 'cust_code', 'cust_name',
      'prod_group', 'prod_code', 'prod_name', 'qty', 'amount', 'invoice_count'],
    readOnly: true,
  }));

  app.use('/api/v_sc_consi_monthly', authed, makeCrudRouter(db, 'v_sc_consi_monthly', {
    pk: 'prod_code',
    fields: ['ym', 'company', 'slm_owner', 'category', 'corporate', 'cust_code', 'cust_name',
      'prod_group', 'prod_code', 'prod_name', 'qty', 'amount', 'invoice_count'],
    readOnly: true,
  }));

  app.use('/api/v_sc_data_confidence', authed, makeCrudRouter(db, 'v_sc_data_confidence', {
    pk: 'so_count',
    fields: ['so_count', 'line_count', 'active_booking_count', 'orders_without_line',
      'active_product_count', 'orphan_sku_sales_count', 'orphan_sku_consi_count', 'orphan_sku_stock_count', 'synced_at'],
    readOnly: true,
  }));

  app.use('/api/v_sc_import_health_by_company', authed, makeCrudRouter(db, 'v_sc_import_health_by_company', {
    pk: 'company',
    fields: ['company', 'order_count', 'tx_count', 'distinct_sku_count', 'orphan_sku_count', 'min_order_date', 'max_order_date'],
    readOnly: true,
  }));

  app.use('/api/v_sc_booking_summary_by_sku', authed, makeCrudRouter(db, 'v_sc_booking_summary_by_sku', {
    pk: 'sku',
    fields: ['sku', 'sku_name', 'booking_count', 'total_qty', 'po_qty', 'so_qty', 'produce_qty',
      'latest_receive_date', 'stock_qty', 'latest_created_at'],
    readOnly: true,
  }));

  // FIXED (2026-08-05, security review): `console.error(err)` on a raw Error object prints every
  // own enumerable property via util.inspect, not just message/stack — body-parser attaches a `.body`
  // property (the raw request body text) to the SyntaxError it throws on malformed JSON, so a
  // request like `{uid:SADM,password:...}` (unquoted keys — invalid JSON) got its literal
  // uid/password logged in plaintext to service-stderr-*.log every time. Log only message+stack now.
  // Purely a logging change — no effect on any response, read or write.
  app.use((err, req, res, next) => {
    console.error(err && err.stack ? err.stack : (err && err.message) || String(err));
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { buildApp };
