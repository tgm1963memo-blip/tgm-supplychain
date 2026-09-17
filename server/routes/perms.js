const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');

// Backs the pgPerms() admin UI (index.html:8455) and the global "disable this function
// for everyone" toggle. Everything here now lives in SQLite instead of per-browser
// localStorage, so a change an admin makes is visible to every PC immediately.
module.exports = function permsRoutes(db) {
  const router = express.Router();

  // Any authenticated user needs to read these to build their own sidebar.
  router.get('/deptpos', requireAuth(db), (req, res) => {
    const rows = db.prepare('SELECT group_key, pages_json FROM nav_perms_deptpos').all();
    const out = {};
    for (const r of rows) out[r.group_key] = JSON.parse(r.pages_json);
    res.json(out);
  });

  router.get('/roles', requireAuth(db), (req, res) => {
    const rows = db.prepare('SELECT role_id, label, pages_json, is_custom FROM nav_roles').all();
    res.json(rows.map((r) => ({ ...r, pages: JSON.parse(r.pages_json) })));
  });

  router.get('/feature-flags', requireAuth(db), (req, res) => {
    const rows = db.prepare('SELECT page_id, enabled FROM feature_flags').all();
    const out = {};
    for (const r of rows) out[r.page_id] = !!r.enabled;
    res.json(out);
  });

  // writes are admin-only
  router.use(requireAuth(db), requireRole('superadmin', 'admin'));

  router.put('/deptpos/:groupKey', (req, res) => {
    const { pages } = req.body || {};
    if (!Array.isArray(pages)) return res.status(400).json({ error: 'pages must be an array of page ids' });
    db.prepare(`
      INSERT INTO nav_perms_deptpos (group_key, pages_json, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(group_key) DO UPDATE SET pages_json = excluded.pages_json,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(req.params.groupKey, JSON.stringify(pages), req.user.uid);
    db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
      .run(req.user.uid, req.user.role, 'SAVE_PERMS', req.params.groupKey);
    res.status(204).end();
  });

  router.put('/roles/:roleId', (req, res) => {
    const { label, pages } = req.body || {};
    if (!label || !Array.isArray(pages)) return res.status(400).json({ error: 'label and pages are required' });
    db.prepare(`
      INSERT INTO nav_roles (role_id, label, pages_json, updated_by, updated_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(role_id) DO UPDATE SET label = excluded.label, pages_json = excluded.pages_json,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(req.params.roleId, label, JSON.stringify(pages), req.user.uid);
    db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
      .run(req.user.uid, req.user.role, 'SAVE_ROLE', req.params.roleId);
    res.status(204).end();
  });

  router.delete('/roles/:roleId', (req, res) => {
    db.prepare('DELETE FROM nav_roles WHERE role_id = ?').run(req.params.roleId);
    res.status(204).end();
  });

  // global hide switch — disables a page for every user, on top of per-role visibility
  router.put('/feature-flags/:pageId', (req, res) => {
    const { enabled } = req.body || {};
    db.prepare(`
      INSERT INTO feature_flags (page_id, enabled, updated_by, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(page_id) DO UPDATE SET enabled = excluded.enabled,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(req.params.pageId, enabled ? 1 : 0, req.user.uid);
    db.prepare('INSERT INTO audit_log (uid, role, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.uid, req.user.role, 'TOGGLE_FEATURE', req.params.pageId, JSON.stringify({ enabled: !!enabled }));
    res.status(204).end();
  });

  return router;
};
