const crypto = require('crypto');

const SESSION_TTL_HOURS = 12;

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createSession(db, uid) {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, uid, expires_at) VALUES (?, ?, ?)').run(token, uid, expiresAt);
  return { token, expiresAt };
}

// Express middleware: requires a valid, non-expired session token in the Authorization header.
// Attaches req.user = { uid, name, role, department, position, slm_id }.
function requireAuth(db) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing session token' });

    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!session) return res.status(401).json({ error: 'invalid session' });
    const now = Date.now();
    const expiresAtMs = new Date(session.expires_at).getTime();
    if (expiresAtMs < now) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return res.status(401).json({ error: 'session expired' });
    }
    // sliding expiry: a session's expiry pushes out another SESSION_TTL_HOURS once it's more than
    // half burned through, so an active user never hits the absolute-from-login TTL — only genuine,
    // sustained inactivity expires the session. THROTTLED (not on every request): confirmed live
    // 2026-09-12 that an unconditional UPDATE here on every single authenticated request — including
    // plain reads — was the direct cause of "5-10s+ delay after clicking" whenever a request landed
    // during importFromExpress's ~15-30s sync-worker write window (see jobs/syncWorker.js) — SQLite
    // allows only one writer across all connections, so this write queued up behind the sync
    // worker's. Limiting the UPDATE to roughly once per half-TTL turns the other ~95%+ of requests
    // into pure reads, which WAL mode never blocks against a concurrent writer.
    if (expiresAtMs - now < (SESSION_TTL_HOURS * 3600 * 1000) / 2) {
      const slidingExpiresAt = new Date(now + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(slidingExpiresAt, token);
    }

    const user = db.prepare(
      'SELECT uid, name, role, department, position, slm_id, is_active FROM sc_users WHERE uid = ?'
    ).get(session.uid);
    if (!user || !user.is_active) return res.status(401).json({ error: 'account disabled' });

    req.user = user;
    next();
  };
}

// Express middleware factory: requires req.user.role to be one of `roles`.
// Must run after requireAuth(). Used to protect admin-only endpoints (users, perms) server-side,
// closing the gap where the old client-only nav() never re-checked permissions.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

module.exports = { createSession, requireAuth, requireRole, SESSION_TTL_HOURS };
