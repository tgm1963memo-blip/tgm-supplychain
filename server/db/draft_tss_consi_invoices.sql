-- ============================================================
-- DRAFT v2 — ยังไม่ต่อเข้า schema.sql / init.js จริง
-- ============================================================
-- อัปเดตจาก v1 ตามที่ยืนยันมา:
--   1) ประเภทเอกสาร (ขาย/โอนคลัง) แยกด้วย prefix 2 ตัวแรกของเลขที่เอกสาร (SONUM)
--      → ทำเป็นตาราง doc_prefix_rules ให้แก้ไข/เพิ่ม prefix เองได้ทีหลังโดยไม่ต้องแก้โค้ด
--   2) ยืนยันว่ามีเคส Kit (คอมโบราคาโปรที่แจกแจงเป็น free-text) จริงในข้อมูล Consi
--      → เปลี่ยนจาก VIEW ธรรมดาเป็นตารางผลลัพธ์จริง (เหมือน v_sc_dashboard_sales_monthly
--      ที่ materialize ไว้แล้วในระบบเดิม) เพราะการแยกคำ free-text ต้องใช้ regex/โค้ด
--      (พอร์ตจาก parsers/parse_142.py + domain/explode.py เดิม) ทำเป็น SQL view เพียวๆไม่ได้
--      *** ยังค้างอยู่ 1 เรื่อง — ดู "OPEN QUESTION" ท้ายไฟล์ ***
-- ============================================================

PRAGMA foreign_keys = ON;

-- ── 1) TAX INVOICE LINES (ใช้ร่วมกันทั้ง TSS และ CONSI ผ่านคอลัมน์ company) ──
-- แถวหนึ่ง = หนึ่งบรรทัดสินค้าบนใบกำกับภาษีหนึ่งใบ
CREATE TABLE IF NOT EXISTS tax_invoice_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company      TEXT NOT NULL,                  -- 'TSS' | 'CONSI' (คอลัมน์เดียวกับ sales_transactions.company)
  doc_date     TEXT NOT NULL,                   -- วันที่เอกสาร
  doc_no       TEXT NOT NULL,                   -- เลขที่เอกสาร (เลขใบกำกับภาษี / SONUM)
  doc_prefix   TEXT,                            -- 2 ตัวแรกของ doc_no เก็บแยกไว้ query/debug ง่าย
  doc_type     TEXT NOT NULL DEFAULT 'sale'
                 CHECK (doc_type IN ('sale','transfer')),  -- มาจาก doc_prefix_rules ตอน import
  cust_code    TEXT,                            -- รหัสลูกค้า
  cust_name    TEXT,                            -- ชื่อลูกค้า (เก็บ snapshot ตามที่พิมพ์บนบิล ณ วันนั้น)
  warehouse_to TEXT REFERENCES warehouses(code),-- คลังปลายทาง — ใส่เฉพาะ doc_type='transfer' ที่รู้คลังจาก prefix
  item_code    TEXT NOT NULL,                   -- รหัสสินค้าตามที่ขึ้นบนบิล (CONSI อาจเป็นรหัสพ่อ/คอมโบ)
  item_name    TEXT,                            -- ชื่อสินค้า
  qty          REAL NOT NULL DEFAULT 0,         -- จำนวน
  unit         TEXT,                            -- หน่วย
  unit_price   REAL NOT NULL DEFAULT 0,         -- ราคาต่อหน่วย
  amount       REAL NOT NULL DEFAULT 0,         -- ราคารวม
  slm_id       TEXT,                            -- รหัสพนักงานขาย
  slm_name     TEXT,                            -- ชื่อพนักงานขาย (snapshot ไว้เหมือน cust_name/item_name จะได้ไม่ต้อง join salesmen ทุกครั้ง)
  so_ref       TEXT,                            -- เลขที่ SO อ้างอิง ถ้าต้องโยงกับ outbound_orders
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tax_inv_company_date ON tax_invoice_lines(company, doc_date);
CREATE INDEX IF NOT EXISTS idx_tax_inv_doc     ON tax_invoice_lines(doc_no);
CREATE INDEX IF NOT EXISTS idx_tax_inv_item    ON tax_invoice_lines(item_code);
CREATE INDEX IF NOT EXISTS idx_tax_inv_cust    ON tax_invoice_lines(cust_code);
CREATE INDEX IF NOT EXISTS idx_tax_inv_type    ON tax_invoice_lines(company, doc_type);
CREATE INDEX IF NOT EXISTS idx_tax_inv_slm     ON tax_invoice_lines(slm_id);

