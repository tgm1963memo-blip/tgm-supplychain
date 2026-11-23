'use strict';

// ลูกค้าที่ไม่นับเป็นยอดขาย — ตัดออกจากทุกหน้า (2026-10-14, ผู้ใช้ขอ: บริษัทในเครือ 3 กลุ่ม "รวมถึง shop ไม่ต้องเอามารวมเป็นยอดขายเลย")
//   บริษัทในเครือ: corporate มีคำว่า "(บริษัทในเครือ)" (ไทย-เยอรมัน มีท โปรดักท์ / ไทยซอสเซส / ทีจี โคลด์ สตอเรจ) + ลูกค้า Bplus ที่ติดธง is_intercompany
//   Shop ของบริษัท: หมวดผู้บริหาร shop_factory / shop_rama3 หรือ corporate เป็น TGM Shop / TGM. SHOP / Shop โรงงาน
//   (2026-10-14 เพิ่ม ผู้ใช้เลือก) พนักงานซื้อ / เบิกตัวอย่าง / ออกบูธ / ทีจีเอ็ม + ได้รายเบ็ดเตล็ด / Shop บริษัท —
//   ประเภทธุรกิจ employee / other / affiliate / company_shop หรือกลุ่มลูกค้า (category) ชุดเดียวกัน
// ใช้ร่วมกันทุก endpoint ยอดขาย (invoice_sales_* / v_sales_overview / invoice_detail pivot / Dashboard / Dashboard ผู้บริหาร)
// ผ่าน excludeSql() · แคช 60 วิ (ตั้งกลุ่มใหม่ในหน้าจัดการกลุ่มแล้วมีผลภายใน 1 นาที)
const TTL_MS = 60 * 1000;
let cache = { at: 0, codes: null, json: '[]' };

function nonSalesCodes(db) {
  if (cache.codes && Date.now() - cache.at < TTL_MS) return cache.codes;
  const codes = new Set();
  for (const r of db.prepare(`SELECT code FROM customer_profiles
      WHERE corporate LIKE '%(บริษัทในเครือ)%'
         OR exec_channel IN ('shop_factory', 'shop_rama3')
         OR corporate LIKE 'TGM Shop%' OR corporate LIKE 'TGM. SHOP%' OR corporate LIKE 'Shop โรงงาน%'
         OR business_type IN ('employee', 'other', 'affiliate', 'company_shop')
         OR category IN ('พนักงาน', 'เบิกตัวอย่าง', 'ออกบูธ', 'ไทย-เยอรมัน', 'ได้รายเบ็ดเตล็ด/บริหารจัดการ')`).all()) codes.add(r.code);
  try {
    for (const r of db.prepare('SELECT code FROM bplus_customers WHERE is_intercompany = 1').all()) codes.add(r.code);
  } catch { /* ยังไม่มีตาราง Bplus */ }
  cache = { at: Date.now(), codes, json: JSON.stringify([...codes]) };
  return codes;
}

// เงื่อนไข SQL "ไม่ใช่ลูกค้าที่ไม่นับยอด" สำหรับคอลัมน์รหัสลูกค้า col
function excludeSql(db, col = 'cust_code') {
  nonSalesCodes(db);
  return { sql: `${col} NOT IN (SELECT value FROM json_each(?))`, params: [cache.json] };
}

// รวมกับเงื่อนไขสิทธิ์ (factSql/custSql ที่อาจเป็น null) → {sql, params} เสมอ
function withExclude(db, scopeSql, col = 'cust_code') {
  const ex = excludeSql(db, col);
  if (!scopeSql) return ex;
  return { sql: `(${scopeSql.sql}) AND ${ex.sql}`, params: [...scopeSql.params, ...ex.params] };
}

function resetNonSalesCache() { cache = { at: 0, codes: null, json: '[]' }; }

module.exports = { nonSalesCodes, excludeSql, withExclude, resetNonSalesCache };
