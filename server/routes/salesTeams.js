const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const st = require('../lib/salesTeams');
const cs = require('../lib/customerScope');
const { loadCodeMap } = require('../lib/promoNumber');

// ชื่อเล่นของผู้ใช้ = ข้อความในวงเล็บท้ายชื่อ เช่น "คุณหทัยกาญจน์ แซ่เซียว (คุณเมย์)" → "เมย์" (ตัด "คุณ")
const nickKey = v => String(v || '').replace(/^\s*คุณ\s*/, '').replace(/\s+/g, '').trim();
const nickOf = name => { const m = String(name || '').match(/\(([^()]+)\)\s*$/); return m ? nickKey(m[1]) : ''; };
const MGR_ROLES = new Set(['sales_manager', 'manager', 'admin', 'superadmin']);
// คำแนะนำจับคู่ชื่อในไฟล์ → ผู้ใช้: ชื่อเล่นตรงตัวก่อน (หลายคน = เลือกตามบทบาท: คอลัมน์ผู้จัดการเลือก manager,
// คอลัมน์เซลล์เลือกที่ไม่ใช่ manager) · ไม่ตรงเลย = ขึ้นต้นเหมือนกัน (เช่น ตุ๊ก ↔ ตุ๊กตา) ระดับ "ใกล้เคียง"
function suggest(users, role, name) {
  const k = nickKey(name);
  if (!k) return null;
  const pick = list => {
    if (list.length <= 1) return list[0] || null;
    const pref = list.filter(u => role === 'mgr' ? MGR_ROLES.has(u.role) : !MGR_ROLES.has(u.role));
    return pref.length === 1 ? pref[0] : null;
  };
  const exact = users.filter(u => nickOf(u.name) === k);
  const e = pick(exact);
  if (e) return { uid: e.uid, conf: exact.length > 1 ? 'role' : 'exact' };
  if (exact.length) return null;
  const near = users.filter(u => { const n = nickOf(u.name); return n && (n.startsWith(k) || k.startsWith(n)); });
  const p = pick(near);
  return p ? { uid: p.uid, conf: 'near' } : null;
}

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
    // สิทธิ์ที่ server บังคับจริง (2026-10-06, lib/customerScope.js) — restricted = server กรองข้อมูลให้แล้ว
    const vs = cs.resolveScope(db, req.user);
    // รายชื่อผู้ใช้พร้อมรหัสทั้งหมด (Express + Bplus 'BP-xx') สำหรับตัวกรองพนักงานขาย — เลือกคน = ยอดของทุกรหัสที่ผูกกับคนนั้น (2026-10-07)
    const pool = sc.all ? users.filter(u => u.is_active !== 0 && u.role !== 'service_readonly') : users.filter(u => (sc.uids || []).includes(u.uid));
    const people = pool.map(u => ({ uid: u.uid, name: u.name, department: u.department || '', codes: st.codesOf(u) })).filter(p => p.codes.length);
    res.json({ ...sc, people, filters: st.teamFilters(cfg, users, sc), restricted: !!vs.restricted, scope_version: vs.version || '',
      mt_chains: vs.chains || [], mt_cust_count: (vs.mtCodes || []).length });
  });

  // ── เจ้า Modern Trade: ชื่อเซลล์/ผู้จัดการในไฟล์ → ผู้ใช้ (2026-10-06) ─────────────────────────────────
  router.get('/mt', (req, res) => {
    const cm = loadCodeMap(db), people = cs.loadPeople(db);
    const users = st.usersOf(db).filter(u => u.is_active !== 0 && u.role !== 'service_readonly');
    const names = new Map();
    cm.rules.forEach(r => {
      (r.sales || []).forEach(n => { const k = `sales:${n}`; names.set(k, { key: k, role: 'sales', name: n, rows: (names.get(k)?.rows || 0) + 1 }); });
      (r.manager || []).forEach(n => { const k = `mgr:${n}`; names.set(k, { key: k, role: 'mgr', name: n, rows: (names.get(k)?.rows || 0) + 1 }); });
    });
    const byRule = cs.codesByRule(db, cm.rules, `${cm.imported_at}|${cm.rules.length}`);
    res.json({
      imported_at: cm.imported_at, file: cm.file, has_names: cm.rules.some(r => (r.sales || []).length || (r.manager || []).length),
      rules: cm.rules.map((r, i) => ({ row: r.row, name: r.name, cls: r.cls, src: r.src, sales: r.sales || [], manager: r.manager || [], codes: (byRule.get(i) || []).length })),
      names: [...names.values()].map(n => ({ ...n, suggest: suggest(users, n.role, n.name) })),
      map: people.map, updated_at: people.updated_at,
      users: users.map(u => ({ uid: u.uid, name: u.name, role: u.role, department: u.department || '' })),
    });
  });
  router.put('/mt', requireRole('admin', 'superadmin'), (req, res) => {
    const active = new Set(st.usersOf(db).filter(u => u.is_active !== 0).map(u => u.uid));
    const map = {};
    for (const [k, uid] of Object.entries(req.body?.map || {})) {
      if (!/^(sales|mgr):.{1,60}$/.test(k)) return res.status(400).json({ error: `ชื่อในตารางจับคู่ไม่ถูกต้อง: ${k}` });
      if (!uid) continue;
      if (!active.has(String(uid))) return res.status(400).json({ error: `ผู้ใช้ ${uid} ไม่มีอยู่หรือปิดใช้งานแล้ว (${k})` });
      map[k] = String(uid);
    }
    db.prepare(`INSERT INTO approval_workflow_templates (entity_type, levels_json, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(cs.PEOPLE_ENTITY, JSON.stringify({ map }), req.user.uid);
    try { db.prepare('INSERT INTO audit_log (action, target, detail, uid, ts) VALUES (?, ?, ?, ?, ?)').run('MT_ASSIGN_PEOPLE', cs.PEOPLE_ENTITY, JSON.stringify({ count: Object.keys(map).length }), req.user.uid, new Date().toISOString()); } catch (_) { /* audit ไม่บังคับ */ }
    cs.clearScopeCache();
    res.json({ ok: true, count: Object.keys(map).length });
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
