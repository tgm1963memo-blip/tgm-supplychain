'use strict';

// เล่มเอกสาร Express ที่ไม่นับเป็นยอดขาย — ใช้ร่วมกันทั้งตอนดึงยอด (jobs/importFromExpress.js) และตอนอ่านหัวใบ/บรรทัด
// (routes/invoiceDetail.js) ให้ยอดรวม รายสินค้า และ pivot ตัดชุดเดียวกัน
//   · LF / LE / LG — บัญชียืนยันว่าไม่ใช่รายได้จากการขาย (เดิม)
//   · IT / IV (2026-10-20, ผู้ใช้สั่ง "ใบค่าขนส่งและวัสดุ ไม่นับมารวมคำนวน"): IT = ค่าขนส่ง (30383) · IV = ขายวัสดุ
//     (กล่องโฟม 45000, น้ำแข็งแห้ง 46000, ขายวัสดุอุปกรณ์ 48000, กระเป๋าเก็บความเย็น) — ตรวจแล้วไม่มีใบ IV ที่ปนสินค้าขาย
//     ไฟล์ Group ของเซลล์ฝ่ายขายร้านค้าก็ไม่นับสองเล่มนี้ · ยังคงอยู่ในตาราง invoices (หน้าจ่ายสินค้าตามใบกำกับของ tgm-wms)
const NON_SALES_DOC_PREFIXES = ['LF', 'LE', 'LG', 'IT', 'IV'];
const NON_SALES_SET = new Set(NON_SALES_DOC_PREFIXES);

function isNonSalesDocNum(docNum) {
  return NON_SALES_SET.has(String(docNum || '').trim().toUpperCase().slice(0, 2));
}
// SQL: เลขเอกสารในคอลัมน์ col ไม่ใช่เล่มที่ไม่นับยอด (ค่าคงที่ ไม่มี parameter)
function salesDocSql(col = 'doc_num') {
  return `UPPER(SUBSTR(TRIM(${col}), 1, 2)) NOT IN (${NON_SALES_DOC_PREFIXES.map(p => `'${p}'`).join(', ')})`;
}

module.exports = { NON_SALES_DOC_PREFIXES, isNonSalesDocNum, salesDocSql };
