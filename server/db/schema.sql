-- ============================================================
-- TGM SUPPLYCHAIN — SQLite schema (replaces Supabase/Postgres)
-- Ported from Scripts/step1_schema.sql + fields observed live in index.html's SB object.
-- Differences from the Postgres version:
--   * jsonb -> TEXT (JSON string)
--   * gen_random_uuid()/triggers for updated_at -> handled in app code (lib/crud.js)
--   * no RLS / no "alter publication ... realtime" (not applicable to SQLite)
--   * stock is now keyed by (sku, warehouse) instead of just (sku) — TSS DBF export has one
--     stock row per SKU per warehouse and the web app needs to show it broken out that way
-- ============================================================

PRAGMA foreign_keys = ON;

-- ── MASTER DATA (mirrored from Express DBF every 5 min — do not edit via app UI) ──

CREATE TABLE IF NOT EXISTS products (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  group_name  TEXT,
  unit        TEXT NOT NULL DEFAULT 'กิโลกรัม', -- full Thai unit name, resolved from STMAS.QUCOD via ISTAB.DBF TABTYP='20' (see loadUnitNameMap() in jobs/importFromExpress.js) — was the raw short code (e.g. "แพ") until 2026-08-26
  lead_time   INTEGER NOT NULL DEFAULT 7,
  moq         INTEGER NOT NULL DEFAULT 0,
  min_stock   INTEGER NOT NULL DEFAULT 50,
  shelf_life  INTEGER NOT NULL DEFAULT 30,
  plant       TEXT NOT NULL DEFAULT 'TGM1',
  is_active   INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  standard_price REAL,
  price_company TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_products_group  ON products(group_name);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);

