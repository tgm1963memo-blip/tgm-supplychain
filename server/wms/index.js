// tss-wms local backend — a Supabase-compatible API (REST, Auth, Storage, Functions, change feed) over
// SQLite, so tss-wms can run from this DB PC instead of Supabase by changing only its Supabase URL/key.
// Mounted at /wms by app.js. Stays switched off until WMS_DB_PATH and WMS_JWT_SECRET are set.
//
//   WMS_DB_PATH        SQLite file (e.g. C:\TGM-Data\wms\wms.db — keep it outside OneDrive)
//   WMS_JWT_SECRET     random secret for access tokens (changing it signs everyone out)
//   WMS_SERVICE_KEY    optional; full access for scripts/express_sync.py and the migration tool
//   WMS_STORAGE_DIR    optional; photo files (default: <db folder>/storage)
//   WMS_PUBLIC_URL     optional; base URL for password-reset links (default: from the request)
const express = require('express');
const path = require('path');
const store = require('./store');
const { makeAuth } = require('./auth');

function mountWms(app) {
  const dbPath = process.env.WMS_DB_PATH;
  const jwtSecret = process.env.WMS_JWT_SECRET;
  if (!dbPath || !jwtSecret) {
    console.log('[wms] local tss-wms backend disabled (set WMS_DB_PATH and WMS_JWT_SECRET to enable)');
    return null;
  }
  if (jwtSecret.length < 32) throw new Error('WMS_JWT_SECRET must be at least 32 characters');
  const db = store.openStore(dbPath);
  const storageDir = process.env.WMS_STORAGE_DIR || path.join(path.dirname(dbPath), 'storage');
  const publicUrl = (req) => (process.env.WMS_PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
  let sendMail = null;
  try { sendMail = require('../lib/mailer').sendMail; } catch { /* mailer not configured */ }

  const auth = makeAuth(db, { jwtSecret, serviceKey: process.env.WMS_SERVICE_KEY || null, publicUrl, sendMail });
  const router = express.Router();
  router.get('/health', (req, res) => res.json({ ok: true, tables: Object.keys(store.schema.tables).length, time: new Date().toISOString() }));
  router.use('/rest/v1', require('./rest')(db, auth.authCtx));
  router.use('/auth/v1', auth.router);
  router.use('/auth/reset', auth.resetRouter);
  router.use('/storage/v1', require('./storage')(db, { storageDir, jwtSecret, authCtx: auth.authCtx }));
  router.use('/functions/v1', require('./functions')(db, auth));

  // Stand-in for Supabase Realtime: GET /wms/realtime/v1/changes?after=<seq>&tables=a,b
  router.get('/realtime/v1/changes', (req, res) => {
    const ctx = auth.authCtx(req);
    if (!ctx) return res.status(401).json({ message: 'JWT required' });
    const tables = new Set(String(req.query.tables || '').split(',').filter(Boolean));
    const after = req.query.epoch === store.changeLog.epoch ? parseInt(req.query.after, 10) || 0 : store.changeLog.seq;
    // drivers subscribe too (the app shell always does) but may not see office tables — like RLS, they get nothing
    const changes = ctx.user?.role === 'DRIVER' ? [] : store.changeLog.items.filter((c) => c.seq > after && (!tables.size || tables.has(c.table)));
    res.json({ epoch: store.changeLog.epoch, seq: store.changeLog.seq, changes });
  });

  app.use('/wms', router);
  console.log(`[wms] local tss-wms backend on /wms (db ${dbPath})`);
  scheduleBackups(db, dbPath, storageDir);
  return { db, auth };
}

// Daily copy of the WMS database (VACUUM INTO gives a consistent file while the server keeps running)
// plus the photo folder, kept for WMS_BACKUP_KEEP_DAYS (default 14) in WMS_BACKUP_DIR
// (default <db folder>/backups). Point WMS_BACKUP_DIR at another disk/NAS to survive a disk failure.
function scheduleBackups(db, dbPath, storageDir) {
  const fs = require('fs');
  const dir = process.env.WMS_BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
  const keep = parseInt(process.env.WMS_BACKUP_KEEP_DAYS, 10) || 14;
  const run = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(dir, `wms-${day}.db`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      if (fs.existsSync(storageDir)) fs.cpSync(storageDir, path.join(dir, `storage-${day}`), { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(?:wms|storage)-(\d{4}-\d\d-\d\d)/);
        if (m && (Date.now() - new Date(m[1]).getTime()) / 86400e3 > keep) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }
      fs.writeFileSync(path.join(dir, 'LAST_BACKUP.txt'), `OK ${new Date().toISOString()} ${file}\n`);
      console.log(`[wms] backup written: ${file}`);
    } catch (e) {
      console.error('[wms] backup FAILED:', e.message);
      try { fs.writeFileSync(path.join(dir, 'LAST_BACKUP.txt'), `FAILED ${new Date().toISOString()} ${e.message}\n`); } catch { /* dir missing */ }
    }
  };
  require('node-cron').schedule(process.env.WMS_BACKUP_CRON || '30 1 * * *', run);
  return run;
}

module.exports = { mountWms, scheduleBackups };
