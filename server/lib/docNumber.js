'use strict';

// เลขที่เอกสารแบบรันรายเดือน (2026-10-05) — แนวทางเดียวกับ nextCodeNo() ใน lib/promoNumber.js แต่ใช้ได้กับตารางอื่น
// รูปแบบ <prefix><พ.ศ.>-<เดือน 2 หลัก>-<ลำดับ 3 หลัก> เช่น SN2569-10-001 · ลำดับนับต่อจากเลขสูงสุดของเดือนนั้น
// ต้องเรียกภายใน transaction แบบ BEGIN IMMEDIATE (ผู้เรียกจัดการ) เพื่อกันสองคำขอได้เลขเดียวกัน
// table/col มาจากโค้ดเท่านั้น ห้ามรับจาก request (ใช้เป็นชื่อตารางใน SQL)
function monthPart(date = new Date()) {
  const be = date.getFullYear() + 543;
  return `${be}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextDocNo(db, table, col, prefix, date = new Date()) {
  const head = `${prefix}${monthPart(date)}-`;
  const row = db.prepare(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(`${head}%`);
  const last = row && row.no ? Number(String(row.no).slice(head.length)) || 0 : 0;
  return `${head}${String(last + 1).padStart(3, '0')}`;
}

module.exports = { nextDocNo, monthPart };
