'use strict';

// ชื่อสาขาจากที่อยู่จัดส่งในใบกำกับ (invoices.ship_to_address) — 2026-10-12 (ผู้ใช้ขอให้ทุกสาขาขึ้นชื่อ ไม่ใช่แค่รหัส)
// ลำดับ: "สาขา X" → ชื่อในวงเล็บช่วงต้นที่อยู่ เช่น "บิ๊กซี(สามย่านมิตรทาวน์)", "ซีพีแรม (ลาดกระบัง)"
//        → แขวง/ตำบลที่ส่งของ เป็น "ส่ง <แขวง>" (บอกที่ส่ง เมื่อไม่มีชื่อสาขาให้ใช้)
const clean = v => String(v || '').replace(/[ �]/g, ' ').replace(/\s+/g, ' ').trim();
const JUNK = /ประเทศไทย|มหาชน|สำนักงานใหญ่|จำกัด|บจก|บมจ|ห้อง|ชั้น|อาคาร|ฝั่ง|โทร|^\d[\d\s/-]*$|^[A-Z]?\d+$/i;

function parseShipBranch(addr) {
  const a = clean(addr);
  if (!a) return null;
  let m = a.match(/\(\s*สาขา\s*(?:ที่\s*)?([^)]+?)\s*\)|สาขา\s*(?:ที่\s*)?([^\s,()]+(?:\s+\d+)?)/);
  if (m) {
    const v = clean(m[1] || m[2]).replace(/[.,:;\s-]+$/, '');
    if (v && !/^\d+$/.test(v) && !/^(ที่|เลขที่)$/.test(v)) return v;
  }
  // วงเล็บใน 80 ตัวอักษรแรก (ชื่อผู้รับ + ชื่อสาขา) — ไม่ใช่คำทั่วไปของชื่อบริษัท/เลขห้อง
  for (const p of a.slice(0, 80).matchAll(/\(([^()]{2,40})\)/g)) {
    const v = clean(p[1]);
    if (v && !JUNK.test(v)) return v;
  }
  m = a.match(/แขวง\s*([^\s,()]+)|ตำบล\s*([^\s,()]+)|ต\.\s*([^\s,()]+)/);
  if (m) { const v = clean(m[1] || m[2] || m[3]); if (v) return `ส่ง ${v}`; }
  return null;
}

// รหัสลูกค้า → ชื่อสาขา จากใบกำกับล่าสุดที่อ่านได้
function shipBranchMap(db) {
  const out = {};
  const rows = db.prepare(`SELECT cust_code, ship_to_address FROM invoices WHERE ship_to_address IS NOT NULL AND TRIM(ship_to_address) <> '' ORDER BY doc_date DESC`).all();
  for (const r of rows) {
    if (out[r.cust_code] !== undefined) continue;
    const v = parseShipBranch(r.ship_to_address);
    if (v) out[r.cust_code] = v;
  }
  return out;
}

module.exports = { parseShipBranch, shipBranchMap };
