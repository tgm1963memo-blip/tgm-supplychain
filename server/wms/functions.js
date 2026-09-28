// /wms/functions/v1/* — local versions of the tss-wms Supabase Edge Functions.
// driver-accounts: port of tgm-wms/supabase/functions/driver-accounts/index.ts (phone + 6-digit PIN
// accounts for drivers; only SUPER_ADMIN / ADMIN / MANAGER may manage them).
const express = require('express');
const crypto = require('crypto');
const { MANAGER_ROLES } = require('./policy');

const DRIVER_DOMAIN = 'driver.tss-wms.app';
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const normPhone = (p) => {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!/^0\d{8,9}$/.test(d)) throw new HttpError(400, 'เบอร์โทรไม่ถูกต้อง (ตัวเลข 9-10 หลัก ขึ้นต้นด้วย 0)');
  return d;
};
const isWeak = (pin) => /^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);
const checkPin = (pin) => {
  if (!/^\d{6}$/.test(pin)) throw new HttpError(400, 'PIN ต้องเป็นตัวเลข 6 หลัก');
  if (isWeak(pin)) throw new HttpError(400, 'PIN ง่ายเกินไป ห้ามใช้เลขเรียงหรือเลขซ้ำ');
  return pin;
};
const tempPin = () => { for (;;) { const p = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); if (!isWeak(p)) return p; } };
const cleanName = (n) => {
  const s = String(n ?? '').trim();
  if (s.length < 2 || s.length > 80) throw new HttpError(400, 'กรุณากรอกชื่อคนขับ');
  return s;
};

module.exports = function functionsRouter(db, auth) {
  const router = express.Router();
  router.post('/driver-accounts', (req, res) => {
    try {
      const ctx = auth.authCtx(req);
      if (!ctx) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
      if (ctx.kind !== 'service' && !MANAGER_ROLES.has(ctx.user.role)) throw new HttpError(403, 'ไม่มีสิทธิ์จัดการบัญชีคนขับ');
      const body = req.body || {};
      const driverRow = (id) => db.prepare('SELECT role FROM users WHERE id = ?').get(id);
      switch (body.op) {
        case 'list': {
          const rows = db.prepare("SELECT id, name, email, is_active, created_at FROM users WHERE role = 'DRIVER' ORDER BY name").all();
          return res.json({ drivers: rows.map((d) => ({ ...d, is_active: d.is_active !== 0, phone: String(d.email || '').split('@')[0] })) });
        }
        case 'create': {
          const name = cleanName(body.name), phone = normPhone(body.phone);
          const pin = body.pin ? checkPin(String(body.pin)) : tempPin();
          const email = `${phone}@${DRIVER_DOMAIN}`;
          let u;
          try {
            u = auth.createAccount({ email, password: pin, user_metadata: { name, role: 'DRIVER', phone, must_change_pin: true } });
          } catch (e) { throw new HttpError(400, /already/i.test(e.message) ? 'เบอร์โทรนี้มีบัญชีแล้ว' : e.message); }
          db.prepare(`INSERT INTO users (id, name, email, role, dept, is_active) VALUES (?, ?, ?, 'DRIVER', 'ขนส่ง', 1)
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, role = 'DRIVER', dept = 'ขนส่ง', is_active = 1`).run(u.id, name, email);
          return res.json({ id: u.id, name, phone, pin });
        }
        case 'reset_pin': {
          const pin = body.pin ? checkPin(String(body.pin)) : tempPin();
          if (driverRow(body.userId)?.role !== 'DRIVER') throw new HttpError(400, 'รีเซ็ต PIN ได้เฉพาะบัญชีคนขับ');
          auth.updateAccount(body.userId, { password: pin, user_metadata: { must_change_pin: true } });
          db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(body.userId); // drop old sessions, like PC-Tools
          return res.json({ ok: true, pin });
        }
        case 'set_active': {
          if (driverRow(body.userId)?.role !== 'DRIVER') throw new HttpError(400, 'ใช้ได้เฉพาะบัญชีคนขับ');
          const active = !!body.active;
          auth.updateAccount(body.userId, { ban_duration: active ? 'none' : '876000h' });
          db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, body.userId);
          return res.json({ ok: true, active });
        }
        default: throw new HttpError(400, 'unknown op');
      }
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });
  return router;
};
