'use strict';

// ดึงยอดขายจากระบบ Business Plus (Bplus) ของโรงงาน TGM (SQL Server 192.168.10.3, ฐาน TGM) — 2026-10-05
// ตรวจกับข้อมูลจริงแล้ว (อ่านอย่างเดียวด้วยบัญชี tgm_sc_reader):
//   · ฐาน TSS ใน Bplus ไม่มีเอกสารตั้งแต่ 2025 → ดึงเฉพาะฐาน TGM
//   · ยอดฝั่งลูกหนี้ (ARDETAIL.ARD_B_SV + ARD_B_SNV = มูลค่าก่อน VAT) ตรงกับผลรวมบรรทัดสินค้า TRANSTKD.TRD_B_SELL
//     (ก.ย. 2026 = 136.32 ล้านทั้งสองฝั่ง)
//   · บริษัท TGM ใน Express เป็นส่วนย่อยของ Bplus (ลูกค้า CP Axtra รหัสเดียวกัน ยอดตรงกัน เช่น 30-NW-1001 = 68.1 ล้าน)
//     → ผู้ใช้ตัดสินใจ 2026-10-05: ตั้งแต่ 2025 ใช้ Bplus แทน TGM ของ Express ทั้งหมด (ดู routes/dashboardExec.js yearSources)
// กติกาที่ผู้ใช้ยืนยัน 2026-10-05:
//   · ขายให้ "ไทยซอสเซสมาร์เก็ตติ้ง" (บริษัทในเครือ ~4,100 ล้าน) เก็บแยกเป็นบริษัท BP-TGM-IC — ดูได้แต่ไม่นับเป็นยอดขาย
//   · ไม่นับใบยืมสินค้า (IVZ/EB), รายได้อื่น (IQOA/IQOB), ขายทรัพย์สิน (SF/SFN)
//   · ใบ IVP. (Bplus ตั้งชื่อ "ใบยืมสินค้าIVP") นับเป็นยอดขาย — 2026-10-08 ผู้ใช้ยืนยัน: Excel ฝ่ายขายนับเป็นยอดเอเย่น
//     (เช่น SMN-02-PC นายสมนึก ออก IVP. ทุกสัปดาห์ ~80k) · ปี 2025 มี IVP. รวม 41.3 ล้าน
//   · นับ: ใบกำกับ/ขายสด (DT_PROPERTIES 307/302) + ใบเพิ่มหนี้ (402) − ใบรับคืน/ลดหนี้ (308/403/337)
//   · รหัสพนักงานขายของโรงงานจับคู่กับรหัส Express ผ่านตาราง bplus_salesman_map (ยังไม่จับคู่ = 'BP-<รหัส>')
// เอกสารใน Bplus ไม่มีรหัสพนักงานขาย (AROE ว่าง) — ใช้ ARFILE.AR_SLMNCODE (ผู้ดูแลลูกค้าปัจจุบัน) แทน
// TRD_WEIGHT ใน Bplus เป็น 0 ทุกบรรทัด → KG คิดแบบเดียวกับ Express (หน่วยกิโลกรัม หรือ skus.weight_per_unit ของ WMS)

const sql = require('mssql');

const FROM_DATE = '2025-01-01';
const COMPANY = 'BP-TGM';
const COMPANY_IC = 'BP-TGM-IC';
const EXCLUDED_DOCCODES = ['IVZ', 'EB', 'IQOA', 'IQOB', 'SF', 'SFN'];
const MIN_INTERVAL_MS = (Number(process.env.BPLUS_SYNC_MIN_INTERVAL_MIN) || 30) * 60 * 1000;
const STATE_KEY = 'bplus/TGM';

function bplusConfigured() {
  return !!(process.env.BPLUS_SQL_HOST && process.env.BPLUS_SQL_USER && process.env.BPLUS_SQL_PASSWORD);
}

// ลูกค้าเงินสด POS ในโรงงานใช้รหัส '0' — เปลี่ยนเป็น BP-POS กันชนกับรหัสอื่นใน Express
function custCodeOf(raw) {
  const c = String(raw || '').trim();
  return !c || c === '0' ? 'BP-POS' : c;
}

const WHERE_DOCS = `d.DI_DATE >= @from AND d.DI_ACTIVE = 0
  AND dt.DT_PROPERTIES IN (302, 307, 308, 402, 403, 337)
  AND RTRIM(dt.DT_DOCCODE) NOT IN (${EXCLUDED_DOCCODES.map((c) => `'${c}'`).join(', ')})`;
