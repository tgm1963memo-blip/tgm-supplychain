const express = require('express');
const bcrypt = require('bcryptjs');
const { createSession, requireAuth } = require('../middleware/auth');

function auditLogin(db, req, uid, role, action) {
  db.prepare('INSERT INTO audit_log (uid, role, action, ip_addr) VALUES (?, ?, ?, ?)')
    .run(uid, role || null, action, req.ip);
}

// ADDED (2026-08-05, security review — reapplied same day after a revert): this server is
// reachable over the public internet (ngrok tunnel, no IP allowlist) with no gate in front of
// /api/auth/login besides the password check itself — unlimited guesses were possible against any
// account. In-memory (not DB-backed) since a restart clearing the counters is an acceptable
// tradeoff for a single-process server with no existing rate-limit dependency; keyed on ip+uid so
// one attacker can't lock out a real user by spamming failed logins for their uid from elsewhere,
// and one uid's lockout doesn't rate-limit unrelated logins from the same NAT/office IP. Only
// touches the login route — has no effect on any GET/read endpoint.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key -> { count, windowStart }

function loginRateLimited(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) return false;
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}
function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

module.exports = function authRoutes(db) {
  const router = express.Router();

  // POST /api/auth/login  { uid, password } — `uid` accepts either the employee code (sc_users.uid)
  // or the user's email (sc_users.email), added 2026-09-15 so accounts can log in with either while
  // the org transitions toward email-based login. Case-insensitive on the email side only (uid stays
  // exact-match, unchanged behavior) since email casing isn't meaningfully significant to end users.
  router.post('/login', (req, res) => {
    const { uid, password } = req.body || {};
    if (!uid || !password) return res.status(400).json({ error: 'uid and password are required' });

    const rateKey = `${req.ip}|${uid}`;
    if (loginRateLimited(rateKey)) {
      auditLogin(db, req, uid, null, 'LOGIN_RATE_LIMITED');
      return res.status(429).json({ error: 'too many failed attempts, try again later' });
    }

    const user = db.prepare('SELECT * FROM sc_users WHERE uid = ? OR lower(email) = lower(?)').get(uid, uid);
    if (!user || !user.is_active || !bcrypt.compareSync(password, user.pwd_hash)) {
      recordLoginFailure(rateKey);
      auditLogin(db, req, uid, null, 'LOGIN_FAILED');
      return res.status(401).json({ error: 'invalid credentials' });
    }
    clearLoginFailures(rateKey);

    const { token, expiresAt } = createSession(db, user.uid);
    auditLogin(db, req, user.uid, user.role, 'LOGIN');
    res.json({
      token,
      expiresAt,
      user: {
        uid: user.uid,
        name: user.name,
        role: user.role,
        department: user.department,
        position: user.position,
        slm_id: user.slm_id,
      },
    });
  });

  router.post('/logout', requireAuth(db), (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.status(204).end();
  });

  router.get('/me', requireAuth(db), (req, res) => {
    res.json(req.user);
  });

  return router;
};
