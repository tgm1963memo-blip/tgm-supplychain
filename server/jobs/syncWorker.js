/**
 * Runs importFromExpress's runImport() on a worker thread instead of the main thread.
 *
 * node:sqlite's DatabaseSync is, as the name says, synchronous — every call blocks whichever
 * thread calls it. runImport() can take 15-30+ seconds (refreshSalesRollups alone regularly
 * hits 20s+ over ~410k sales lines). Running that on the main thread freezes the entire HTTP
 * server for that whole window, every ~5 minutes, for every user, on every page — not just slow,
 * completely unresponsive. Moving it here means only this thread blocks; the main thread's own
 * DatabaseSync connection keeps serving requests the whole time. WAL mode (set in db/init.js,
 * persisted in the database file) is what makes one writer + concurrent readers across separate
 * connections safe.
 *
 * This worker owns its own DatabaseSync connection to the same file — schema/migrations/seed
 * already ran once via the main thread's openDb() before this worker is ever created, so this
 * just opens the existing database and sets the per-connection PRAGMAs it needs.
 */
const fs = require('fs');
const { parentPort } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../db/init');
const { runImport } = require('./importFromExpress');
// Bplus ของโรงงาน (2026-10-05) — รันต่อท้าย Express ใน worker เดียวกัน ไม่ให้สองงานเขียน SQLite พร้อมกัน
const { runBplusImport } = require('./importFromBplus');
const { runChainImport } = require('./importChainRooms');
const { EXPRESS_ROOT } = require('./importFromExpress');
// ลูกค้าใหม่ที่ยังไม่มี corporate → จัดกลุ่มอัตโนมัติ (2026-10-14) ดู lib/autoGroup.js
const { autoGroupNewCustomers } = require('../lib/autoGroup');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Matches db/init.js's busy_timeout — without it, a write from this thread that starts just before
// the main thread's own write (e.g. a login creating a session row) gets SQLITE_BUSY immediately
// instead of waiting the other one out. Raised 5000 -> 30000 alongside db/init.js — see that file's
// comment for the measured numbers that motivated it.
db.exec('PRAGMA busy_timeout = 30000');
// SQLite's default auto-checkpoint fires whenever the WAL file crosses ~1000 pages, and a full
// checkpoint needs a brief exclusive lock — that's what was still causing occasional 6-8s stalls
// on the main thread's reads even after moving sync off it (measured live: a plain indexed read
// took 6980ms because it landed on an auto-checkpoint mid-sync). Disabling auto-checkpoint here
// and running one PASSIVE checkpoint after each sync completes moves that flush to a moment when
// nothing else needs the lock, and PASSIVE mode never blocks readers/writers by design — worst
// case it just checkpoints less than fully and tries again next cycle.
db.exec('PRAGMA wal_autocheckpoint = 0');
// FIXED (2026-10-09, ผู้ใช้: "ทำให้ระบบรันไวขึ้น"): PASSIVE อย่างเดียวไม่เคย reset WAL ถ้ามีคนอ่านค้างอยู่ตอนนั้น และไม่เคยหดไฟล์ —
// วัดจริงบนเครื่อง DB: tgm.db-wal 2.0 GB (ใหญ่กว่าตัว DB 1.68 GB) · ทุกการอ่านต้องค้นผ่าน WAL index ก้อนใหญ่นี้
// → WAL เกิน 256 MB ให้ TRUNCATE (เขียนทุกหน้ากลับ DB แล้วตัด WAL เหลือ 0) โดยรอคนอ่านไม่เกิน 3 วิ
//   (ระหว่างรอ การเขียนฝั่ง main thread ต้องรอด้วย จึงไม่ใช้ busy_timeout 30 วิตามปกติ) · ไม่สำเร็จ = ลองใหม่รอบหน้า
// journal_size_limit: หลัง reset ให้ SQLite ตัดไฟล์ WAL ที่เหลือลงเหลือไม่เกิน 64 MB เอง
db.exec('PRAGMA journal_size_limit = 67108864');
const WAL_TRUNCATE_BYTES = 256 * 1024 * 1024;
function checkpoint() {
  let walBytes = 0;
  try { walBytes = fs.statSync(DB_PATH + '-wal').size; } catch { /* ไม่มีไฟล์ WAL = ไม่ต้องทำ */ }
  if (walBytes < WAL_TRUNCATE_BYTES) { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); return; }
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    console.log(`[syncWorker] WAL ${Math.round(walBytes / 1048576)} MB → checkpoint(TRUNCATE) busy=${r?.busy} log=${r?.log} done=${r?.checkpointed}`);
  } catch (e) {
    console.warn('[syncWorker] checkpoint(TRUNCATE) failed:', e.message);
  } finally {
    db.exec('PRAGMA busy_timeout = 30000');
  }
}

parentPort.on('message', async (msg) => {
  if (msg !== 'run' && msg !== 'run-bplus') return;
  await runImport(db); // runImport already logs its own progress/errors and never throws
  // ทำไม่ถี่กว่า BPLUS_SYNC_MIN_INTERVAL_MIN (ค่าเริ่ม 30 นาที) · 'run-bplus' = บังคับรอบทันที (หลังแก้ตารางจับคู่พนักงานขาย)
  await runBplusImport(db, { force: msg === 'run-bplus' }); // never throws
  // ยอดรายสาขาห้องจากห้อง SKU (TOPS-53/MAKRO/GOWHOLES, 2026-10-07) — อ่านเฉพาะเมื่อไฟล์เปลี่ยน ดู jobs/importChainRooms.js
  await runChainImport(db, EXPRESS_ROOT); // never throws
  try {
    const g = autoGroupNewCustomers(db);
    if (g.updated) console.log(`[syncWorker] auto-group: ${g.updated} new customers → ${g.items.map((x) => `${x.code}=${x.corporate}`).join(', ')}`);
  } catch (e) { console.warn('[syncWorker] auto-group failed:', e.message); }
  checkpoint();
  parentPort.postMessage('done');
});
