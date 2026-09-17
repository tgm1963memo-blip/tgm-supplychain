const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { runMigrations } = require('./migrations');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tgm.db');

// Uses Node's built-in node:sqlite (stable since Node 22.5+) instead of better-sqlite3 —
// no native module compilation needed, so no Visual Studio Build Tools required on the DB PC.
function openDb() {
  const isNew = !fs.existsSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // The sync worker (jobs/syncWorker.js) runs on its own thread with its own connection, writing
  // concurrently with this one. WAL allows concurrent readers without contention, but SQLite still
  // only allows ONE writer at a time — a write from this connection (e.g. creating a login session)
  // that lands mid-way through the worker's own write transaction gets SQLITE_BUSY immediately
  // without this, surfacing as "database is locked" 500s. busy_timeout makes it wait and retry
  // instead of failing outright.
  // Raised from 5000 -> 30000: measured live (2026-08-03) that this was still firing daily — the
  // worker's own transactions (refreshSalesRollups especially) individually ran 4-20s+, well past a
  // 5s timeout, so any request landing mid-transaction failed outright instead of just waiting a
  // bit. 30s comfortably covers the worst single-transaction duration seen in production logs.
  db.exec('PRAGMA busy_timeout = 30000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  runMigrations(db);

  if (isNew) seedDefaults(db);

  return db;
}

// Minimal seed so the server is usable on first boot; edit/replace via the Users page once running.
// FIXED (2026-08-05, security review — reapplied same day after a revert): used to seed a fixed,
// publicly-guessable password ('changeme123') — anyone reaching this server (e.g. over the tunnel
// this project exposes it through) could log in as superadmin before an operator ever got around to
// changing it. Generates a random one-time password instead and prints it ONCE to the server's own
// console/log at first boot only. Only affects brand-new databases — does not touch or affect
// today's already-running DB/users at all.
function seedDefaults(db) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM sc_users').get().n;
  if (hasUsers === 0) {
    const insert = db.prepare(`
      INSERT INTO sc_users (uid, name, role, department, position, pwd_hash, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'SYSTEM')
    `);
    const tempPassword = crypto.randomBytes(9).toString('base64url'); // ~12 random chars
    const pwd = bcrypt.hashSync(tempPassword, 10);
    insert.run('SADM', 'Super Admin', 'superadmin', null, null, pwd);
    console.log(`[init] Seeded default user SADM with a random one-time password: ${tempPassword}`);
    console.log('[init] เปลี่ยนรหัสผ่านนี้ทันทีที่หน้า Users หลังติดตั้งเสร็จ (จะไม่แสดงข้อความนี้อีก)');
  }
}

module.exports = { openDb, DB_PATH };
