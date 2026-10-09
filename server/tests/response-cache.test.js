const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { runMigrations } = require('../db/migrations');
const { cacheJson } = require('../lib/responseCache');

// lib/responseCache.js (2026-10-09) — แคชต้องหมดอายุทันทีเมื่อ sync รอบใหม่ หรือแก้กลุ่มลูกค้า และห้ามใช้ข้ามผู้ใช้
test('cacheJson: per-user, invalidated by sync_log / customer_profiles changes, errors not cached', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  let calls = 0;
  const app = express();
  app.use((req, res, next) => { req.user = { uid: req.headers['x-u'] || 'A', role: 'sales' }; next(); });
  app.get('/x', cacheJson(db), (req, res) => { calls++; if (req.query.bad) return res.status(400).json({ error: 'bad' }); res.json({ n: calls }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const get = async (q = '', u = 'A') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/x${q}`, { headers: { 'x-u': u } });
    return { status: r.status, hit: r.headers.get('x-cache') === 'HIT', body: await r.json() };
  };

  assert.deepEqual((await get()).body, { n: 1 });
  const again = await get();
  assert.equal(again.hit, true);
  assert.deepEqual(again.body, { n: 1 });
  assert.deepEqual((await get('', 'B')).body, { n: 2 }); // ผู้ใช้อื่นไม่ได้ผลของ A

  db.prepare("INSERT INTO sync_log (source, started_at, status) VALUES ('x', '2026-10-09T00:00:00Z', 'running')").run();
  assert.deepEqual((await get()).body, { n: 3 }); // sync เริ่มรอบใหม่ → คำนวณใหม่
  db.prepare("UPDATE sync_log SET status = 'ok', finished_at = '2026-10-09T00:01:00Z'").run();
  assert.deepEqual((await get()).body, { n: 4 }); // sync จบ → คำนวณใหม่อีกครั้ง

  db.prepare("INSERT INTO customer_profiles (code, corporate, updated_at) VALUES ('C1', 'X', '2099-01-01T00:00:00Z')").run();
  assert.deepEqual((await get()).body, { n: 5 }); // แก้กลุ่มลูกค้า → คำนวณใหม่

  assert.equal((await get('?bad=1')).status, 400);
  assert.equal((await get('?bad=1')).hit, false); // error ไม่ถูกแคช
});
