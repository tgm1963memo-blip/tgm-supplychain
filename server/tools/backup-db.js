// SQLite online backup API includes committed WAL data; never copy a live .db alone.
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory) throw new Error('Usage: node server/tools/backup-db.js <existing-db> <backup-directory>');
  if (!fs.existsSync(source)) throw new Error('Source database does not exist');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `tgm-before-closeout-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); } finally { db.close(); }
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    const results = check.prepare('PRAGMA quick_check').all();
    if (results.some(row => row.quick_check !== 'ok')) throw new Error('Backup integrity check failed');
    console.log(JSON.stringify({ backup: target, bytes: fs.statSync(target).size, quick_check: 'ok' }));
  } finally { check.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
