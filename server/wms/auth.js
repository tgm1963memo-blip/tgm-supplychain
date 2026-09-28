// Supabase-Auth (GoTrue) compatible subset at /wms/auth/v1 — what supabase-js's auth client calls:
// password sign-in, refresh, get/update user, sign-out, password recovery, and the admin user API.
// Accounts and bcrypt hashes are copied over from Supabase's auth.users, so everyone keeps their
// password / driver PIN. Access tokens are HS256 JWTs signed with WMS_JWT_SECRET.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { nowTs, pgError } = require('./store');

const ACCESS_TTL_S = 3600;
const SUPERADMIN_EMAIL = 'thitiwat.tan@tgm.co.th';
const MANAGER_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);
const b64url = (b) => Buffer.from(b).toString('base64url');

function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!p.exp || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch { return null; }
}

// GoTrue error body. auth-js reads msg/error_description; tss-wms matches on the English text.
const authError = (res, status, msg, code) => res.status(status).json({ code: status, error_code: code, msg, error: code, error_description: msg });

function makeAuth(db, { jwtSecret, serviceKey, publicUrl, sendMail }) {
  const getUser = (id) => db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id);
  const getUserByEmail = (email) => db.prepare('SELECT * FROM auth_users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  const isBanned = (u) => !!u.banned_until && u.banned_until > nowTs();

  function userJson(u) {
    const meta = JSON.parse(u.raw_user_meta_data || '{}');
    const app = JSON.parse(u.raw_app_meta_data || '{}');
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, phone: '',
      email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at, last_sign_in_at: u.last_sign_in_at,
      app_metadata: app, user_metadata: meta, banned_until: u.banned_until || undefined,
      identities: [{ id: u.id, user_id: u.id, identity_data: { email: u.email, sub: u.id }, provider: 'email', created_at: u.created_at, updated_at: u.updated_at }],
      created_at: u.created_at, updated_at: u.updated_at, is_anonymous: false,
    };
  }

  // tss-wms's own users row (role/is_active) — the email override mirrors buildProfile() in supabase.js
  function profile(id) {
    const u = getUser(id);
    const row = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(id);
    const role = u && u.email.toLowerCase() === SUPERADMIN_EMAIL ? 'SUPER_ADMIN' : (row?.role || 'WORKER');
    return { id, email: u?.email, role, is_active: row ? row.is_active !== 0 : true };
  }

  function issueSession(u) {
    const now = Math.floor(Date.now() / 1000);
    const access_token = signJwt({ sub: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + ACCESS_TTL_S, session_id: crypto.randomUUID() }, jwtSecret);
    const refresh_token = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO auth_refresh_tokens (token, user_id, created_at) VALUES (?, ?, ?)').run(refresh_token, u.id, nowTs());
    return { access_token, token_type: 'bearer', expires_in: ACCESS_TTL_S, expires_at: now + ACCESS_TTL_S, refresh_token, user: userJson(getUser(u.id)) };
  }

  // Request identity for REST/storage/functions: service key, a signed-in user, or null (anon)
  function authCtx(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (serviceKey && token && crypto.timingSafeEqual(Buffer.from(crypto.createHash('sha256').update(token).digest()), Buffer.from(crypto.createHash('sha256').update(serviceKey).digest()))) return { kind: 'service' };
    const claims = verifyJwt(token, jwtSecret);
    if (!claims) return null;
    const u = getUser(claims.sub);
    if (!u || isBanned(u)) return null;
    const p = profile(u.id);
    if (!p.is_active) return null;
    return { kind: 'user', user: p };
  }
  const canManage = (ctx) => ctx && (ctx.kind === 'service' || MANAGER_ROLES.has(ctx.user.role));

  // handle_new_user(): every auth account gets a users row
  function createAccount({ email, password, user_metadata = {}, email_confirm = true, id }) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw Object.assign(new Error('Unable to validate email address: invalid format'), { status: 400, code: 'validation_failed' });
    if (!password || String(password).length < 6) throw Object.assign(new Error('Password should be at least 6 characters.'), { status: 422, code: 'weak_password' });
    if (getUserByEmail(email)) throw Object.assign(new Error('A user with this email address has already been registered'), { status: 422, code: 'email_exists' });
    const uid = id || crypto.randomUUID(), now = nowTs();
    db.prepare(`INSERT INTO auth_users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(uid, email, bcrypt.hashSync(String(password), 10), email_confirm ? now : null, JSON.stringify(user_metadata), now, now);
    db.prepare(`INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .run(uid, user_metadata.name || email.split('@')[0], user_metadata.role || 'OPERATOR', now);
    return getUser(uid);
  }

  function updateAccount(id, { password, user_metadata, email, ban_duration }) {
    const u = getUser(id);
    if (!u) throw Object.assign(new Error('User not found'), { status: 404, code: 'user_not_found' });
    const now = nowTs();
    if (password !== undefined) {
      if (String(password).length < 6) throw Object.assign(new Error('Password should be at least 6 characters.'), { status: 422, code: 'weak_password' });
      db.prepare('UPDATE auth_users SET encrypted_password = ?, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(String(password), 10), now, id);
    }
    if (user_metadata !== undefined) {
      const merged = { ...JSON.parse(u.raw_user_meta_data || '{}'), ...user_metadata };
      db.prepare('UPDATE auth_users SET raw_user_meta_data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now, id);
    }
    if (email !== undefined) db.prepare('UPDATE auth_users SET email = ?, updated_at = ? WHERE id = ?').run(String(email).trim().toLowerCase(), now, id);
    if (ban_duration !== undefined) {
      const until = ban_duration === 'none' ? null : new Date(Date.now() + parseInt(ban_duration, 10) * 3600e3).toISOString();
      db.prepare('UPDATE auth_users SET banned_until = ?, updated_at = ? WHERE id = ?').run(until, now, id);
      if (until) db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(id);
    }
    return getUser(id);
  }

  // failed sign-ins per email: 10 per 15 minutes (Supabase Auth also rate-limits)
  const fails = new Map();
  const tooMany = (email) => {
    const f = fails.get(email);
    return f && f.count >= 10 && Date.now() - f.first < 15 * 60e3;
  };
  const noteFail = (email) => {
    const f = fails.get(email);
    if (!f || Date.now() - f.first > 15 * 60e3) fails.set(email, { first: Date.now(), count: 1 });
    else f.count++;
  };

  const router = express.Router();
  const wrap = (fn) => (req, res) => {
    try { fn(req, res); } catch (e) { authError(res, e.status || 500, e.message, e.code || 'unexpected_failure'); }
  };

  router.get('/settings', (req, res) => res.json({ external: { email: true }, disable_signup: true, mailer_autoconfirm: true }));

  router.post('/token', wrap((req, res) => {
    const grant = req.query.grant_type;
    if (grant === 'password') {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (tooMany(email)) return authError(res, 429, 'Request rate limit reached', 'over_request_rate_limit');
      const u = getUserByEmail(email);
      if (!u || !u.encrypted_password || !bcrypt.compareSync(String(req.body?.password || ''), u.encrypted_password)) {
        noteFail(email);
        return authError(res, 400, 'Invalid login credentials', 'invalid_credentials');
      }
      fails.delete(email);
      if (isBanned(u)) return authError(res, 400, 'User is banned', 'user_banned');
      if (!u.email_confirmed_at) return authError(res, 400, 'Email not confirmed', 'email_not_confirmed');
      if (!profile(u.id).is_active) return authError(res, 400, 'User is banned', 'user_banned');
      db.prepare('UPDATE auth_users SET last_sign_in_at = ? WHERE id = ?').run(nowTs(), u.id);
      return res.json(issueSession(u));
    }
    if (grant === 'refresh_token') {
      const tok = db.prepare('SELECT * FROM auth_refresh_tokens WHERE token = ?').get(String(req.body?.refresh_token || ''));
      if (!tok || tok.revoked) return authError(res, 400, 'Invalid Refresh Token: Refresh Token Not Found', 'refresh_token_not_found');
      const u = getUser(tok.user_id);
      if (!u || isBanned(u) || !profile(u.id).is_active) return authError(res, 400, 'User is banned', 'user_banned');
      db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE token = ?').run(tok.token);
      return res.json(issueSession(u));
    }
    return authError(res, 400, 'unsupported_grant_type', 'validation_failed');
  }));

  const bearerUser = (req) => {
    const claims = verifyJwt(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), jwtSecret);
    const u = claims && getUser(claims.sub);
    return u && !isBanned(u) ? u : null;
  };

  router.get('/user', wrap((req, res) => {
    const u = bearerUser(req);
    if (!u) return authError(res, 401, 'invalid JWT: unable to parse or verify signature', 'bad_jwt');
    res.json(userJson(u));
  }));

  // updateUser({ password, data }) — drivers change their PIN here (data.must_change_pin = false)
  router.put('/user', wrap((req, res) => {
    const u = bearerUser(req);
    if (!u) return authError(res, 401, 'invalid JWT: unable to parse or verify signature', 'bad_jwt');
    const { password, data } = req.body || {};
    if (password !== undefined && u.encrypted_password && bcrypt.compareSync(String(password), u.encrypted_password)) {
      return authError(res, 422, 'New password should be different from the old password.', 'same_password');
    }
    res.json(userJson(updateAccount(u.id, { password, user_metadata: data })));
  }));

  router.post('/logout', wrap((req, res) => {
    const u = bearerUser(req);
    if (u) db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(u.id);
    res.status(204).end();
  }));

  // Public sign-up stays off (Supabase's was effectively admin-only too). New staff accounts are made
  // from the Users page through /admin/users.
  router.post('/signup', (req, res) => authError(res, 403, 'Signups not allowed for this instance', 'signup_disabled'));

  // resetPasswordForEmail — mails a one-hour link to a small form this server hosts (reset.html below)
  router.post('/recover', wrap((req, res) => {
    const u = getUserByEmail(req.body?.email);
    res.json({}); // same answer whether or not the address exists
    if (!u || u.email.endsWith('@driver.tss-wms.app')) return;
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO auth_recovery_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), u.id, new Date(Date.now() + 3600e3).toISOString());
    const link = `${publicUrl(req)}/wms/auth/reset?token=${token}`;
    sendMail?.({ to: u.email, subject: 'รีเซ็ตรหัสผ่าน TSS WMS', text: `ตั้งรหัสผ่านใหม่ภายใน 1 ชั่วโมง: ${link}`,
      html: `<p>มีคำขอรีเซ็ตรหัสผ่าน TSS WMS ของบัญชีนี้</p><p><a href="${link}">ตั้งรหัสผ่านใหม่</a> (ลิงก์ใช้ได้ 1 ชั่วโมง)</p><p>ถ้าไม่ได้ขอ ไม่ต้องทำอะไร</p>` })
      .catch((e) => console.error('[wms/auth] reset mail failed:', e.message));
  }));

  // ── admin user API (auth.admin.*) — service key or a managing role ──
  const admin = express.Router();
  admin.use((req, res, next) => (canManage(authCtx(req)) ? next() : authError(res, 403, 'User not allowed', 'not_admin')));
  admin.get('/users', wrap((req, res) => {
    const users = db.prepare('SELECT * FROM auth_users ORDER BY created_at').all().map(userJson);
    res.json({ users, aud: 'authenticated' });
  }));
  admin.get('/users/:id', wrap((req, res) => {
    const u = getUser(req.params.id);
    if (!u) return authError(res, 404, 'User not found', 'user_not_found');
    res.json(userJson(u));
  }));
  admin.post('/users', wrap((req, res) => res.json(userJson(createAccount(req.body || {})))));
  admin.put('/users/:id', wrap((req, res) => res.json(userJson(updateAccount(req.params.id, req.body || {})))));
  admin.delete('/users/:id', wrap((req, res) => {
    db.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?').run(req.params.id);
    db.prepare('DELETE FROM auth_users WHERE id = ?').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id); // was ON DELETE CASCADE from auth.users
    res.json({});
  }));
  admin.post('/users/:id/logout', wrap((req, res) => {
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(req.params.id);
    res.status(204).end();
  }));
  router.use('/admin', admin);

  // password reset form (linked from the recovery e-mail)
  const page = (body) => `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ตั้งรหัสผ่านใหม่ · TSS WMS</title><body style="font-family:sans-serif;max-width:360px;margin:60px auto;padding:0 16px">${body}</body></html>`;
  const resetRouter = express.Router();
  resetRouter.get('/', (req, res) => res.send(page(`<h2>ตั้งรหัสผ่านใหม่</h2>
    <form method="post"><input type="hidden" name="token" value="${String(req.query.token || '').replace(/[^\w-]/g, '')}">
    <p><input name="password" type="password" minlength="6" required placeholder="รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)" style="width:100%;padding:8px"></p>
    <p><button style="padding:8px 16px">บันทึก</button></p></form>`)));
  resetRouter.post('/', express.urlencoded({ extended: false }), (req, res) => {
    const hash = crypto.createHash('sha256').update(String(req.body?.token || '')).digest('hex');
    const t = db.prepare('SELECT * FROM auth_recovery_tokens WHERE token_hash = ?').get(hash);
    if (!t || t.used || t.expires_at < new Date().toISOString()) return res.status(400).send(page('<p>ลิงก์หมดอายุหรือถูกใช้ไปแล้ว กรุณาขอรีเซ็ตใหม่</p>'));
    try {
      updateAccount(t.user_id, { password: req.body.password });
      db.prepare('UPDATE auth_recovery_tokens SET used = 1 WHERE token_hash = ?').run(hash);
      db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(t.user_id);
      res.send(page('<p>ตั้งรหัสผ่านใหม่เรียบร้อย กลับไปเข้าสู่ระบบ TSS WMS ได้เลย</p>'));
    } catch (e) { res.status(400).send(page(`<p>${e.message}</p>`)); }
  });

  return { router, resetRouter, authCtx, canManage, createAccount, updateAccount, getUser, profile, verifyAccess: (t) => verifyJwt(t, jwtSecret) };
}

module.exports = { makeAuth, signJwt, verifyJwt, SUPERADMIN_EMAIL };
