const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');

// PO-by-email import — see jobs/importPoFromEmail.js for how po_emails gets populated. tgm-wms's
// PoDocumentsPage lists 'new' rows, lets a Planner pick one + a supplier, fetches the attachment
// bytes, and runs it through the exact same extractPoDocument() review flow as a manual upload.
module.exports = function poEmailsRoutes(db, writeRoles) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    const status = req.query.status || 'new';
    const rows = db.prepare(`
      SELECT id, subject, from_addr, received_at, filename, mime_type, length(content) AS size_bytes, status, created_at
      FROM po_emails WHERE status = ? ORDER BY received_at DESC LIMIT 200
    `).all(status);
    res.json(rows);
  });

  router.get('/:id/attachment', (req, res) => {
    const row = db.prepare('SELECT filename, mime_type, content FROM po_emails WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    res.send(Buffer.from(row.content));
  });

  // FIXED (2026-09-13, /code-review): this PATCH had no requireRole check — any authenticated
  // bearer token, including a low-trust read-only service account, could mark every pending PO
  // email as ignored, silently hiding real incoming customer POs with no audit trail.
  router.patch('/:id', requireRole(...writeRoles), (req, res) => {
    const status = req.body?.status;
    if (!['imported', 'ignored', 'new'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const result = db.prepare('UPDATE po_emails SET status = ? WHERE id = ?').run(status, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return router;
};
