'use strict';

// URL สาธารณะของ server นี้ (ย้ายมาจาก routes/promoDraftHeaders.js 2026-11-13 ให้รายงาน LINE ใช้ร่วม)
// PUBLIC_API_URL ถ้าตั้งไว้ ไม่งั้นใช้ API URL ที่หน้าเว็บใช้ (deploy-shared/api-config.js — อ่านใหม่ทุกครั้ง
// เพราะ URL ของ tunnel เปลี่ยนได้โดยไม่ restart server)
// FIXED (2026-10-28, security review): เดิม fallback เป็น Host / X-Forwarded-Proto ของ request — ผู้ใช้ปลอม header
// ให้ลิงก์อนุมัติในอีเมลชี้ไปโดเมนของตัวเอง แล้วขโมย token อนุมัติได้ · ห้ามใช้ค่าจาก request สร้างลิงก์
function publicBaseUrl() {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  const cfgPath = require.resolve('../../deploy-shared/api-config');
  delete require.cache[cfgPath];
  return require(cfgPath).getApiBase();
}

module.exports = { publicBaseUrl };
