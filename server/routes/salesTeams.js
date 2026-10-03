const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const st = require('../lib/salesTeams');

// ทีมขาย + สิทธิ์ดูยอดขาย (2026-10-03) — ดู lib/salesTeams.js
//   GET  /api/sales_teams/me     สิทธิ์ของผู้ใช้ที่ login (รหัส Sales ที่ดูได้ + ตัวเลือกกรองตามทีม)
//   GET  /api/sales_teams        การตั้งค่า + รายชื่อผู้ใช้พร้อมสิทธิ์ที่มีผล (หน้าตั้งค่า)
//   PUT  /api/sales_teams        บันทึกทีม/สิทธิ์รายคน + รหัส Sales ของผู้ใช้ (admin/superadmin)
module.exports = function salesTeamsRoutes(db) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/me', (req, res) => {
    const cfg = st.loadConfig(db), users = st.usersOf(db);
    const sc = st.scopeFor(db, req.user.uid, cfg, users);
    res.json({ ...sc, filters: st.teamFilters(cfg, users, sc) });
  });

  router.get('/', (req, res) => {
    const cfg = st.loadConfig(db), users = st.usersOf(db);
    res.json({
      teams: cfg.teams, scopes: cfg.scopes, saved: cfg.saved,
      users: users.filter(u => u.is_active !== 0 && u.role !== 'service_readonly').map(u => {
        const sc = st.scopeFor(db, u.uid, cfg, users);
        return { uid: u.uid, name: u.name, role: u.role, department: u.department || '', position: u.position || '', slm_codes: st.codesOf(u).join(','),
          scope: sc.scope, source: sc.source, default_scope: st.defaultScope(u, cfg.teams), members: cfg.scopes[u.uid]?.members || [], scope_teams: cfg.scopes[u.uid]?.teams || [] };
      }),
    });
  });

  router.put('/', requireRole('admin', 'superadmin'), (req, res) => {
    const body = req.body || {};
    const cfg = { teams: body.teams, scopes: {} };
    const known = new Set(st.usersOf(db).map(u => u.uid));
    for (const [uid, s] of Object.entries(body.scopes || {})) {
      if (!known.has(uid) || !s?.scope) continue; // ไม่ได้ตั้ง = ค่าเริ่มต้นตามตำแหน่ง
      cfg.scopes[uid] = { scope: s.scope, ...(s.scope === 'members' ? { members: [...new Set((s.members || []).map(String))].filter(x => known.has(x) && x !== uid) } : {}),
        ...(s.scope === 'teams' ? { teams: [...new Set((Array.isArray(s.teams) ? s.teams : []).map(String))] } : {}) };
    }
    const err = st.validateConfig(cfg);
    if (err) return res.status(400).json({ error: err });
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`INSERT INTO approval_workflow_templates (entity_type, levels_json, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(st.ENTITY, JSON.stringify(cfg), req.user.uid);
      // รหัส Sales ใน Express ของผู้ใช้ (ผูกจากหน้านี้ได้ — เช่นจับคู่จากชื่อเล่น)
      const up = db.prepare("UPDATE sc_users SET slm_codes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uid = ?");
      for (const [uid, v] of Object.entries(body.slm_codes || {})) {
        if (!known.has(uid)) continue;
        const list = [...new Set(String(v ?? '').split(',').map(x => x.trim()).filter(Boolean))];
        up.run(list.length ? list.join(',') : null, uid);
      }
      db.exec('COMMIT');
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    res.json({ ok: true });
  });
  return router;
};
