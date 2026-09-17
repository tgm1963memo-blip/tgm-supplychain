const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sendResetPasswordEmail } = require('../lib/mailer');

// รีเซ็ตรหัสผ่านผ่านอีเมล (2026-09-15, ตามที่ผู้ใช้ขอให้ทำแบบเดียวกับระบบ E-Memo พี่น้อง) — mount แยกไฟล์
// จาก auth.js (แต่ยัง mount ที่ /api/auth เดิม, Express รองรับหลาย router ต่อ prefix เดียวกันได้) เพราะ
// เป็นฟีเจอร์คนละก้อน (ไม่แตะ login/session) และกันไฟล์ auth.js บวมเกินไป

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 ชั่วโมง เท่ากับ E-Memo

// Rate limit แยกจาก login (ป้องกันการยิงขอ reset ถี่ๆ เพื่อสแปมอีเมลผู้อื่น หรือเดา uid/email หา account
// จริง) คนละ Map จาก loginAttempts ใน auth.js เพราะเป็นคนละพฤติกรรมที่ต้องจำกัดคนละอัตรา
const FORGOT_MAX_PER_ACCOUNT = 3;
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_IP = 10;
const FORGOT_IP_WINDOW_MS = 60 * 60 * 1000;
const forgotAttemptsByAccount = new Map(); // `${ip}|${uidOrEmail}` -> { count, windowStart }
const forgotAttemptsByIp = new Map(); // ip -> { count, windowStart }

