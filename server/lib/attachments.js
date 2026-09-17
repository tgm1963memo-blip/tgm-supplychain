const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('./crud');
const { contentMatchesDeclaredType } = require('./fileSignature');

const types = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) { cb(types.has(file.mimetype) ? null : new Error('INVALID_FILE_TYPE'), types.has(file.mimetype)); },
}).single('file');

function uploadFile(req, res, next) {
  upload(req, res, error => {
    if (error) {
      if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ไฟล์ใหญ่เกินไป (จำกัด 15MB ต่อไฟล์)' });
      if (error.message === 'INVALID_FILE_TYPE') return res.status(400).json({ error: 'รองรับเฉพาะไฟล์รูปภาพ (JPG/PNG/GIF/WEBP) หรือ PDF เท่านั้น' });
      if (error instanceof multer.MulterError) return res.status(400).json({ error: `อัปโหลดไฟล์ไม่สำเร็จ: ${error.message}` });
      return next(error);
    }
    if (!req.file) return res.status(400).json({ error: 'file is required (multipart field "file")' });
    if (!contentMatchesDeclaredType(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'เนื้อไฟล์ไม่ตรงกับชนิดไฟล์ที่แนบ กรุณาตรวจสอบไฟล์อีกครั้ง' });
    next();
  });
}

// Configuration is code-owned; never use request values as SQL identifiers.
function attachmentRoutes(db, writeRoles, { table, parent, param, prefix, slot = false }) {
  const router = express.Router();
  router.use(requireAuth(db));
  const fields = `id, ${parent}, ${slot ? 'slot_id,' : ''} filename, mime_type, length(content) AS size_bytes, note, uploaded_by, created_at`;
  router.get('/', (req, res) => {
    if (!req.query[parent]) return res.status(400).json({ error: `${parent} is required` });
    res.json(db.prepare(`SELECT ${fields} FROM ${table} WHERE ${parent}=? ORDER BY created_at`).all(req.query[parent]));
  });
  router.get('/:id/content', (req, res) => {
    const row = db.prepare(`SELECT filename,mime_type,content FROM ${table} WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    res.send(Buffer.from(row.content));
  });
  router.post(`/:${param}`, requireRole(...writeRoles), uploadFile, (req, res) => {
    if (slot && !req.body.slotId) return res.status(400).json({ error: 'slotId is required' });
    const id = genId(prefix);
    const cols = ['id', parent, ...(slot ? ['slot_id'] : []), 'filename', 'mime_type', 'content', 'note', 'uploaded_by'];
    const values = [id, req.params[param], ...(slot ? [req.body.slotId] : []), req.file.originalname, req.file.mimetype, req.file.buffer, req.body.note || null, req.user.uid];
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
    res.status(201).json(db.prepare(`SELECT ${fields} FROM ${table} WHERE id=?`).get(id));
  });
  router.delete('/:id', requireRole(...writeRoles), (req, res) => {
    if (!db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id).changes) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  });
  return router;
}
module.exports = { attachmentRoutes };