const SIGN = 'CASE WHEN dt.DT_PROPERTIES IN (308, 403, 337) THEN -1 ELSE 1 END';
const IS_CN = 'dt.DT_PROPERTIES IN (308, 403, 337)';
const IS_IC = `CASE WHEN r.AR_NAME LIKE N'%ไทยซอสเซสมาร์เก็ตติ้ง%' THEN 1 ELSE 0 END`;

async function fetchFromBplus() {
  const pool = await new sql.ConnectionPool({
    server: process.env.BPLUS_SQL_HOST,
    port: Number(process.env.BPLUS_SQL_PORT) || 1433,
    user: process.env.BPLUS_SQL_USER,
    password: process.env.BPLUS_SQL_PASSWORD,
    database: process.env.BPLUS_SQL_DATABASE || 'TGM',
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 20000,
    requestTimeout: 600000,
  }).connect();
  try {
    const q = (text) => pool.request().input('from', sql.Date, FROM_DATE).query(text);
    const monthly = (await q(`
      SELECT CONVERT(char(10), d.DI_DATE, 120) AS d, RTRIM(r.AR_CODE) AS cust_code, ISNULL(RTRIM(r.AR_SLMNCODE), '') AS slmn, ${IS_IC} AS ic,
        SUM(${SIGN} * (a.ARD_B_SV + a.ARD_B_SNV)) AS amount,
        SUM(CASE WHEN ${IS_CN} THEN 0 ELSE 1 END) AS invoice_count,
        SUM(CASE WHEN ${IS_CN} THEN 1 ELSE 0 END) AS cn_count,
        SUM(CASE WHEN ${IS_CN} THEN a.ARD_B_SV + a.ARD_B_SNV ELSE 0 END) AS cn_amount,
        SUM(${SIGN} * a.ARD_B_VAT) AS vat_amount,
        SUM(CASE WHEN ${IS_CN} THEN a.ARD_B_VAT ELSE 0 END) AS cn_vat
      FROM ARDETAIL a JOIN DOCINFO d ON d.DI_KEY = a.ARD_DI JOIN DOCTYPE dt ON dt.DT_KEY = d.DI_DT JOIN ARFILE r ON r.AR_KEY = a.ARD_AR
      WHERE ${WHERE_DOCS}
      GROUP BY CONVERT(char(10), d.DI_DATE, 120), r.AR_CODE, r.AR_SLMNCODE, r.AR_NAME`)).recordset;
    // บรรทัดสินค้าเฉพาะเอกสารขาย (ไม่หักรับคืน — กติกาเดียวกับ KG ฝั่ง Express)
    const lines = (await q(`
      SELECT CONVERT(char(10), d.DI_DATE, 120) AS d, RTRIM(r.AR_CODE) AS cust_code, ISNULL(RTRIM(r.AR_SLMNCODE), '') AS slmn, ${IS_IC} AS ic,
        RTRIM(s.SKU_CODE) AS sku, ISNULL(RTRIM(t.TRD_UTQNAME), '') AS unit,
        SUM(t.TRD_QTY) AS qty, SUM(t.TRD_QTY * ISNULL(NULLIF(t.TRD_UTQQTY, 0), 1)) AS qty_base, SUM(t.TRD_B_SELL) AS amount
      FROM TRANSTKD t JOIN TRANSTKH h ON h.TRH_KEY = t.TRD_TRH JOIN DOCINFO d ON d.DI_KEY = h.TRH_DI JOIN DOCTYPE dt ON dt.DT_KEY = d.DI_DT
      JOIN (SELECT ARD_DI, MIN(ARD_AR) AS ARD_AR FROM ARDETAIL GROUP BY ARD_DI) a ON a.ARD_DI = d.DI_KEY
      JOIN ARFILE r ON r.AR_KEY = a.ARD_AR JOIN SKUMASTER s ON s.SKU_KEY = t.TRD_SKU
      WHERE ${WHERE_DOCS} AND dt.DT_PROPERTIES IN (302, 307)
      GROUP BY CONVERT(char(10), d.DI_DATE, 120), r.AR_CODE, r.AR_SLMNCODE, r.AR_NAME, s.SKU_CODE, t.TRD_UTQNAME`)).recordset;
    const customers = (await q(`
      SELECT RTRIM(r.AR_CODE) AS code, RTRIM(r.AR_NAME) AS name, ISNULL(RTRIM(r.AR_SLMNCODE), '') AS slmn, ${IS_IC} AS ic,
        MAX(CASE WHEN RTRIM(dt.DT_DOCCODE) LIKE 'EX%' THEN 1 ELSE 0 END) AS has_export
      FROM ARDETAIL a JOIN DOCINFO d ON d.DI_KEY = a.ARD_DI JOIN DOCTYPE dt ON dt.DT_KEY = d.DI_DT JOIN ARFILE r ON r.AR_KEY = a.ARD_AR
      WHERE ${WHERE_DOCS}
      GROUP BY r.AR_CODE, r.AR_NAME, r.AR_SLMNCODE`)).recordset;
    const salesmen = (await pool.request().query('SELECT RTRIM(SLMN_CODE) AS code, RTRIM(SLMN_NAME) AS name FROM SALESMAN')).recordset;
    // ชื่อสินค้า (2026-10-05) — Sales Overview แท็บรายสินค้าแสดงชื่อสินค้าโรงงาน (รหัสอย่าง 20394-177 ไม่มีใน products ของ Express)
    const skus = (await pool.request().query('SELECT RTRIM(SKU_CODE) AS code, RTRIM(SKU_NAME) AS name FROM SKUMASTER')).recordset;
    return { monthly, lines, customers, salesmen, skus };
  } finally {
    await pool.close().catch(() => {});
  }
}

