const { attachmentRoutes } = require('../lib/attachments');
const { requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const express = require('express');
const { logDraft } = require('../lib/promoLog');
module.exports = (db, writeRoles) => {
  // log แนบ/ลบไฟล์ (2026-09-30) — ครอบ router ไฟล์แนบกลาง: จับชื่อไฟล์/เอกสารก่อนลบ แล้วเขียน log เมื่อสำเร็จ
  const router = express.Router();
  router.use((req, res, next) => {
    let pre = null;
    if (req.method === 'DELETE') pre = db.prepare('SELECT draft_no, filename FROM promo_draft_attachments WHERE id = ?').get(req.path.slice(1));
    res.on('finish', () => {
      if (res.statusCode >= 300 || !req.user) return;
      try {
        if (req.method === 'DELETE' && pre) logDraft(db, pre.draft_no, 'detach', req.user, { filename: pre.filename });
        else if (req.method === 'POST' && /^\/[^/]+$/.test(req.path)) logDraft(db, req.path.slice(1), 'attach', req.user, { filename: req.file?.originalname || req.body?.filename || '' });
        else if (req.method === 'POST' && /\/copy-from\//.test(req.path)) logDraft(db, req.path.split('/')[1], 'copy_attachments', req.user, { from: req.path.split('/')[3] });
      } catch (e) { console.warn('[promoLog]', e.message); }
    });
    next();
  });
  router.use(attachmentRoutes(db, writeRoles, { table: 'promo_draft_attachments', parent: 'draft_no', param: 'draftNo', prefix: 'PDA' }));
  // "คัดลอกจากเอกสารเดิม" (2026-09-24): คัดลอกไฟล์แนบทั้งหมดของเอกสารต้นทางไปเอกสารใหม่ฝั่ง server (BLOB เดิม)
  // ปลายทางต้องมีอยู่และยังแก้ไขได้ (ร่าง/ไม่อนุมัติ) — กันคัดลอกไฟล์เข้าเอกสารที่ส่งอนุมัติไปแล้ว
  router.post('/:draftNo/copy-from/:src', requireRole(...writeRoles), (req, res) => {
    const target = db.prepare('SELECT status FROM promo_draft_headers WHERE draft_no = ?').get(req.params.draftNo);
    if (!target) return res.status(404).json({ error: 'ไม่พบเอกสารปลายทาง' });
    if (!['draft', 'rejected', null, ''].includes(target.status)) return res.status(400).json({ error: 'เอกสารปลายทางไม่อยู่ในสถานะที่แก้ไขได้' });
    if (req.params.src === req.params.draftNo) return res.status(400).json({ error: 'ต้นทางและปลายทางเป็นเอกสารเดียวกัน' });
    const rows = db.prepare('SELECT filename, mime_type, content, note FROM promo_draft_attachments WHERE draft_no = ? ORDER BY created_at').all(req.params.src);
    const insert = db.prepare('INSERT INTO promo_draft_attachments (id, draft_no, filename, mime_type, content, note, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const r of rows) insert.run(genId('PDA'), req.params.draftNo, r.filename, r.mime_type, r.content, r.note, req.user.uid);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.status(201).json({ copied: rows.length });
  });
  return router;
};