function rateLimited(map, key, max, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) return false;
  return entry.count >= max;
}
function recordAttempt(map, key, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

// โดเมนหน้าเว็บที่ใช้สร้างลิงก์ในอีเมล — เทียบ Origin/Referer ของ request กับ allowlist นี้ก่อนเสมอ (ห้าม
// เชื่อ header ที่ client ส่งมาตรงๆ เพราะปลอมได้ — ถ้าไม่ match ใช้ค่า default ตัวแรกแทนเสมอ) ใช้
// CORS_ORIGINS เดียวกับที่ตั้งไว้อยู่แล้วถ้ามีค่า (ปัจจุบัน production ปล่อยว่าง = อนุญาตทุก origin ผ่าน
// cors() แต่ไม่ควรเอามาใช้เป็น allowlist ของอีเมลด้วยเพราะนั่นเท่ากับไม่กรองอะไรเลย) จึงมี fallback เป็น
// รายชื่อโดเมนจริงของแอปนี้เสมอ
const DEFAULT_APP_ORIGINS = ['https://tss-supplychain.vercel.app', 'https://tss-planning.vercel.app'];

function resolveAppOrigin(req) {
  const configured = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowlist = configured.length ? configured : DEFAULT_APP_ORIGINS;
  const originHeader = req.headers.origin || '';
  let candidate = originHeader;
  if (!candidate && req.headers.referer) {
    try { candidate = new URL(req.headers.referer).origin; } catch { /* ignore malformed referer */ }
  }
  return allowlist.includes(candidate) ? candidate : allowlist[0];
}

module.exports = function passwordResetRoutes(db) {
  const router = express.Router();

  // POST /api/auth/forgot-password { uidOrEmail } — ตอบข้อความเดียวกันเสมอไม่ว่าจะเจอ account จริงหรือ
  // ไม่ (กัน account enumeration — พฤติกรรมเดียวกับ /login ที่ไม่บอกว่า uid ผิดหรือ password ผิด)
  router.post('/forgot-password', async (req, res) => {
    const uidOrEmail = String((req.body || {}).uidOrEmail || '').trim();
    const ip = req.ip;
    const genericResponse = { message: 'หากบัญชีนี้มีอยู่ในระบบ เราได้ส่งอีเมลลิงก์รีเซ็ตรหัสผ่านไปให้แล้ว' };

    if (!uidOrEmail) return res.status(400).json({ error: 'uidOrEmail is required' });

    if (rateLimited(forgotAttemptsByIp, ip, FORGOT_MAX_PER_IP, FORGOT_IP_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many requests, try again later' });
    }
    const accountKey = `${ip}|${uidOrEmail.toLowerCase()}`;
    if (rateLimited(forgotAttemptsByAccount, accountKey, FORGOT_MAX_PER_ACCOUNT, FORGOT_WINDOW_MS)) {
      return res.status(429).json({ error: 'too many requests, try again later' });
    }
    recordAttempt(forgotAttemptsByIp, ip, FORGOT_IP_WINDOW_MS);
    recordAttempt(forgotAttemptsByAccount, accountKey, FORGOT_WINDOW_MS);

    try {
      const user = db.prepare('SELECT * FROM sc_users WHERE uid = ? OR lower(email) = lower(?)').get(uidOrEmail, uidOrEmail);
      // ไม่มีอีเมล/account หรือถูกปิดใช้งาน — ตอบเหมือนสำเร็จเสมอ ไม่ให้เดา account ได้จากคำตอบที่ต่างกัน
      if (!user || !user.is_active || !user.email) return res.json(genericResponse);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      db.prepare('INSERT INTO password_reset_tokens (token, uid, expires_at) VALUES (?, ?, ?)').run(token, user.uid, expiresAt);

      const appOrigin = resolveAppOrigin(req);
      const resetLink = `${appOrigin}/?resetToken=${token}`;
      // ไม่ await การส่งอีเมลนานเกินจำเป็น แต่ยัง await เพื่อให้ error จริง (เช่น SMTP ตั้งค่าผิด) ถูก log —
      // sendResetPasswordEmail เองไม่ throw ต่อ (จับ error ภายในแล้ว) จึงไม่กระทบ response ที่ส่งกลับ
      await sendResetPasswordEmail({ to: user.email, name: user.name, resetLink });

      db.prepare('INSERT INTO audit_log (uid, role, action, ip_addr) VALUES (?, ?, ?, ?)')
        .run(user.uid, user.role, 'PASSWORD_RESET_REQUESTED', ip);

      return res.json(genericResponse);
    } catch (e) {
      console.error('[forgot-password]', e.message);
      // แม้ error ภายในก็ยังตอบข้อความเดียวกัน (กัน enumeration ผ่าน timing/response ต่างกัน)
      return res.json(genericResponse);
    }
  });

  // POST /api/auth/reset-password { token, newPassword }
  router.post('/reset-password', (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });

    try {
      const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
      if (!row) return res.status(400).json({ error: 'ลิงก์ไม่ถูกต้องหรือถูกใช้งานไปแล้ว' });
      if (row.used_at) return res.status(400).json({ error: 'ลิงก์นี้ถูกใช้งานไปแล้ว กรุณาขอลิงก์ใหม่' });
      if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'ลิงก์หมดอายุแล้ว กรุณาขอลิงก์ใหม่' });

      const pwdHash = bcrypt.hashSync(String(newPassword), 10);
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE sc_users SET pwd_hash = ?, updated_at = ? WHERE uid = ?').run(pwdHash, now, row.uid);
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token = ?').run(now, token);
        // เชือด session เดิมทั้งหมดของ user นี้ (กันกรณี token/session เก่าหลุดแล้วยังใช้ต่อได้)
        db.prepare('DELETE FROM sessions WHERE uid = ?').run(row.uid);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      db.prepare('INSERT INTO audit_log (uid, role, action, ip_addr) VALUES (?, ?, ?, ?)')
        .run(row.uid, null, 'PASSWORD_RESET_COMPLETED', req.ip);

      return res.json({ message: 'ตั้งรหัสผ่านใหม่สำเร็จแล้ว' });
    } catch (e) {
      console.error('[reset-password]', e.message);
      return res.status(500).json({ error: 'ไม่สามารถตั้งรหัสผ่านใหม่ได้ กรุณาลองใหม่อีกครั้ง' });
    }
  });

  return router;
};