CREATE TABLE IF NOT EXISTS customers (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cust_group  TEXT,
  slm_id      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_slm   ON customers(slm_id);
CREATE INDEX IF NOT EXISTS idx_customers_group ON customers(cust_group);

-- extra per-customer metadata edited from the web app (corporate/category/slm overrides)
CREATE TABLE IF NOT EXISTS customer_profiles (
  code             TEXT PRIMARY KEY REFERENCES customers(code),
  name             TEXT,
  corporate        TEXT,
  category         TEXT,
  branch           TEXT,
  slm              TEXT,
  edited_by        TEXT,
  -- AI-assisted corporate grouping confirm workflow (server/routes/aiGrouping.js): corp_source/
  -- corp_confidence are only set when corp_source='ai'; corp_confirmed defaults to 1 so every
  -- existing/future manual edit is trusted automatically, and only AI-proposed rows start at 0
  -- ("needs human review") until someone edits or explicitly confirms them in the UI.
  corp_source      TEXT NOT NULL DEFAULT 'manual',
  corp_confidence  REAL,
  corp_confirmed   INTEGER NOT NULL DEFAULT 1,
  corp_confirmed_by TEXT,
  corp_confirmed_at TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- machines with an already-provisioned tgm.db get these same columns via server/db/migrations.js
-- (CREATE TABLE IF NOT EXISTS above is a no-op once the table exists at all, columns or not).

-- No FK to products(code): same reasoning as `stock` above — sourced from DBF, not app-entered.
CREATE TABLE IF NOT EXISTS sales_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slm_id      TEXT NOT NULL,
  sku         TEXT NOT NULL,
  ym          TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(slm_id, sku, ym)
);
CREATE INDEX IF NOT EXISTS idx_sales_hist_slm ON sales_history(slm_id);
CREATE INDEX IF NOT EXISTS idx_sales_hist_sku ON sales_history(sku);
CREATE INDEX IF NOT EXISTS idx_sales_hist_ym  ON sales_history(ym);

-- raw per-line sales rows, one per outbound_lines row, flattened for easy filtering/rollup.
-- source: Express OESO.DBF + OESOIT.DBF (SO header + line items) across all 7 company books.
CREATE TABLE IF NOT EXISTS sales_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company     TEXT NOT NULL,
  tx_date     TEXT,
  sku         TEXT,
  cust_code   TEXT,
  slm_id      TEXT,
  qty         REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  so_ref      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_tx_cust ON sales_transactions(cust_code);
CREATE INDEX IF NOT EXISTS idx_sales_tx_sku  ON sales_transactions(sku);
CREATE INDEX IF NOT EXISTS idx_sales_tx_date ON sales_transactions(tx_date);
-- v_sc_data_confidence's orphan_sku_consi_count filters company='CONSI' then correlates on sku;
-- without this, SQLite picks idx_sales_tx_sku (sku-ordered, not covering company) and pays a
-- table lookup for every one of ~1.4M rows just to test the company column — measured 4.9s on
-- this table's real size vs ~250ms for the equivalent unfiltered orphan_sku_sales_count query.
-- This composite index lets it seek straight to the ~190k CONSI rows instead.
CREATE INDEX IF NOT EXISTS idx_sales_tx_company_sku ON sales_transactions(company, sku);

-- salesperson master, mirrored from Express OESLM.DBF (name lookup for slm_id)
CREATE TABLE IF NOT EXISTS salesmen (
  slm_id      TEXT PRIMARY KEY,
  name        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- app-owned overlay for salesmen, same purpose as customer_profiles/sku_settings: salesmen.name is
-- DBF-owned and gets overwritten every 5-minute sync, so any human-entered cleanup/contact info lives
-- here instead, keyed 1:1 on slm_id.
CREATE TABLE IF NOT EXISTS salesmen_profiles (
  slm_id       TEXT PRIMARY KEY REFERENCES salesmen(slm_id),
  display_name TEXT,
  nickname     TEXT,
  phone        TEXT,
  email        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  edited_by    TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- warehouse code -> name lookup, mirrored from Express TSS/ISTAB.DBF WHERE TABTYP='21'
-- (codes 03-06 are consignment-partner locations — Villa/Tops/Lotus/Makro — not a gap, see
-- syncStock()'s comment in importFromExpress.js for why CONSI's own STLOC.DBF is unused)
CREATE TABLE IF NOT EXISTS warehouses (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- stock: one row per SKU PER WAREHOUSE, sourced from Z:\ExpressI\TSS (STLOC.DBF).
-- No FK to products(code) on purpose: STLOC can reference stock codes that our products
-- import filters out (Express's STMAS mixes real SKUs with GL/expense clearing codes) —
-- a strict FK here would make the whole 5-minute sync fail whenever that happens.
CREATE TABLE IF NOT EXISTS stock (
  sku          TEXT NOT NULL,
  warehouse    TEXT NOT NULL,
  qty          REAL NOT NULL DEFAULT 0,
  unit         TEXT NOT NULL DEFAULT 'กก.',
  last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (sku, warehouse)
);

CREATE TABLE IF NOT EXISTS stock_lots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT NOT NULL,
  warehouse   TEXT,
  lot_no      TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  exp_date    TEXT,
  in_date     TEXT NOT NULL DEFAULT (date('now')),
  note        TEXT,
  standard_price REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(sku, warehouse, lot_no)
);
CREATE INDEX IF NOT EXISTS idx_stock_lots_sku ON stock_lots(sku);
CREATE INDEX IF NOT EXISTS idx_stock_lots_exp ON stock_lots(exp_date);

-- Daily stock movement ledger, built from Express's real stock-card transaction log (STCRD.DBF,
-- TSS only — same scope as `stock`) — NOT a snapshot table like `stock`, this is per-day activity.
-- Document-number prefix -> category was confirmed directly by the user 2026-07-22 (see
-- importFromExpress.js's STCRD_CATEGORY map for the exact prefix list); `other_qty` is a deliberate
-- catch-all for every prefix not in one of the 4 named categories (credit notes, waste, samples,
-- stock-take adjustments, production adjustments, internal requisitions) so received+sold+converted+
-- transferred+other always reconciles exactly to the real day-over-day change — nothing is silently
-- dropped into the wrong bucket just because its exact meaning wasn't confirmed.
CREATE TABLE IF NOT EXISTS stock_movements_daily (
  sku              TEXT NOT NULL,
  warehouse        TEXT NOT NULL,
  day              TEXT NOT NULL,
  received_qty     REAL NOT NULL DEFAULT 0,
  sold_qty         REAL NOT NULL DEFAULT 0,
  converted_qty    REAL NOT NULL DEFAULT 0,
  transferred_qty  REAL NOT NULL DEFAULT 0,
  other_qty        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (sku, warehouse, day)
);
CREATE INDEX IF NOT EXISTS idx_stock_mov_day ON stock_movements_daily(day);
CREATE INDEX IF NOT EXISTS idx_stock_mov_sku ON stock_movements_daily(sku);

-- Same STCRD.DBF source as stock_movements_daily above, but re-categorized to the WMS team's own
-- report spec (confirmed with the user 2026-07-24/27) — one row per sku/day (not per warehouse,
-- since the category itself already encodes the destination warehouse for transfer-type docs):
--   received_qty: DOCNUM prefix RH/RS/CP only (narrower than stock_movements_daily's "received")
--   general_sale_qty: DOCNUM prefix IV/AB/BE/DA/AK/AY/DD/DM/GP/DB/IT/IE/BM/FB/ON/INV/BA/CJ/IC/DV/DL/OL/KB
--   converted_qty: FF (TRNQTY already signed, same as stock_movements_daily)
--   consi_qty / transfer_qty / reserved_qty: the same transfer-type prefixes as stock_movements_daily
--     (RL/VL/TP/MK/TG/LT/GR), but only the DESTINATION-side row (warehouse != '01') is recorded, bucketed
--     by that destination warehouse: 03/04/05 -> consi, 09 -> reserved, anything else -> transfer.
--     The source-side row (warehouse = '01') is intentionally not recorded here — its magnitude is
--     already captured by the destination side, and the report treats all 3 as reductions from the
--     main warehouse's balance (see the "คงเหลือ" formula in the WMS report page).
--   return_qty: DOCNUM prefix PM — customer product returns ("การรับคืนสินค้า"), added 2026-08-17.
--   writeoff_qty: DOCNUM prefix XX — waste/spoilage/tasting write-offs ("การตัดสูญเสีย"), already
--     negative (TRNQTY subtracted, same convention as general_sale_qty), added 2026-08-17.
--   received_value: TRNVAL summed from RH/RS prefixes ONLY (narrower than received_qty's RH/RS/CP —
--     CP is a one-off receiving-discrepancy dedup correction, not a real purchase) — purchase-cost
--     basis for tgm-wms's conversion-BOM feature; average cost per unit for a period = SUM(received_value)
--     / SUM(received_qty) over that period's rows, added 2026-08-18.
--   See importFromExpress.js's WMS_*_PREFIXES/RH_RS_PREFIXES constants for the full, current
--   prefix-to-bucket list — this comment is a summary, not the source of truth.
CREATE TABLE IF NOT EXISTS stock_movements_wms_daily (
  sku               TEXT NOT NULL,
  day               TEXT NOT NULL,
  received_qty      REAL NOT NULL DEFAULT 0,
  general_sale_qty  REAL NOT NULL DEFAULT 0,
  consi_qty         REAL NOT NULL DEFAULT 0,
  transfer_qty      REAL NOT NULL DEFAULT 0,
  converted_qty     REAL NOT NULL DEFAULT 0,
  reserved_qty      REAL NOT NULL DEFAULT 0,
  return_qty        REAL NOT NULL DEFAULT 0,
  writeoff_qty      REAL NOT NULL DEFAULT 0,
  received_value    REAL NOT NULL DEFAULT 0,
  -- dispatched_qty: VL/LT/TP prefixes ONLY (destination side, any warehouse != 01) — ADDED 2026-08-19,
  -- separate from consi_qty/transfer_qty above (which stay unchanged for every other consumer) because
  -- these documents represent real deliveries to many different branch destinations, not just the
  -- WMS_CONSI_WAREHOUSES (03/04/05) pool — used only by tgm-wms's StockCountSummaryPage "Express" column
  -- comparison, confirmed by the user to apply "เฉพาะในหน้านี้" (only that one page), not company-wide "net".
  dispatched_qty    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (sku, day)
);
CREATE INDEX IF NOT EXISTS idx_stock_mov_wms_day ON stock_movements_wms_daily(day);


-- Invoice-level item lines from Express STCRD.DBF. Used by tgm-wms route billing as a fallback
-- when ARTRN invoice rows have no linked SO number, so bill weight can still be calculated from
-- the tax-invoice/stock-card document itself.
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

-- Child SKU rows parsed from Express ARTRNRM.DBF notes for invoice lines.
-- This covers invoice documents directly and invoices whose STCRD.RDOCNUM / ARTRN.SONUM points back
-- to an SO line carrying 90022 child-item notes. Used by tgm-wms and tss-supplychain for exact
-- route-billing weight and item detail on 90022 parent rows.
CREATE TABLE IF NOT EXISTS invoice_line_components (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company        TEXT NOT NULL,
  doc_num        TEXT NOT NULL,
  seq_num        TEXT NOT NULL,
  parent_sku     TEXT,
  source_doc_num TEXT,
  source_seq_num TEXT,
  child_code     TEXT NOT NULL,
  child_name     TEXT,
  child_qty      REAL NOT NULL DEFAULT 0,
  note           TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(company, doc_num, seq_num, source_doc_num, source_seq_num, child_code, note)
);
CREATE INDEX IF NOT EXISTS idx_invoice_line_components_doc ON invoice_line_components(doc_num);
CREATE INDEX IF NOT EXISTS idx_invoice_line_components_parent ON invoice_line_components(parent_sku);
CREATE INDEX IF NOT EXISTS idx_invoice_line_components_child ON invoice_line_components(child_code);


-- SO / outbound orders mirrored from Express OESO.DBF (id = "<company>:<SONUM>" since SONUM is
-- only unique within one company's own numbering sequence, and sales are pulled from 7 companies)
CREATE TABLE IF NOT EXISTS outbound_orders (
  id          TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  order_no    TEXT NOT NULL,
  order_date  TEXT,
  dlv_date    TEXT, -- OESO.DBF's DLVDAT (delivery/receiving date) — distinct from order_date (SODAT, when the
                     -- order was placed). Added 2026-08-27: tgm-wms's "SO ล่วงหน้า" needs to bucket/filter by
                     -- when the customer expects delivery, not when the order was created. See importFromExpress.js's
                     -- syncSales() for the sync side and syncPromoDocs()'s comment confirming header DLVDAT is
                     -- always populated/reliable.
  cust_code   TEXT,
  slm_id      TEXT,
  doc_status  TEXT,
  total       REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outbound_orders_no ON outbound_orders(order_no);
CREATE INDEX IF NOT EXISTS idx_outbound_orders_date ON outbound_orders(order_date);

CREATE TABLE IF NOT EXISTS outbound_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL REFERENCES outbound_orders(id),
  -- Express OESOIT.SEQNUM, kept so line-level ARTRNRM notes can be joined back to the exact SO line.
  seq_num     TEXT,
  sku         TEXT,
  qty         REAL NOT NULL DEFAULT 0,
  unit_price  REAL,
  line_value  REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_outbound_lines_order ON outbound_lines(order_id);

-- Line-level component rows parsed from Express ARTRNRM.DBF notes under SO lines.
-- Confirmed 2026-09-17 for CONSI/TSS route-billing weight: 90022 parent lines carry child SKU notes
-- per SO line (DOCNUM=SONUM, SEQNUM=line seq), e.g. SE6911630 seq 1 -> 10140-134 20p + 10002-62 10p.
-- These are document-line facts, not a permanent BOM: the child mix can differ per order/customer.
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

-- ── USERS / AUTH (owned by this app, never touches Express) ──

CREATE TABLE IF NOT EXISTS sc_users (
  uid         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  department  TEXT,
  position    TEXT,
  slm_id      TEXT,
  email       TEXT,
  pwd_hash    TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES sc_users(uid),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);

-- ลืมรหัสผ่านผ่านอีเมล (2026-09-15, แบบเดียวกับ E-Memo) — token สุ่ม 1 ครั้งใช้ได้ครั้งเดียว, อายุ 1 ชม.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token       TEXT PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES sc_users(uid),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_uid ON password_reset_tokens(uid);

-- ── OPERATIONAL TABLES (owned by this app — written from the web UI, never synced back to Express) ──

CREATE TABLE IF NOT EXISTS forecasts (
  id          TEXT PRIMARY KEY,
  created_by  TEXT NOT NULL,
  slm_id      TEXT,
  sku         TEXT NOT NULL REFERENCES products(code),
  cust_code   TEXT REFERENCES customers(code),
  qty         REAL NOT NULL CHECK (qty > 0),
  deliv_date  TEXT,
  note        TEXT,
  is_approved INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  edited_by   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_forecasts_slm      ON forecasts(slm_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_sku      ON forecasts(sku);
CREATE INDEX IF NOT EXISTS idx_forecasts_date     ON forecasts(deliv_date);
CREATE INDEX IF NOT EXISTS idx_forecasts_approved ON forecasts(is_approved);

CREATE TABLE IF NOT EXISTS po_plans (
  id          TEXT PRIMARY KEY,
  sku         TEXT NOT NULL REFERENCES products(code),
  qty         REAL NOT NULL CHECK (qty > 0),
  deliv_date  TEXT,
  customer    TEXT,
  cust_code   TEXT,
  branch      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status in ('pending','matched','overdue','cancelled')),
  so_ref      TEXT,
  note        TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  edited_by   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_po_plans_sku    ON po_plans(sku);
CREATE INDEX IF NOT EXISTS idx_po_plans_status ON po_plans(status);
CREATE INDEX IF NOT EXISTS idx_po_plans_date   ON po_plans(deliv_date);

CREATE TABLE IF NOT EXISTS reservations (
  id              TEXT PRIMARY KEY,
  sku             TEXT NOT NULL REFERENCES products(code),
  qty_requested   REAL NOT NULL CHECK (qty_requested > 0),
  qty_approved    REAL,
  cust_code       TEXT,
  cust_name       TEXT,
  need_date       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status in ('pending','approved','partial','fulfilled','cancelled')),
  requested_by    TEXT NOT NULL,
  approved_by     TEXT,
  approved_at     TEXT,
  note            TEXT,
  ref_forecast_id TEXT,
  ref_po_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_sku    ON reservations(sku);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_by     ON reservations(requested_by);

CREATE TABLE IF NOT EXISTS bookings (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL DEFAULT 'SO',
  sku           TEXT NOT NULL REFERENCES products(code),
  sku_name      TEXT,
  qty           REAL NOT NULL,
  cust_name     TEXT,
  cust_code     TEXT,
  receive_date  TEXT,
  stock_status  TEXT DEFAULT 'stock',
  status        TEXT NOT NULL DEFAULT 'active',
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_sku    ON bookings(sku);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

CREATE TABLE IF NOT EXISTS prod_orders (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL REFERENCES products(code),
  sku_name      TEXT,
  qty           REAL NOT NULL,
  plan_date     TEXT,
  receive_date  TEXT,
  line          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  edited_by     TEXT,
  edited_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_prod_orders_sku  ON prod_orders(sku);
CREATE INDEX IF NOT EXISTS idx_prod_orders_date ON prod_orders(plan_date);

CREATE TABLE IF NOT EXISTS sku_settings (
  sku         TEXT PRIMARY KEY REFERENCES products(code),
  min_stock   INTEGER NOT NULL DEFAULT 50,
  shelf_life  INTEGER NOT NULL DEFAULT 30,
  moq         INTEGER NOT NULL DEFAULT 0,
  lead_time   INTEGER NOT NULL DEFAULT 7,
  note        TEXT,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- product parent/child (combo/kit) SKU mapping — promoted from the dormant draft in
-- server/db/draft_tss_consi_invoices.sql (consi_bom_master), which was originally designed for the
-- separate, still-open Consi sales-explosion question. Only this one table is promoted; the rest of
-- that draft file stays untouched/unwired. No FK to products on parent_code/child_code: same
-- reasoning as stock/sales_transactions elsewhere in this file — combo/kit codes printed on a sales
-- doc may not exist as their own row in products/STMAS.
CREATE TABLE IF NOT EXISTS consi_bom_master (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_code   TEXT NOT NULL,
  parent_name   TEXT,
  child_code    TEXT NOT NULL,
  child_name    TEXT,
  child_unit    TEXT,
  ratio         REAL NOT NULL DEFAULT 1,
  note          TEXT,
  is_confirmed  INTEGER NOT NULL DEFAULT 0,   -- 0 = system-proposed, needs review; 1 = human-confirmed
  confirmed_by  TEXT,
  confirmed_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_consi_bom_parent ON consi_bom_master(parent_code);

-- ── AUDIT ──

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uid     TEXT NOT NULL,
  role    TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT,
  ip_addr TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_uid    ON audit_log(uid);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);

-- ── PERMISSIONS / HIDE-FUNCTION (moved server-side so it's consistent across every PC) ──

-- per dept+position page visibility, replaces the old client-only localStorage 'nav_perms_deptpos'
CREATE TABLE IF NOT EXISTS nav_perms_deptpos (
  group_key   TEXT PRIMARY KEY,   -- e.g. 'sales_officer'
  pages_json  TEXT NOT NULL,      -- JSON array of page ids this group can see
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- admin-defined custom roles, replaces old localStorage 'nav_roles'
CREATE TABLE IF NOT EXISTS nav_roles (
  role_id     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  pages_json  TEXT NOT NULL,
  is_custom   INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- NEW: global on/off switch per page, independent of per-role visibility.
-- when a page is disabled=0 here, it's hidden/blocked for EVERY user regardless of role.
CREATE TABLE IF NOT EXISTS feature_flags (
  page_id     TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── DBF IMPORT JOB LOG (Phase 2 — every-5-minutes sync from Express) ──

CREATE TABLE IF NOT EXISTS sync_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL,   -- e.g. 'TSS/STOCK.DBF'
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  rows_processed  INTEGER DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  message         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log(started_at);

-- ============================================================
-- VIEWS
-- ============================================================

-- stock summed across warehouses + planning numbers, per SKU
CREATE VIEW IF NOT EXISTS v_stock_planning AS
SELECT
  p.code,
  p.name,
  p.group_name,
  p.lead_time,
  COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = p.code), 0) AS stock_qty,
  COALESCE(ss.min_stock, p.min_stock) AS min_stock,
  COALESCE(ss.lead_time, p.lead_time) AS effective_lt,
  COALESCE(
    (SELECT ROUND(AVG(sh.qty), 1) FROM sales_history sh
      WHERE sh.sku = p.code AND sh.slm_id = 'ALL'
        AND sh.ym >= strftime('%Y-%m', 'now', '-3 months')), 0
  ) AS avg3_monthly,
  CASE WHEN COALESCE(
      (SELECT AVG(sh.qty) FROM sales_history sh
        WHERE sh.sku = p.code AND sh.slm_id = 'ALL'
          AND sh.ym >= strftime('%Y-%m', 'now', '-3 months')), 0) > 0
    THEN CAST(ROUND(
      COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = p.code), 0) /
      ((SELECT AVG(sh.qty) FROM sales_history sh
          WHERE sh.sku = p.code AND sh.slm_id = 'ALL'
            AND sh.ym >= strftime('%Y-%m', 'now', '-3 months')) / 30.0)
    ) AS INTEGER)
    ELSE 9999
  END AS days_remaining
FROM products p
LEFT JOIN sku_settings ss ON ss.sku = p.code
WHERE p.is_active = 1;

-- per-warehouse stock detail, joined with product name
-- Rebuilt 2026-07-13 to add warehouse_name — DROP first, not "IF NOT EXISTS": db/init.js re-runs this
-- whole file on every server boot, and CREATE VIEW IF NOT EXISTS silently no-ops against a view that
-- already exists, which would leave the OLD 5-column definition stuck forever on any machine that
-- already has a provisioned tgm.db. Any future view redefinition needs the same DROP-first treatment.
DROP VIEW IF EXISTS v_stock_by_warehouse;
CREATE VIEW v_stock_by_warehouse AS
SELECT s.sku, p.name AS sku_name, s.warehouse, w.name AS warehouse_name, s.qty, s.unit, s.last_updated
FROM stock s
LEFT JOIN products p ON p.code = s.sku
LEFT JOIN warehouses w ON w.code = s.warehouse;

-- sc_users without pwd_hash, safe to send to the browser
CREATE VIEW IF NOT EXISTS v_sc_users_safe AS
SELECT uid, name, role, department, position, slm_id, email, is_active, created_at
FROM sc_users;

-- reservations + stock availability
CREATE VIEW IF NOT EXISTS v_reservation_status AS
SELECT
  r.*,
  p.name AS sku_name,
  COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = r.sku), 0) AS stock_available,
  CASE
    WHEN COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = r.sku), 0) >= r.qty_requested THEN 'sufficient'
    WHEN COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = r.sku), 0) > 0 THEN 'partial'
    ELSE 'out_of_stock'
  END AS stock_status
FROM reservations r
JOIN products p ON p.code = r.sku;

-- distinct customer codes that appear in real sales — used for "has this customer ever bought" lookups
CREATE VIEW IF NOT EXISTS v_sc_sales_customer_codes AS
SELECT DISTINCT cust_code FROM sales_transactions WHERE cust_code IS NOT NULL AND cust_code != '';

-- ── MATERIALIZED sales rollups ──
-- These 3 used to be plain SQL views computed live from sales_transactions (~1M rows). SQLite has no
-- materialized view support, so every single paginated query (1000 rows at a time, dozens of pages per
-- page load) re-ran the full GROUP BY over the whole table — measured at 2.7-3.3 SECONDS *per page*,
-- which is exactly the slowness this was supposed to avoid. Converted to real tables instead, refreshed
-- once per 5-minute import cycle by refreshSalesRollups() in jobs/importFromExpress.js — reads become a
-- plain indexed SELECT (single-digit ms) at the cost of being up to 5 minutes stale, same as everything
-- else pulled from Express.

-- monthly qty/amount per company+SKU (no salesperson split) — index.html's _sbDashboardSalesAggRows()
CREATE TABLE IF NOT EXISTS v_sc_dashboard_sales_monthly (
  ym             TEXT NOT NULL,
  company        TEXT NOT NULL,
  prod_code      TEXT NOT NULL,
  prod_name      TEXT,
  prod_group     TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  amount         REAL NOT NULL DEFAULT 0,
  invoice_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company, prod_code, ym)
);
CREATE INDEX IF NOT EXISTS idx_dash_sales_ym ON v_sc_dashboard_sales_monthly(ym);

-- monthly qty/amount per company+salesperson+SKU, product name/group/plant attached —
-- index.html's _sbSalesRows() reads this in place of the plain sales_history table when it needs
-- the company dimension (falls back to sales_history automatically if this 404s)
CREATE TABLE IF NOT EXISTS v_sales_history_company (
  slm_id        TEXT NOT NULL,
  sku           TEXT NOT NULL,
  ym            TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 0,
  amount        REAL NOT NULL DEFAULT 0,
  company       TEXT NOT NULL,
  product_name  TEXT,
  group_name    TEXT,
  plant         TEXT,
  PRIMARY KEY (company, slm_id, sku, ym)
);
CREATE INDEX IF NOT EXISTS idx_sales_hist_co_ym ON v_sales_history_company(ym);
CREATE INDEX IF NOT EXISTS idx_sales_hist_co_slm ON v_sales_history_company(slm_id);

-- Real invoiced revenue per Express's own AR ledger (ARTRN.DBF), NOT the order-tracking OESO.DBF
-- everything else in this file is built from. Added 2026-07-20: confirmed against a real tax-invoice
-- report (customer-wise VAT summary, July 2026, TSS) that OESO-derived "sales" (DOCSTAT='M' orders)
-- undercounts real invoiced revenue by ~10x (~8M vs ~78M) — orders and invoices are different
-- documents in this business's Express workflow; many invoices are never linked back to an SO number
-- (only ~6% carry one), so this can't be reconciled at the product/SKU level, only at the
-- company+month+customer level. RECTYP: '0','1','3','4' count as revenue and '5'=credit note/return
-- (subtracted). Documents whose DOCNUM starts with LF/LE/LG are excluded from sales totals per
-- accounting's rule; see importFromExpress.js's syncInvoiceSales() for the exact filter.
-- slm_code: ARTRN carries its own SLMCOD field per transaction (the salesperson recorded at invoice
-- time), so salesperson-level invoice totals don't need to go through customers.slm_id (which only
-- reflects current ownership, not who the sale was actually recorded under). Added 2026-07-21 so the
-- Sales Overview customer/salesperson breakdown tables can foot to the same invoice-based total as the
-- headline KPI — see index.html's _sdBuildCustsFromInvoice/_sdBuildSlmsFromInvoice.
CREATE TABLE IF NOT EXISTS invoice_sales_monthly (
  company        TEXT NOT NULL,
  ym             TEXT NOT NULL,
  cust_code      TEXT NOT NULL,
  slm_code       TEXT NOT NULL DEFAULT '',
  amount         REAL NOT NULL DEFAULT 0,
  invoice_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company, ym, cust_code, slm_code)
);
CREATE INDEX IF NOT EXISTS idx_invoice_sales_ym ON invoice_sales_monthly(ym);
CREATE INDEX IF NOT EXISTS idx_invoice_sales_company ON invoice_sales_monthly(company);
-- idx_invoice_sales_slm is created in migrations.js, AFTER slm_code is added via ALTER TABLE — putting
-- it here crashed the server on every already-provisioned DB: this whole file runs as one db.exec()
-- before runMigrations() gets a chance to add the column, so CREATE INDEX on a not-yet-existing
-- column threw immediately and the service crash-looped.

-- Individual tax-invoice HEADER records (added 2026-08-06) — invoice_sales_monthly above only keeps
-- an aggregated company+month+customer rollup, discarding the per-invoice doc_num/so_num/date. Added
-- to power tgm-wms's "จ่ายสินค้า by ใบกำกับภาษี" dispatch flow: most invoices DO carry a so_num back to
-- a real SO (this table keeps it per-row, unlike the monthly rollup), letting tgm-wms show/link the
-- invoice number against the existing SO-based pick flow. For the invoices with NO so_num (issued
-- directly, no SO ever raised — confirmed by the user this genuinely happens), tgm-wms falls back to
-- a manual-entry dispatch instead, since ARTRN carries no SKU/line-item detail at all regardless (see
-- invoice_sales_monthly's comment above) — this table only ever supplies invoice HEADER info, never
-- product lines. Scoped to a rolling recent window by syncInvoices() (not the full ARTRN history)
-- since this exists for day-to-day dispatch work, not historical reporting.
CREATE TABLE IF NOT EXISTS invoices (
  doc_num     TEXT PRIMARY KEY,
  doc_date    TEXT,
  cust_code   TEXT,
  slm_code    TEXT,
  so_num      TEXT,
  total       REAL NOT NULL DEFAULT 0,
  rectyp      TEXT,
  -- ADDED 2026-09-16 (สายรถ feature): route_code is ARTRN.AREACOD as-is (Express's own per-invoice
  -- delivery-route code); route_name is that code resolved via ISTAB TABTYP='41' at sync time — see
  -- ROUTE_TABTYP in importFromExpress.js for how this was confirmed.
  route_code  TEXT,
  route_name  TEXT,
  -- ADDED 2026-09-17 (tgm-wms สายรถ): ARTRN.SHIPTO joined against ARSHIP.DBF by CUSCOD+SHIPTO
  -- so delivery sheets can show the real Express ship-to/place instead of falling back to WMS customer master.
  ship_to_code    TEXT,
  ship_to_address TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_so_num ON invoices(so_num);
CREATE INDEX IF NOT EXISTS idx_invoices_cust_code ON invoices(cust_code);
CREATE INDEX IF NOT EXISTS idx_invoices_doc_date ON invoices(doc_date);

-- Promotion price documents — Express has no separate quotation/promotion file: these are OESO.DBF
-- header rows whose SONUM happens to start with 'P1' or 'P2' (SORECTYP='5', confirmed 2026-08-2x by
-- inspecting real production DBF data), same file every other Sales Order lives in. Price is per line
-- item (OESOIT.DBF.UNITPR), not the header total, so this mirrors at line-item granularity — one row
-- per (company, sonum, seqnum). Company IS part of the PK (unlike invoices above) because SONUM is
-- only unique within one company's own OESO.DBF. Scoped to TSS+CONSI only (not all of
-- SALES_COMPANIES — see PROMO_DOC_COMPANIES in importFromExpress.js for why the others were dropped)
-- with a PER-COMPANY docstat filter: TSS keeps only 'M' (confirmed), CONSI additionally allows 'N'
-- (not-yet-confirmed) because CONSI has essentially no 'M' promo docs at all — `docstat` column lets
-- the UI badge which rows are confirmed vs not. Read-only mirror, refreshed every 5-min cycle like
-- every other Express-sourced table — see syncPromoDocs() in importFromExpress.js.
CREATE TABLE IF NOT EXISTS promo_docs (
  company     TEXT NOT NULL,
  sonum       TEXT NOT NULL,
  seqnum      TEXT NOT NULL,
  cust_code   TEXT,
  cust_name   TEXT,
  sku         TEXT,
  sku_name    TEXT,
  unit_price  REAL NOT NULL DEFAULT 0,
  start_date  TEXT,
  due_date    TEXT,
  docstat     TEXT,
  -- create_date/doc_ref added 2026-08-26: header-level OESO.DBF fields (SODAT/YOUREF), requested as
  -- separate "วันที่สร้างเอกสาร"/"หมายเหตุอ้างอิง" columns on the promo history page — see
  -- syncPromoDocs()'s comment in importFromExpress.js for why these are header-only (no per-line
  -- counterpart) unlike start_date/due_date.
  create_date TEXT,
  doc_ref     TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (company, sonum, seqnum)
);
CREATE INDEX IF NOT EXISTS idx_promo_docs_cust ON promo_docs(cust_code);
CREATE INDEX IF NOT EXISTS idx_promo_docs_sku ON promo_docs(sku);
CREATE INDEX IF NOT EXISTS idx_promo_docs_dates ON promo_docs(start_date, due_date);
-- idx_promo_docs_create_date is NOT created here on purpose: db/init.js runs this file BEFORE
-- runMigrations() (see migrations.js), so on an already-live DB where CREATE TABLE IF NOT EXISTS
-- above is a no-op (the table already exists without create_date), an index on that column here
-- would crash startup with "no such column: create_date" before migrations.js ever gets to add it.
-- Confirmed live 2026-08-26: this exact mistake put the service in a restart-crash loop. The index
-- is created in migrations.js instead, right after the column is added.

-- Promo drafts (2026-09-03, requested: "สร้างใบโปรในระบบ" ก่อนคีย์เข้า Express จริง) — ร่างเอกสาร
-- โปรโมชัน/เคาะราคา เก็บในระบบเราเองเท่านั้น ไม่เขียนเข้า Express DBF โดยตรง (Express ไม่มี write-path
-- ในระบบนี้เลย มีแต่ read/sync ทางเดียว) พนักงานยังต้องคีย์เข้า Express เองหลังอนุมัติเสร็จเหมือนเดิม แล้ว
-- ค่อยกดปิดสถานะเป็น 'keyed_to_express' ที่นี่ หนึ่งแถว = หนึ่ง (สาขา x สินค้า), หลายแถวที่มาจากใบเดียวกัน
-- (เลือกหลายสาขา/หลายสินค้าพร้อมกัน) แชร์ draft_no เดียวกัน เหมือน promo_docs ที่แชร์ sonum ต่อใบ.
-- Brand new table (ไม่ใช่ ALTER ของเดิม) — inline index ที่นี่ปลอดภัย เหตุผลเดียวกับ po_emails ด้านล่าง.
-- "ใบเคาะราคา" (เดิมเรียก "ใบโปรร่าง"/promo_drafts, เปลี่ยนชื่อ user-facing 2026-09) — แยกเป็น 2 ตาราง
-- (2026-09 v2 redesign): promo_draft_headers เก็บฟิลด์ระดับ "เอกสาร" (1 แถวต่อ 1 ใบเคาะราคา) ส่วน
-- promo_drafts (ด้านล่าง) เหลือแค่ฟิลด์ระดับ "บรรทัดสินค้า×สาขา" เดิมทั้งสองอย่างอยู่ในตารางเดียวกัน
-- (ฟิลด์หัวเอกสารซ้ำในทุกแถว branch×sku) ซึ่งเริ่มมีปัญหาจริงตอนจะเพิ่ม routing state/checkbox พิเศษ/
-- ไฟล์แนบ/ตารางค่าใช้จ่ายอื่นๆ ที่เป็นข้อมูลระดับเอกสารล้วนๆ ไม่ใช่ระดับบรรทัด — promo_drafts ตอนแก้ไขนี้
-- (2026-09-11) ยังว่างอยู่ 0 แถวในฐานข้อมูลจริง (ฟีเจอร์เพิ่งสร้างเสร็จเมื่อวาน ยังไม่มีใครใช้) จึงปรับรูปร่าง
-- ตรงนี้ได้เต็มที่โดยไม่ต้อง backfill — server/db/migrations.js มีการ์ดกันไว้เผื่อสภาพแวดล้อมอื่นมีข้อมูลแล้ว
CREATE TABLE IF NOT EXISTS promo_draft_headers (
  draft_no              TEXT PRIMARY KEY,
  doc_no                TEXT UNIQUE, -- "PC{พ.ศ.}-{เลขวิ่ง 4 หลัก}" ออกโดย server แบบอะตอมมิกตอน insert
  promo_name            TEXT,
  purpose               TEXT,
  condition_type        TEXT,
  item_type             TEXT,
  note                  TEXT,
  equipment             TEXT,
  discount_scope        TEXT NOT NULL DEFAULT 'item',
  cost_start_date       TEXT,
  cost_end_date         TEXT,
  start_date            TEXT,
  due_date              TEXT,
  is_npd                INTEGER NOT NULL DEFAULT 0,
  has_off_contract_cost INTEGER NOT NULL DEFAULT 0,
  has_marketing_cost    INTEGER NOT NULL DEFAULT 0,
  other_costs_json      TEXT NOT NULL DEFAULT '[]', -- [{item,amount,note}] แบบอิสระ ไม่แยกตาราง
  has_compensate        INTEGER NOT NULL DEFAULT 0,
  special_distribution  TEXT,
  levels_json           TEXT NOT NULL DEFAULT '[]', -- clone จาก approval_workflow_templates ตอนส่งอนุมัติ
  current_level         INTEGER NOT NULL DEFAULT 0,
  approvers_json        TEXT NOT NULL DEFAULT '[]', -- flat mirror เหมือน custreg_subs.approvers_json
  status                TEXT NOT NULL DEFAULT 'draft',
  created_by            TEXT,
  updated_by            TEXT,
  keyed_by              TEXT,
  keyed_at              TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pdh_status ON promo_draft_headers(status);

CREATE TABLE IF NOT EXISTS promo_drafts (
  id             TEXT PRIMARY KEY,
  draft_no       TEXT NOT NULL, -- FK-by-convention -> promo_draft_headers.draft_no (ไม่มี FK constraint จริง
                                 -- ตามธรรมเนียมไฟล์นี้ — ดู custreg_attachments.sub_id เป็นตัวอย่างเดิม)
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

-- ไฟล์แนบของใบเคาะราคา (2026-09) — คัดลอกโครงจาก custreg_attachments ด้านล่าง (BLOB ใน SQLite เหมือนกัน)
-- แค่ผูกกับ draft_no ตรงๆ แทน sub_id+slot_id (ใบเคาะราคาไม่มีแนวคิด "slot" ตายตัวแบบฟอร์มลงทะเบียนลูกค้า)
CREATE TABLE IF NOT EXISTS promo_draft_attachments (
  id            TEXT PRIMARY KEY,
  draft_no      TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  content       BLOB NOT NULL,
  note          TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pda_draft ON promo_draft_attachments(draft_no);

-- Comment ต่อแถวสินค้า (ต่อ SKU ต่อเอกสาร, 2026-09) — ไม่มี pattern เดิมในระบบนี้ให้ก็อป (comment ที่มีอยู่
-- ก่อนหน้าผูกกับ "ทั้งเอกสาร" เท่านั้น เช่น custreg_subs.levels[].approvers[].comment) จึงเป็นตารางใหม่ล้วนๆ
CREATE TABLE IF NOT EXISTS promo_draft_line_comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_no      TEXT NOT NULL,
  sku           TEXT NOT NULL,
  uid           TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pdlc_draft_sku ON promo_draft_line_comments(draft_no, sku);

-- "รับเข้าจริง" ของหน้าเปรียบเทียบผลิต (2026-09) — เดิมเก็บใน localStorage (`stock_in_actual`) เท่านั้น
-- ไม่ sync ข้ามเครื่อง/ผู้ใช้เลย ย้ายขึ้น server ให้ทุกคนเห็นข้อมูลเดียวกัน มาจาก import Excel แบบ aggregate
-- ตาม (date, sku) ไม่มี FK กลับ prod_orders.id ที่เชื่อถือได้ (เทียบ plan vs actual ด้วยการ bucket ตาม
-- ช่วงเวลาแยกกันอยู่แล้วที่ psvRender()) จึงเป็นตารางแยก ไม่ ALTER prod_orders
CREATE TABLE IF NOT EXISTS stock_in_actual (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  sku           TEXT NOT NULL,
  qty           REAL NOT NULL DEFAULT 0,
  note          TEXT,
  imported_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_in_actual_date ON stock_in_actual(date);
CREATE INDEX IF NOT EXISTS idx_stock_in_actual_sku ON stock_in_actual(sku);

-- ของตัวอย่าง (sample requests, 2026-09) — เดิมทั้ง flow (สร้าง→อนุมัติ→เตรียม→จัดส่ง→ผลทดสอบ) เก็บใน
-- localStorage เท่านั้น (DB.get/set('sample_requests')) ไม่ sync ข้ามเครื่อง/ผู้ใช้เลย — เซลส์ขอจากเครื่อง
-- ตัวเอง Manager อนุมัติจากเครื่องตัวเอง มองไม่เห็นกัน ย้ายขึ้น server ให้ทุกคนเห็นข้อมูลเดียวกัน
-- หนึ่ง request = หนึ่งแถว (ไม่ต้องกระจายเป็นหลายแถวแบบ promo_drafts เพราะ items/testResult เป็นแค่
-- nested data ของ request เดียว ไม่ใช่ dimension ที่ต้อง query แยกแถว) items/test_result เป็น JSON
CREATE TABLE IF NOT EXISTS sample_requests (
  id            TEXT PRIMARY KEY,
  cust_code     TEXT NOT NULL,
  cust_name     TEXT,
  contact       TEXT,
  phone         TEXT,
  purpose       TEXT,
  delivery_date TEXT,
  address       TEXT,
  note          TEXT,
  items         TEXT NOT NULL DEFAULT '[]',
  test_result   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  by            TEXT,
  by_name       TEXT,
  date          TEXT,
  ts            INTEGER,
  approved_by   TEXT, approved_at   TEXT,
  rejected_by   TEXT, rejected_at   TEXT, reject_reason TEXT,
  prep_by       TEXT, prep_at       TEXT,
  disp_by       TEXT, disp_at       TEXT,
  recv_by       TEXT, recv_at       TEXT,
  submitted_at  TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sample_requests_status ON sample_requests(status);
CREATE INDEX IF NOT EXISTS idx_sample_requests_cust ON sample_requests(cust_code);
CREATE INDEX IF NOT EXISTS idx_sample_requests_by ON sample_requests(by);

-- Workflow อนุมัติแบบ multi-level (2026-09) — โครงสร้างกลาง ใช้ร่วมกันได้หลาย entity (เริ่มจาก custreg,
-- เผื่อ promo_drafts ในอนาคต) หนึ่งแถวต่อ entity_type เดียว (ยังไม่ต้องมีหลาย template ต่อ entity_type
-- ในตอนนี้ — ตรงกับพฤติกรรมเดิมของ custreg_workflow ที่มี config เดียวทั้งระบบ)
CREATE TABLE IF NOT EXISTS approval_workflow_templates (
  entity_type   TEXT PRIMARY KEY,
  levels_json   TEXT NOT NULL DEFAULT '[]',
  updated_by    TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ข้อมูลลูกค้า (custreg, 2026-09) — เดิมทั้ง flow (กรอกฟอร์ม→ส่งอนุมัติหลายระดับ→อนุมัติ/ปฏิเสธ) เก็บใน
-- localStorage เท่านั้น (custreg_subs) ผู้อนุมัติที่ใช้เครื่อง/browser อื่นมองไม่เห็นคำขอเลย ย้ายขึ้น server
-- แล้ว — levels_json/approvers_json เก็บ 2 รูปแบบที่โค้ดฝั่ง client รองรับอยู่แล้ว: multi-level workflow
-- (levels ไม่ว่าง) และ flat approval แบบเดิม (levels ว่าง ใช้ approvers_json เดี่ยว) — ไฟล์แนบจริงแยกไป
-- อยู่ตาราง custreg_attachments (BLOB) ไม่ฝัง base64 ไว้ในแถวนี้ (กัน request body/column โตเกินจำเป็น)
CREATE TABLE IF NOT EXISTS custreg_subs (
  id              TEXT PRIMARY KEY,
  doc_no          TEXT,
  shop            TEXT,
  sales           TEXT,
  sales_uid       TEXT,
  created_by_uid  TEXT,
  owner_sales_uid TEXT,
  owner_sales_name TEXT,
  request_type    TEXT,
  existing_cust   TEXT,
  drive_link      TEXT,
  external_emails TEXT,
  tax_addr        TEXT,
  tax_zip         TEXT,
  phone           TEXT,
  taxid           TEXT,
  crdays          TEXT,
  price           TEXT,
  date            TEXT,
  note            TEXT,
  final_note      TEXT,
  levels_json     TEXT NOT NULL DEFAULT '[]',
  current_level   INTEGER NOT NULL DEFAULT 0,
  approvers_json  TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending',
  custcode        TEXT,
  ts              INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_custreg_subs_status ON custreg_subs(status);
CREATE INDEX IF NOT EXISTS idx_custreg_subs_sales_uid ON custreg_subs(sales_uid);

-- ไฟล์แนบของ custreg (บัตรประชาชน/ทะเบียนการค้า/รูปหน้าร้าน ฯลฯ) — เก็บเป็น BLOB ในตารางแยก (แพทเทิร์น
-- เดียวกับ po_emails.content ด้านล่าง) ไม่ใช่ base64 ฝังใน custreg_subs — กัน request body limit
-- (express.json 5mb) และกันคอลัมน์ TEXT บวมเมื่อมีไฟล์แนบหลายไฟล์/ไฟล์ใหญ่ อัปโหลดผ่าน multipart
-- (multer) ที่ server/routes/custregAttachments.js ไม่ผ่าน makeCrudRouter ทั่วไป
CREATE TABLE IF NOT EXISTS custreg_attachments (
  id            TEXT PRIMARY KEY,
  sub_id        TEXT NOT NULL,
  slot_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  content       BLOB NOT NULL,
  note          TEXT,
  uploaded_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_custreg_attachments_sub ON custreg_attachments(sub_id);

-- PO-by-email import (2026-08-27, requested by tgm-wms's "เอกสาร PO ล่วงหน้า" page) — attachments
-- pulled from a dedicated IMAP mailbox (order@tgm.co.th) by jobs/importPoFromEmail.js. Brand new
-- table, not an ALTER on an existing one, so inline indexes here are safe (see the promo_docs
-- comment above for why that distinction matters).
CREATE TABLE IF NOT EXISTS po_emails (
  id            TEXT PRIMARY KEY, -- `${uidvalidity}:${uid}` — stable per-message IMAP identifier
  subject       TEXT,
  from_addr     TEXT,
  received_at   TEXT,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  content       BLOB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'imported', 'ignored')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_po_emails_status ON po_emails(status);

-- ── REPORTING VIEWS (added 2026-08-2x) ──────────────────────────────────────────────────────────
-- Confirmed with user: they were shown 3 Excel exports from an unrelated company (King Marine
-- Foods, on Microsoft Dynamics NAV/Business Central) as an EXAMPLE of an easy-to-query/join
-- structure — a clean stock-by-item+location+lot snapshot, a sales-history line report, and a
-- customer master with a stable code. Not importing that company's data; these 3 views reshape
-- tgm-supplychain's own already-synced data into the same shape, purely for easier ad-hoc
-- SQL querying (e.g. via DB Browser for SQLite) — not consumed by any frontend page or API route.

-- Equivalent of "Product_Stock": stock by item+location+lot. `stock_lots` has no sync job filling it
-- in (see its own comment in this file) — most rows will show lot_no=NULL and remaining_quantity as
-- the whole-warehouse total until someone syncs/enters real lot data. That's a real limitation of
-- the source data, not a bug in this view.
CREATE VIEW IF NOT EXISTS v_report_stock_snapshot AS
SELECT
  s.sku                   AS item_no,
  p.name                  AS description,
  s.warehouse             AS location_code,
  w.name                  AS location_name,
  sl.lot_no               AS lot_no,
  COALESCE(sl.qty, s.qty) AS remaining_quantity,
  s.unit                  AS unit_of_measure_code,
  p.group_name            AS item_category_code
FROM stock s
LEFT JOIN products p    ON p.code = s.sku
LEFT JOIN warehouses w  ON w.code = s.warehouse
LEFT JOIN stock_lots sl ON sl.sku = s.sku AND sl.warehouse = s.warehouse;

-- Equivalent of "Sales_History": order-based (sales_transactions), NOT invoice-based — Express's AR
-- ledger (ARTRN.DBF, the source of invoice_sales_monthly) carries no SKU field at all, so a
-- sku-level view can only ever be order-based. Confirmed with user this undercounts real invoiced
-- revenue by ~10x (same well-documented gap as everywhere else order-based sales are used in this
-- app) — use this view to explore/join at SKU level, never as a substitute for reported revenue.
CREATE VIEW IF NOT EXISTS v_report_sales_history AS
SELECT
  t.tx_date    AS posting_date,
  t.company    AS company,
  t.so_ref     AS document_no,
  t.slm_id     AS salesperson_code,
  sm.name      AS salesperson_name,
  t.cust_code  AS customer_no,
  c.name       AS customer_name,
  t.sku        AS item_no,
  p.name       AS description,
  t.qty        AS quantity,
  p.unit       AS unit_of_measure,
  t.amount     AS amount,
  p.group_name AS product_group_code
FROM sales_transactions t
LEFT JOIN products p  ON p.code = t.sku
LEFT JOIN customers c ON c.code = t.cust_code
LEFT JOIN salesmen sm ON sm.slm_id = t.slm_id;

-- Equivalent of "Customer_Master". The example had a "Search Name" distinct from "Name"; this app
-- has no separate search-alias field, so search_name just repeats customer name — noted here rather
-- than pretending it's an equivalent field.
CREATE VIEW IF NOT EXISTS v_report_customer_master AS
SELECT
  c.created_at              AS create_date,
  c.slm_id                  AS salesperson_code,
  c.code                    AS customer_no,
  cp.branch                 AS description,
  COALESCE(cp.name, c.name) AS name,
  c.name                    AS search_name
FROM customers c
LEFT JOIN customer_profiles cp ON cp.code = c.code;

-- monthly qty/amount per company+salesperson+customer+SKU, with customer category/corporate attached —
-- index.html's _sbSalesOverviewAggRows() (Sales Overview page) and the base for v_sc_consi_monthly below
CREATE TABLE IF NOT EXISTS v_sales_overview_sales_monthly (
  ym             TEXT NOT NULL,
  company        TEXT NOT NULL,
  slm_owner      TEXT,
  category       TEXT,
  corporate      TEXT,
  cust_code      TEXT NOT NULL,
  cust_name      TEXT,
  prod_group     TEXT,
  prod_code      TEXT NOT NULL,
  prod_name      TEXT,
  qty            REAL NOT NULL DEFAULT 0,
  amount         REAL NOT NULL DEFAULT 0,
  invoice_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company, slm_owner, cust_code, prod_code, ym)
);
CREATE INDEX IF NOT EXISTS idx_sales_ov_ym ON v_sales_overview_sales_monthly(ym);
CREATE INDEX IF NOT EXISTS idx_sales_ov_company ON v_sales_overview_sales_monthly(company);
CREATE INDEX IF NOT EXISTS idx_sales_ov_ym_slm ON v_sales_overview_sales_monthly(ym, slm_owner);
CREATE INDEX IF NOT EXISTS idx_sales_ov_ym_company ON v_sales_overview_sales_monthly(ym, company);
CREATE INDEX IF NOT EXISTS idx_sales_ov_prod ON v_sales_overview_sales_monthly(prod_code);
CREATE INDEX IF NOT EXISTS idx_sales_ov_cust ON v_sales_overview_sales_monthly(cust_code);

-- same shape as v_sales_overview_sales_monthly, scoped to consignment only — this is the "แยกแท็ก"
-- (tagged separately) requirement: company='CONSI' is a first-class column on sales_transactions
-- already, so consignment reporting is just a filtered view, never blended into the other 6 companies'
-- totals (see importFromExpress.js: plain sales_history explicitly excludes CONSI). Stays a plain VIEW
-- (not materialized) — it's just an indexed filter over the already-materialized table above, cheap.
CREATE VIEW IF NOT EXISTS v_sc_consi_monthly AS
SELECT * FROM v_sales_overview_sales_monthly WHERE company = 'CONSI';

-- single-row health check — index.html's getStockPlanning()/dashboard "data confidence" card.
-- Rebuilt 2026-07-13 to add orphan-SKU counters (DROP-first, see v_stock_by_warehouse comment above) —
-- these are what should show ~715 -> ~0 for orphan_sku_consi_count once syncProducts() pulls CONSI too.
DROP VIEW IF EXISTS v_sc_data_confidence;
CREATE VIEW v_sc_data_confidence AS
SELECT
  (SELECT COUNT(*) FROM outbound_orders) AS so_count,
  (SELECT COUNT(*) FROM outbound_lines) AS line_count,
  (SELECT COUNT(*) FROM bookings WHERE status != 'cancelled') AS active_booking_count,
  (SELECT COUNT(*) FROM outbound_orders o
     WHERE NOT EXISTS (SELECT 1 FROM outbound_lines l WHERE l.order_id = o.id)) AS orders_without_line,
  (SELECT COUNT(*) FROM products WHERE is_active = 1) AS active_product_count,
  (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t
     WHERE t.sku IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.code = t.sku)) AS orphan_sku_sales_count,
  (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t
     WHERE t.company = 'CONSI' AND t.sku IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.code = t.sku)) AS orphan_sku_consi_count,
  (SELECT COUNT(DISTINCT s.sku) FROM stock s
     WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.code = s.sku)) AS orphan_sku_stock_count,
  -- Fixed 2026-07-17: this used to be MAX(bookings.created_at, stock.last_updated) — but
  -- stock.last_updated is copied straight from Express's STLOC.DBF LMOVDAT (last inventory
  -- MOVEMENT date in the source accounting system), not from when our own sync job ran. ~1,568
  -- of 4,947 stock rows carry a LMOVDAT in the future (max seen: 2026-07-22, 5 days ahead of a
  -- 2026-07-17 sync), which made "Express Sync ล่าสุด" show an impossible future date. sync_log
  -- is the actual record of when runImport() executed, so use its most recent successful run.
  (SELECT finished_at FROM sync_log WHERE status = 'ok' ORDER BY finished_at DESC LIMIT 1) AS synced_at;

-- one row per Express company book — a cheap standing tripwire so a future "does this company's data
-- look sane" question can be answered by glancing at this instead of re-opening DBF files by hand.
CREATE VIEW IF NOT EXISTS v_sc_import_health_by_company AS
SELECT
  o.company,
  COUNT(DISTINCT o.id) AS order_count,
  (SELECT COUNT(*) FROM sales_transactions t WHERE t.company = o.company) AS tx_count,
  (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t WHERE t.company = o.company) AS distinct_sku_count,
  (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t
     WHERE t.company = o.company AND t.sku IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.code = t.sku)) AS orphan_sku_count,
  MIN(o.order_date) AS min_order_date,
  MAX(o.order_date) AS max_order_date
FROM outbound_orders o
GROUP BY o.company;

-- per-SKU booking/production/stock rollup — index.html's SB.getBookingSummary()
CREATE VIEW IF NOT EXISTS v_sc_booking_summary_by_sku AS
SELECT
  p.code AS sku,
  p.name AS sku_name,
  (SELECT COUNT(*) FROM bookings b WHERE b.sku = p.code) AS booking_count,
  COALESCE((SELECT SUM(b.qty) FROM bookings b WHERE b.sku = p.code), 0) AS total_qty,
  COALESCE((SELECT SUM(b.qty) FROM bookings b WHERE b.sku = p.code AND b.type = 'PO'), 0) AS po_qty,
  COALESCE((SELECT SUM(b.qty) FROM bookings b WHERE b.sku = p.code AND b.type = 'SO'), 0) AS so_qty,
  COALESCE((SELECT SUM(po.qty) FROM prod_orders po WHERE po.sku = p.code), 0) AS produce_qty,
  (SELECT MAX(b.receive_date) FROM bookings b WHERE b.sku = p.code) AS latest_receive_date,
  COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.sku = p.code), 0) AS stock_qty,
  (SELECT MAX(b.created_at) FROM bookings b WHERE b.sku = p.code) AS latest_created_at
FROM products p
WHERE p.is_active = 1;
