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
const { parentPort } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('../db/init');
const { runImport } = require('./importFromExpress');

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

parentPort.on('message', async (msg) => {
  if (msg !== 'run') return;
  await runImport(db); // runImport already logs its own progress/errors and never throws
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  parentPort.postMessage('done');
});
