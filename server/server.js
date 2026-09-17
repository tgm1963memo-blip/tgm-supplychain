require('dotenv').config();
const path = require('path');
const cron = require('node-cron');
const { Worker } = require('worker_threads');

const { openDb } = require('./db/init');
const { buildApp } = require('./app');
const { importPoFromEmail, imapConfigured } = require('./jobs/importPoFromEmail');

const PORT = process.env.PORT || 3000;

const db = openDb();

// The Express-DBF sync runs on its own worker thread (see jobs/syncWorker.js) — it can take
// 15-30+ seconds, and node:sqlite's DatabaseSync blocks whichever thread runs it. On the main
// thread that used to freeze the entire HTTP server for the whole window, every 5 minutes.
const syncWorker = new Worker(path.join(__dirname, 'jobs', 'syncWorker.js'));
let syncRunning = false;
// lastSyncNowCompletedAt (declared below, used by triggerSyncNow's cooldown) is bumped here too —
// FIXED (2026-09-13, /code-review): it used to only update inside triggerSyncNow's own one-off
// listeners, so a plain 5-minute CRON tick finishing left it stale. An admin calling
// /api/admin/sync_now moments after a cron tick finished would then pass both the syncRunning and
// cooldown checks and immediately kick off a second full sync back-to-back — reproducing the exact
// SQLITE_BUSY-risk outage SYNC_NOW_COOLDOWN_MS was added to prevent (see its comment below), just
// via a cron→admin sequence instead of admin→admin. Updating it on every 'done' message, regardless
// of who triggered the sync, closes that gap.
syncWorker.on('message', (msg) => {
  if (msg === 'done') { syncRunning = false; lastSyncNowCompletedAt = Date.now(); }
});
syncWorker.on('error', (e) => {
  syncRunning = false;
  lastSyncNowCompletedAt = Date.now();
  console.error('[importFromExpress] sync worker crashed:', e.message);
});

// ADDED (2026-08-20, see app.js's /api/admin/sync_now route for why): lets an authenticated caller
// force a sync immediately instead of waiting for the next 5-minute cron tick — reuses the same
// worker/syncRunning flag as the cron below via one-off listeners (EventEmitter supports multiple
// listeners on the same event, so these don't conflict with the permanent pair registered above).
//
// SYNC_NOW_COOLDOWN_MS added 2026-08-27 (real production incident): the syncRunning check above
// only blocks an OVERLAPPING call, not a caller that retriggers the instant the previous run
// finishes. Live logs showed exactly that — hundreds of full sync cycles completing back-to-back
// with near-zero gap, each one's write transactions contending with every other request's session
// sliding-expiry UPDATE (middleware/auth.js) for SQLite's single-writer lock. Even with the 30s
// busy_timeout (db/init.js), enough requests landed mid-lock that the dashboard sat blank for
// minutes — a full production outage from an endpoint that's supposed to be a rare manual nudge.
// Root cause looked like a caller (tgm-wms's manual resync button, the only real caller per this
// route's comment in app.js) retrying in a tight loop; this cooldown makes that harmless regardless
// of what's calling it, without touching the normal 5-minute cron below (which never calls this
// function — it posts to the worker directly).
const SYNC_NOW_COOLDOWN_MS = 60_000;
let lastSyncNowCompletedAt = 0;
function triggerSyncNow() {
  return new Promise((resolve, reject) => {
    if (syncRunning) {
      reject(new Error('sync กำลังทำงานอยู่แล้ว กรุณารอสักครู่แล้วลองใหม่'));
      return;
    }
    const sinceLast = Date.now() - lastSyncNowCompletedAt;
    if (sinceLast < SYNC_NOW_COOLDOWN_MS) {
      const waitSec = Math.ceil((SYNC_NOW_COOLDOWN_MS - sinceLast) / 1000);
      reject(new Error(`เพิ่ง sync ด้วยตนเองไปเมื่อครู่นี้ กรุณารออีก ${waitSec} วินาทีก่อนลองใหม่`));
      return;
    }
    syncRunning = true;
    const onMessage = (msg) => {
      if (msg !== 'done') return;
      syncWorker.off('message', onMessage);
      syncWorker.off('error', onError);
      lastSyncNowCompletedAt = Date.now();
      resolve();
    };
    const onError = (e) => {
      syncWorker.off('message', onMessage);
      syncWorker.off('error', onError);
      lastSyncNowCompletedAt = Date.now();
      reject(e);
    };
    syncWorker.on('message', onMessage);
    syncWorker.on('error', onError);
    console.log('[importFromExpress] starting manual sync (admin-triggered via /api/admin/sync_now)');
    syncWorker.postMessage('run');
  });
}

const app = buildApp(db, { triggerSyncNow });

app.listen(PORT, () => {
  console.log(`[tgm-server] listening on port ${PORT}`);
});

// Every 5 minutes, 24/7 — pulls DBF data from Express into the local SQLite DB.
// See jobs/importFromExpress.js for the open question on which OESO.DOCSTAT values count as real sales.
cron.schedule('*/5 * * * *', () => {
  if (syncRunning) {
    console.warn('[importFromExpress] previous sync still running; skipping this tick');
    return;
  }
  syncRunning = true;
  console.log('[importFromExpress] starting scheduled sync');
  syncWorker.postMessage('run');
});

// PO-by-email import (2026-08-27) — plain async cron on the main thread, not a worker thread like
// the Express sync above: IMAP I/O is network-bound, not CPU/DatabaseSync-bound, so it doesn't block
// the event loop the way synchronous DBF parsing + SQLite writes do. Every 10 minutes; skipped
// entirely (imapConfigured() false) until PO_EMAIL_IMAP_* is set in .env.
let poEmailSyncRunning = false;
if (imapConfigured()) {
  cron.schedule('*/10 * * * *', async () => {
    if (poEmailSyncRunning) return;
    poEmailSyncRunning = true;
    try { await importPoFromEmail(db); }
    catch (e) { console.error('[importPoFromEmail] failed:', e.message); }
    finally { poEmailSyncRunning = false; }
  });
  // run once shortly after boot too, instead of waiting up to 10 minutes for the first tick
  setTimeout(() => {
    if (poEmailSyncRunning) return;
    poEmailSyncRunning = true;
    importPoFromEmail(db).catch((e) => console.error('[importPoFromEmail] failed:', e.message)).finally(() => { poEmailSyncRunning = false; });
  }, 10_000);
} else {
  console.log('[importPoFromEmail] PO_EMAIL_IMAP_* not configured — email PO import disabled');
}

process.on('SIGINT', () => {
  syncWorker.terminate();
  db.close();
  process.exit(0);
});
