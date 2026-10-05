const { attachmentRoutes } = require('../lib/attachments');

// ไฟล์แนบของคำขอของตัวอย่าง (รูปสินค้า / ไฟล์สเปค, 2026-10-05) — ใช้ตัวจัดการไฟล์แนบกลางแบบเดียวกับใบเคาะ
module.exports = (db, writeRoles) =>
  attachmentRoutes(db, writeRoles, { table: 'sample_request_attachments', parent: 'request_id', param: 'requestId', prefix: 'SRA' });