-- ── 2) กติกาแยกประเภทเอกสารจาก prefix — แก้/เพิ่มได้เองไม่ต้องแก้โค้ด ──
CREATE TABLE IF NOT EXISTS doc_prefix_rules (
  prefix        TEXT PRIMARY KEY,             -- 2 ตัวแรกของ doc_no เช่น 'VL','SA'
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('sale','transfer')),
  warehouse_to  TEXT REFERENCES warehouses(code),  -- ใส่เฉพาะกรณีรู้คลังปลายทางแน่นอนจาก prefix ตัวเดียว
  description   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO doc_prefix_rules (prefix, doc_type, warehouse_to, description) VALUES
  ('VL', 'transfer', '03', 'โอนย้ายไปคลัง Villa'),
  ('TP', 'transfer', '04', 'โอนย้ายไปคลัง Tops'),
  ('LT', 'transfer', '05', 'โอนย้ายไปคลัง Lotus'),
  ('MK', 'transfer', '06', 'โอนย้ายไปคลัง Makro'),
  ('TG', 'transfer', '07', 'โอนย้ายไปคลัง TGM (ส่งของแทน)'),
  ('RL', 'transfer', NULL, 'โอนย้ายทั่วไป — ยังไม่รู้คลังปลายทางจาก prefix อย่างเดียว ต้องดูฟิลด์อื่นเพิ่ม'),
  ('SA', 'sale', NULL, 'ใบสั่งขาย มีใบกำกับ'),
  ('SB', 'sale', NULL, 'ใบสั่งขาย CP - แมคโคร'),
  ('SE', 'sale', NULL, 'ใบสั่งขาย ไส้กรอก พนักงาน'),
  ('SI', 'sale', NULL, 'ใบสั่งขาย โรงแรม'),
  ('SF', 'sale', NULL, 'ใบสั่งขาย ใบจองสินค้า')
ON CONFLICT(prefix) DO NOTHING;
-- prefix ของ "ใบสั่งขาย Online" และ "มีใบกำกับ 7-11" ในภาพยังไม่ชัด — เพิ่มแถวเองได้เลยตอนเจอของจริง
-- prefix ที่ไม่ตรงกับตารางนี้เลย จะ default เป็น doc_type='sale' (ปลอดภัยกว่า เพราะ transfer มีจำกัด รู้ชัดแล้วว่ามีตัวไหนบ้าง)

-- ── 3) CONSI: ตารางแม่แปลง "รหัสพ่อ -> รหัสลูก" (ย้ายมาจาก app เช็ค Stock Consi/app/schema.sql:bom_master) ──
CREATE TABLE IF NOT EXISTS consi_bom_master (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_code  TEXT NOT NULL,                   -- รหัสที่ขึ้นบนบิลขาย (คอมโบ/ชุด)
  parent_name  TEXT,
  child_code   TEXT NOT NULL,                   -- รหัสสินค้าที่สต๊อกจริง
  child_name   TEXT,
  child_unit   TEXT,
  ratio        REAL NOT NULL DEFAULT 1,         -- child_qty = parent_qty * ratio
  note         TEXT,
  is_guessed   INTEGER NOT NULL DEFAULT 0,      -- 1 = ระบบเดาไว้ ยังไม่ยืนยัน (เหมือนต้นฉบับ)
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_consi_bom_parent ON consi_bom_master(parent_code);

-- ── 4) CONSI: free-text ที่แปะอยู่ใต้บรรทัดสินค้า (คอมโบราคาโปร/รหัส 9xxxx) ──
-- หนึ่งบรรทัดสินค้าอาจมี note ได้หลายบรรทัด (เหมือนต้นฉบับที่ 1 detail row ตามด้วยได้
-- หลาย note row ก่อนถึง blank separator) — เก็บดิบไว้ก่อนแยก แล้วให้ job แปลง (พอร์ตจาก
-- parse_142.py) ไปเป็นแถวใน consi_sales_exploded อีกที
CREATE TABLE IF NOT EXISTS tax_invoice_line_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id      INTEGER NOT NULL REFERENCES tax_invoice_lines(id),
  seq          INTEGER NOT NULL DEFAULT 1,      -- ลำดับ note ภายในบรรทัดเดียวกัน (มีได้หลาย child)
  raw_text     TEXT NOT NULL,                   -- ข้อความดิบตามที่มาจาก Express เช่น "10391-320 แฮมหมูรมควัน... 10p"
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tax_inv_notes_line ON tax_invoice_line_notes(line_id);

