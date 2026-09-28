const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWhere, buildOrderBy } = require('../lib/pgQuery');

const SAFE_FIELDS = ['uid', 'name', 'role', 'department', 'position', 'slm_id', 'slm_codes', 'email', 'is_active', 'created_at'];

// "101, 110-1,,101" → "101,110-1" (ตัดช่องว่าง/ซ้ำ) · undefined = ไม่แก้ · ว่าง = null
function normSlmCodes(v) {
  if (v === undefined) return undefined;
  const list = [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim()).filter(Boolean))];
  return list.length ? list.join(',') : null;
}

// sc_users needs bcrypt-on-write and must never leak pwd_hash — handled by hand instead of the
// generic CRUD router. Mounted at /api/sc_users (write) and /api/v_sc_users_safe (read) to match
// the exact table/view names the client's `.from('sc_users')` / `.from('v_sc_users_safe')` calls use.
function usersRoutes(db) {
  const scUsers = express.Router();
  scUsers.use(requireAuth(db), requireRole('superadmin', 'admin'));

  scUsers.post('/', (req, res) => {
    const upsert = req.query.upsert === 'true';
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const saved = [];
    try {
      for (const r of rows) {
        const uid = r.uid;
        if (!uid || !r.name || !r.role) return res.status(400).json({ error: 'uid, name, role are required' });
        const pwd_hash = r.pwd_hash ? bcrypt.hashSync(String(r.pwd_hash), 10) : undefined;

        const existing = db.prepare('SELECT uid FROM sc_users WHERE uid = ?').get(uid);
        if (existing) {
          const fields = [];
          const params = [];
          for (const [col, val] of Object.entries({
            name: r.name, role: r.role, department: r.department, position: r.position,
            slm_id: r.slm_id, slm_codes: normSlmCodes(r.slm_codes), email: r.email, is_active: r.is_active,
          })) {
            if (val === undefined) continue;
            fields.push(`${col} = ?`);
            params.push(val);
          }
          if (pwd_hash) { fields.push('pwd_hash = ?'); params.push(pwd_hash); }
          fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
          params.push(uid);
          db.prepare(`UPDATE sc_users SET ${fields.join(',')} WHERE uid = ?`).run(...params);
        } else {
          if (!pwd_hash) return res.status(400).json({ error: 'pwd_hash is required for a new user' });
          db.prepare(`
            INSERT INTO sc_users (uid, name, role, department, position, slm_id, slm_codes, email, pwd_hash, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uid, r.name, r.role, r.department || null, r.position || null, r.slm_id || null, normSlmCodes(r.slm_codes) || null, r.email || null, pwd_hash, req.user.uid);
        }
        db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
          .run(req.user.uid, req.user.role, existing ? 'EDIT_USER' : 'ADD_USER', uid);
        saved.push(db.prepare(`SELECT ${SAFE_FIELDS.join(',')} FROM sc_users WHERE uid = ?`).get(uid));
      }
      res.status(201).json(Array.isArray(req.body) ? saved : saved[0]);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  scUsers.patch('/', (req, res) => {
    const { where, params } = buildWhere(req.query, ['uid']);
    if (!where) return res.status(400).json({ error: 'update requires a uid filter' });
    const target = db.prepare(`SELECT uid FROM sc_users ${where}`).get(...params);
    if (!target) return res.status(404).json({ error: 'not found' });

    const body = { ...req.body };
    const fields = [];
    const upd = [];
    for (const [col, val] of Object.entries({
      name: body.name, role: body.role, department: body.department, position: body.position,
      slm_id: body.slm_id, slm_codes: normSlmCodes(body.slm_codes), email: body.email, is_active: body.is_active,
    })) {
      if (val === undefined) continue;
      fields.push(`${col} = ?`);
      upd.push(val);
    }
    if (body.pwd_hash) { fields.push('pwd_hash = ?'); upd.push(bcrypt.hashSync(String(body.pwd_hash), 10)); }
    if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    db.prepare(`UPDATE sc_users SET ${fields.join(',')} WHERE uid = ?`).run(...upd, target.uid);
    res.json(db.prepare(`SELECT ${SAFE_FIELDS.join(',')} FROM sc_users WHERE uid = ?`).get(target.uid));
  });

  scUsers.delete('/', (req, res) => {
    const { where, params } = buildWhere(req.query, ['uid']);
    if (!where) return res.status(400).json({ error: 'delete requires a uid filter' });
    db.prepare(`UPDATE sc_users SET is_active = 0 WHERE uid IN (SELECT uid FROM sc_users ${where})`).run(...params);
    res.status(204).end();
  });

  const safeView = express.Router();
  safeView.get('/', requireAuth(db), (req, res) => {
    const { where, params } = buildWhere(req.query, SAFE_FIELDS);
    const orderClause = buildOrderBy(req.query, SAFE_FIELDS, 'uid');
    const rows = db.prepare(`SELECT ${SAFE_FIELDS.join(',')} FROM sc_users ${where} ${orderClause}`).all(...params);
    res.json(rows);
  });

  return { scUsers, safeView };
}

module.exports = usersRoutes;
