'use strict';

// จัดกลุ่มลูกค้าใหม่อัตโนมัติหลังซิงค์ (2026-10-14, ผู้ใช้ขอ "รวมลูกค้าเข้ากลุ่มให้เรียบร้อย")
// ลูกค้าที่เพิ่งมียอดแต่ยังไม่มี corporate ใน customer_profiles หน้าเว็บตกไปใช้รหัสกลุ่มเก่าของ Express (CUST_GROUPS:
// FF/BB/HH …) หรือ "ยังไม่ถูกระบุ" — เช่น 30-PL-0021 เซ็นทรัล ฟู้ด รีเทล สาขานวมินทร์ (มียอดครั้งแรก ต.ค. 2026) ขึ้นเป็น "FF"
// กฎ (ไม่ทับค่าที่มีอยู่ เติมเฉพาะช่องว่าง):
//   corporate: ลูกค้าที่ขึ้นต้นรหัสเดียวกัน (2 ส่วนแรก เช่น 30-PL) ≥ 3 ราย และ ≥ 70% ใช้ corporate เดียวกัน → ใช้ค่านั้น
//              ไม่งั้นใช้ชื่อบริษัทของลูกค้าเอง (ตัดคำนำหน้านิติบุคคล / สาขา)
//   Category (Sales): ลูกค้า corporate เดียวกันส่วนใหญ่ (≥ 70%) ใช้ค่าไหน → ค่านั้น · ไม่มีก็ว่างไว้ให้เซลล์ตั้ง
// ไม่จัดยอดในเครือ (BP-TGM-IC) — บริษัทในเครือแยกยอดไว้แล้ว
const SHARE = 0.7;
const MIN_SIBLINGS = 3;

function companyName(name) {
  return String(name || '')
    .replace(/[\s ]+/g, ' ')
    .replace(/บริษัท|ห้างหุ้นส่วน(จำกัด|สามัญ)?|จำกัด|\(มหาชน\)|มหาชน/g, ' ')
    .replace(/\(?\s*(สำนักงานใหญ่|สาขา[^)]*)\)?\s*$/, ' ')
    .replace(/\s+/g, ' ').trim();
}

function majority(values) {
  const c = new Map();
  for (const v of values) if (v) c.set(v, (c.get(v) || 0) + 1);
  const top = [...c].sort((a, b) => b[1] - a[1])[0];
  return top && values.length >= MIN_SIBLINGS && top[1] / values.length >= SHARE ? top[0] : null;
}

function autoGroupNewCustomers(db, { since } = {}) {
  const from = since || new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 7);
  const todo = db.prepare(`SELECT DISTINCT i.cust_code AS code FROM invoice_sales_monthly i
    LEFT JOIN customer_profiles p ON p.code = i.cust_code
    WHERE i.ym >= ? AND i.company <> 'BP-TGM-IC' AND i.cust_code NOT IN ('', '(none)', '(ไม่ระบุ)')
      AND COALESCE(TRIM(p.corporate), '') = ''`).all(from).map((r) => r.code);
  if (!todo.length) return { updated: 0, items: [] };
  const profs = db.prepare(`SELECT code, corporate, sales_category FROM customer_profiles WHERE COALESCE(TRIM(corporate), '') <> ''`).all();
  const byPrefix = new Map();
  const byCorp = new Map();
  for (const p of profs) {
    const pre = p.code.split('-').slice(0, 2).join('-');
    (byPrefix.get(pre) || byPrefix.set(pre, []).get(pre)).push(p.corporate.trim());
    (byCorp.get(p.corporate.trim()) || byCorp.set(p.corporate.trim(), []).get(p.corporate.trim())).push(String(p.sales_category || '').trim());
  }
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, corporate, corp_source, sales_category, edited_by, updated_at)
    VALUES (?, ?, ?, 'auto', ?, 'auto-group', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate, corp_source = 'auto',
      sales_category = COALESCE(NULLIF(TRIM(customer_profiles.sales_category), ''), excluded.sales_category),
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name), updated_at = excluded.updated_at
    WHERE COALESCE(TRIM(customer_profiles.corporate), '') = ''`);
  const items = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const code of todo) {
      const nm = nameOf.get(code, code);
      const name = nm.c || nm.b || '';
      const pre = code.split('-').slice(0, 2).join('-');
      const corp = majority(byPrefix.get(pre) || []) || companyName(name);
      if (!corp) continue;
      const cats = (byCorp.get(corp) || []).filter(Boolean);
      const cat = cats.length >= MIN_SIBLINGS ? majority(cats) : null;
      if (upsert.run(code, nm.c ? null : (nm.b || null), corp, cat).changes) items.push({ code, corporate: corp, sales_category: cat });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { updated: items.length, items };
}

module.exports = { autoGroupNewCustomers, companyName };