// รัน sync (เรียกจาก jobs/syncWorker.js ต่อท้าย Express sync ใน worker เดียวกัน — กันสองงานเขียน SQLite พร้อมกัน)
// force=true ข้ามช่วงเว้น MIN_INTERVAL (ใช้หลังแก้ตารางจับคู่พนักงานขาย)
async function runBplusImport(db, { force = false } = {}) {
  if (!bplusConfigured()) return 0;
  const prev = db.prepare('SELECT synced_at FROM sync_file_state WHERE source = ?').get(STATE_KEY);
  if (!force && prev && prev.synced_at && Date.now() - Date.parse(prev.synced_at) < MIN_INTERVAL_MS) return 0;
  const startedAt = new Date().toISOString();
  const log = db.prepare('INSERT INTO sync_log (source, started_at, status) VALUES (?, ?, ?)').run('bplus', startedAt, 'running');
  try {
    // เชื่อม SQL Server ไม่ได้ / query ล้ม = โยน error ก่อนแตะข้อมูลเดิม → ข้อมูลรอบก่อนยังอยู่ครบ
    const data = await fetchFromBplus();
    if (!data.monthly.length) throw new Error('Bplus ส่งข้อมูลกลับมา 0 แถว — ข้ามรอบนี้เพื่อไม่ลบข้อมูลเดิม');
    const map = new Map(db.prepare('SELECT bp_code, slm_code FROM bplus_salesman_map WHERE slm_code IS NOT NULL AND slm_code <> \'\'').all()
      .map((r) => [r.bp_code, r.slm_code]));
    const slmOf = (bp) => map.get(bp) || (bp ? `BP-${bp}` : 'BP-(none)');
    const companyOf = (ic) => (ic ? COMPANY_IC : COMPANY);

    // รวมซ้ำฝั่ง JS อีกชั้น เผื่อรหัสลูกค้า '0' หลายตัว/ชื่อซ้ำทำให้ key ชนกันหลังแปลงรหัส
    // (2026-10-06) SQL คืนรายวัน (d = YYYY-MM-DD) → รวมเป็นรายเดือน (ym = 7 ตัวแรก) และรายวันพร้อมกัน
    const inv = new Map();
    const invDaily = new Map();
    for (const r of data.monthly) {
      const base = [companyOf(r.ic), custCodeOf(r.cust_code), slmOf(r.slmn)];
      for (const [map, period] of [[inv, String(r.d).slice(0, 7)], [invDaily, String(r.d).slice(0, 10)]]) {
        const key = [base[0], period, base[1], base[2]].join('\u0001');
        const cur = map.get(key) || { amount: 0, invoice_count: 0, cn_count: 0, cn_amount: 0, vat_amount: 0, cn_vat: 0 };
        for (const k of Object.keys(cur)) cur[k] += Number(r[k]) || 0;
        map.set(key, cur);
      }
    }
    const lines = new Map();
    const linesDaily = new Map();
    for (const r of data.lines) {
      for (const [map, period] of [[lines, String(r.d).slice(0, 7)], [linesDaily, String(r.d).slice(0, 10)]]) {
        const key = [companyOf(r.ic), period, custCodeOf(r.cust_code), slmOf(r.slmn), r.sku, r.unit].join('\u0001');
        const cur = map.get(key) || { qty: 0, qty_base: 0, amount: 0 };
        cur.qty += Number(r.qty) || 0; cur.qty_base += Number(r.qty_base) || 0; cur.amount += Number(r.amount) || 0;
        map.set(key, cur);
      }
    }

    const insInv = db.prepare(`INSERT INTO invoice_sales_monthly (company, ym, cust_code, slm_code, amount, invoice_count, cn_count, cn_amount, vat_amount, gross_amount, cn_vat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insLine = db.prepare(`INSERT INTO sales_lines_monthly (company, ym, cust_code, slm_code, sku, unit_code, qty, qty_base, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insInvDaily = db.prepare('INSERT INTO invoice_sales_daily (company, d, cust_code, slm_code, amount, invoice_count) VALUES (?, ?, ?, ?, ?, ?)');
    const insLineDaily = db.prepare(`INSERT INTO sales_lines_daily (company, d, cust_code, slm_code, sku, unit_code, qty, qty_base, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const upCust = db.prepare(`INSERT INTO bplus_customers (code, name, bp_slm_code, is_intercompany, has_export, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(code) DO UPDATE SET name = excluded.name, bp_slm_code = excluded.bp_slm_code,
        is_intercompany = excluded.is_intercompany, has_export = excluded.has_export, updated_at = excluded.updated_at`);
    const upSlm = db.prepare(`INSERT INTO bplus_salesman_map (bp_code, bp_name) VALUES (?, ?)
      ON CONFLICT(bp_code) DO UPDATE SET bp_name = excluded.bp_name`);

    db.exec('BEGIN');
    try {
      for (const c of [COMPANY, COMPANY_IC]) {
        db.prepare('DELETE FROM invoice_sales_monthly WHERE company = ?').run(c);
        db.prepare('DELETE FROM sales_lines_monthly WHERE company = ?').run(c);
        db.prepare('DELETE FROM invoice_sales_daily WHERE company = ?').run(c);
        db.prepare('DELETE FROM sales_lines_daily WHERE company = ?').run(c);
      }
      for (const [key, v] of inv) {
        const [company, ym, cust, slm] = key.split('\u0001');
        insInv.run(company, ym, cust, slm, v.amount, v.invoice_count, v.cn_count, v.cn_amount, v.vat_amount, v.amount + v.vat_amount, v.cn_vat);
      }
      for (const [key, v] of lines) {
        const [company, ym, cust, slm, sku, unit] = key.split('\u0001');
        insLine.run(company, ym, cust, slm, sku, unit, v.qty, v.qty_base, v.amount);
      }
      for (const [key, v] of invDaily) {
        const [company, day, cust, slm] = key.split('\u0001');
        insInvDaily.run(company, day, cust, slm, v.amount, v.invoice_count);
      }
      for (const [key, v] of linesDaily) {
        const [company, day, cust, slm, sku, unit] = key.split('\u0001');
        insLineDaily.run(company, day, cust, slm, sku, unit, v.qty, v.qty_base, v.amount);
      }
      for (const c of data.customers) upCust.run(custCodeOf(c.code), c.name || '', c.slmn || '', c.ic ? 1 : 0, c.has_export ? 1 : 0);
      // ตาราง SALESMAN ของ Bplus มีรายการที่ไม่ใช่คน (เช่น สาขาบิ๊กซี B01–B9x) — เก็บเฉพาะรหัสที่ผูกกับลูกค้าที่มียอดจริง
      const usedSlm = new Set(data.customers.map((c) => c.slmn).filter(Boolean));
      for (const s of data.salesmen) if (s.code && usedSlm.has(s.code)) upSlm.run(s.code, s.name || '');
      const usedSku = new Set(data.lines.map((l) => l.sku));
      const upSku = db.prepare(`INSERT INTO bplus_skus (code, name, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(code) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`);
      for (const s of data.skus || []) if (s.code && usedSku.has(s.code)) upSku.run(s.code, s.name || '');
      db.prepare(`INSERT INTO sync_file_state (source, mtime_ms, synced_at) VALUES (?, NULL, ?)
        ON CONFLICT(source) DO UPDATE SET synced_at = excluded.synced_at`).run(STATE_KEY, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const n = inv.size + lines.size;
    db.prepare("UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'ok', rows_processed = ? WHERE id = ?").run(n, log.lastInsertRowid);
    console.log(`[importFromBplus] ${inv.size} invoice rows, ${lines.size} line rows, ${data.customers.length} customers`);
    return n;
  } catch (e) {
    console.error('[importFromBplus] failed:', e.message);
    db.prepare("UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'error', message = ? WHERE id = ?").run(String(e.message).slice(0, 500), log.lastInsertRowid);
    return 0;
  }
}

module.exports = { runBplusImport, bplusConfigured, fetchFromBplus, COMPANY, COMPANY_IC };