-- ── 5) CONSI: ผลลัพธ์หลังแตกรหัสลูกแล้ว — เป็นตารางจริง ไม่ใช่ VIEW ──
-- เหตุผล: ต้องมี job (JS พอร์ตจาก domain/explode.py) รันตอน sync ทุก 5 นาทีเพื่อ:
--   - เคส "ตรง"      ไม่มีใน bom_master        → เท่าตัวเอง
--   - เคส "Master"    มีใน bom_master           → แตกตาม ratio
--   - เคส "Kit"       item_code ขึ้นต้นด้วย 9   → อ่าน tax_invoice_line_notes มาแตก
--   - เคส "Kit→Master" ลูกที่แตกจาก Kit ดันมีใน bom_master อีกที → แตกซ้อนอีกชั้น
-- (เหมือน refreshSalesRollups() ที่ materialize ผลไว้แล้วในระบบเดิม ด้วยเหตุผลเดียวกัน
-- คือ query สดทุกครั้งจะช้าไม่คุ้ม)
CREATE TABLE IF NOT EXISTS consi_sales_exploded (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id       INTEGER NOT NULL REFERENCES tax_invoice_lines(id),
  doc_no        TEXT,
  doc_date      TEXT,
  cust_code     TEXT,
  cust_name     TEXT,
  parent_code   TEXT,
  parent_name   TEXT,
  parent_qty    REAL,
  parent_unit   TEXT,
  child_code    TEXT,
  child_name    TEXT,
  child_qty     REAL,
  child_unit    TEXT,
  source        TEXT,     -- 'ตรง' | 'Master' | 'Kit' | 'Kit→Master' | 'รหัส 9 ไม่มีบรรทัดลูก'
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_consi_exploded_line  ON consi_sales_exploded(line_id);
CREATE INDEX IF NOT EXISTS idx_consi_exploded_child ON consi_sales_exploded(child_code);

-- ── 6) VIEW: โอนย้ายสินค้าไปคลังฝากขาย (TSS -> 03/04/05/...) ──
CREATE VIEW IF NOT EXISTS v_tss_transfers_to_consi AS
SELECT t.*, w.name AS warehouse_to_name
FROM tax_invoice_lines t
LEFT JOIN warehouses w ON w.code = t.warehouse_to
WHERE t.company = 'TSS' AND t.doc_type = 'transfer';

-- ============================================================
-- OPEN QUESTION (ยังตอบไม่ได้ ต้องยืนยันก่อนต่อ job import จริง):
-- free-text "ประกอบด้วย ..." ของเคส Kit ในไฟล์ 142.CSV เดิมมาจากรายงาน "142"
-- (รายงานใบกำกับสินค้า) ที่ export เป็น CSV ต่างหาก ไม่ใช่มาจาก OESO/OESOIT.DBF
-- ที่ jobs/importFromExpress.js sync เข้าระบบอยู่ทุก 5 นาทีตอนนี้
--
-- ต้องถามกลับ: ข้อความ "ประกอบด้วย ..." นี้ อยู่ใน DBF ไฟล์ไหน/ฟิลด์ไหนของ Express
-- (เช่น OESOIT มีฟิลด์ remark/memo ต่อบรรทัดไหม หรือมันเป็น DBF อื่นแยกไปเลย)?
-- ถ้าไม่มีในฝั่ง DBF จริงๆ ทางเลือกคือ:
--   (a) ให้ job import อ่านไฟล์ export รายงาน 142 เพิ่มอีกไฟล์ (คู่กับที่อ่าน DBF อยู่แล้ว)
--   (b) หรือพนักงานยังต้อง upload ไฟล์ 142.CSV เข้ามาเองเป็นระยะ (เหมือนแอป Stock Consi เดิม)
-- เลือกไม่ได้จนกว่าจะรู้ว่าข้อมูลนี้จริงๆแล้วอยู่ตรงไหนในฝั่ง Express
-- ============================================================
