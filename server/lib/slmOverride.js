'use strict';

// กำหนด Sales เจ้าของยอดรายลูกค้า (2026-10-20, ผู้ใช้สั่ง "ยอดขายของคุณปู ให้เอา TOP 30-LC-0013 ออก → ย้ายไปเป็นของ 207")
// ใบกำกับของลูกค้าในตาราง sales_slm_override นับเป็นยอดของ slm_code ที่ตั้งไว้ แทนรหัส Sales ในใบ (Express)
// ใช้ตอนดึงยอดจาก Express (jobs/importFromExpress.js) และ Bplus โรงงาน TGM (jobs/importFromBplus.js, 2026-10-22):
//   invoice_sales_monthly/daily, sales_lines_*, invoice_heads, bplus_invoices
// → ทุกหน้า (Dashboard / Sales Overview / pivot / รายสินค้า / สิทธิ์การเห็น) ได้ตัวเลขชุดเดียวกัน · มีผลรอบ sync ถัดไป (สร้างใหม่ทั้งประวัติ)
// ไม่แตะตาราง invoices (หน้าจ่ายสินค้าตามใบกำกับของ tgm-wms ต้องเห็นรหัสในใบจริง)
function loadSlmOverrides(db) {
  try {
    return new Map(db.prepare("SELECT cust_code, slm_code FROM sales_slm_override WHERE COALESCE(TRIM(slm_code), '') <> ''").all()
      .map(r => [String(r.cust_code).trim().toUpperCase(), String(r.slm_code).trim()]));
  } catch { return new Map(); } // ยังไม่มีตาราง (ก่อน migration)
}
// รหัส Sales ที่ใช้นับยอด: รหัสที่กำหนดไว้ของลูกค้านั้น ไม่มี = รหัสในใบ
function effectiveSlm(overrides, custCode, slmCode) {
  return overrides.get(String(custCode || '').trim().toUpperCase()) || slmCode;
}

// เจ้าของยอดรายสินค้าของลูกค้า (2026-10-27, ผู้ใช้สั่ง "Tops 30-LC-0013/0014 อยู่กับลักษณา เฉพาะสินค้าเบเกอรี่")
// sales_slm_sku_override ชนะ sales_slm_override — สินค้าอื่นของลูกค้าเดียวกันยังตามรหัสรายลูกค้า/รหัสในใบ
// ยอดรายสินค้า (sales_lines_*) ใช้ตรงบรรทัด · ยอดหัวใบ (invoice_sales_*, ARTRN ไม่มีสินค้า) แบ่งยอดบรรทัดของสินค้านั้นจาก
// invoice_lines ไปให้รหัสที่กำหนด ส่วนที่เหลือของใบคงอยู่กับเจ้าของเดิม → ยอดรวมของลูกค้าเท่าเดิม
// คืน Map<CUST, Map<SKU, slm>>
function loadSlmSkuOverrides(db) {
  const out = new Map();
  try {
    for (const r of db.prepare("SELECT cust_code, sku, slm_code FROM sales_slm_sku_override WHERE COALESCE(TRIM(slm_code), '') <> ''").all()) {
      const c = String(r.cust_code).trim().toUpperCase();
      if (!out.has(c)) out.set(c, new Map());
      out.get(c).set(String(r.sku).trim().toUpperCase(), String(r.slm_code).trim());
    }
  } catch { /* ยังไม่มีตาราง (ก่อน migration) */ }
  return out;
}
// รหัส Sales ของบรรทัดสินค้า: รายสินค้า → รายลูกค้า → รหัสในใบ
function effectiveSlmSku(overrides, skuOverrides, custCode, sku, slmCode) {
  const m = skuOverrides.get(String(custCode || '').trim().toUpperCase());
  return (m && m.get(String(sku || '').trim().toUpperCase())) || effectiveSlm(overrides, custCode, slmCode);
}

module.exports = { loadSlmOverrides, effectiveSlm, loadSlmSkuOverrides, effectiveSlmSku };
