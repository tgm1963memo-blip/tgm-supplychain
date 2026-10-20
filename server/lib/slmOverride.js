'use strict';

// กำหนด Sales เจ้าของยอดรายลูกค้า (2026-10-20, ผู้ใช้สั่ง "ยอดขายของคุณปู ให้เอา TOP 30-LC-0013 ออก → ย้ายไปเป็นของ 207")
// ใบกำกับของลูกค้าในตาราง sales_slm_override นับเป็นยอดของ slm_code ที่ตั้งไว้ แทนรหัส Sales ในใบ (Express)
// ใช้ตอนดึงยอดจาก Express (jobs/importFromExpress.js): invoice_sales_monthly/daily, sales_lines_*, invoice_heads
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

module.exports = { loadSlmOverrides, effectiveSlm };
