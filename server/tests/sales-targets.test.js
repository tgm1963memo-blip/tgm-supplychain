const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// เป้าการขาย (2026-09-30): บันทึก/แก้/ลบรายเดือน, สิทธิ์เขียนเฉพาะ Sales Manager ขึ้นไป, custreg billing_json เก็บได้
test('sales targets CRUD + custreg billing_json', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tok = {};
  for (const [uid, role] of [['M', 'sales_manager'], ['S', 'sales_officer']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, uid, role, 'x');
    tok[uid] = createSession(db, uid).token;
  }
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method, body, uid = 'M') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tok[uid]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await call('/sales_targets', 'PUT', { rows: [{ slm_code: '101', ym: '2026-09', amount: 100000 }] }, 'S')).status, 403);
  assert.equal((await call('/sales_targets', 'PUT', { rows: [{ slm_code: '101', ym: '2026-9', amount: 1 }] })).status, 400);
  assert.equal((await call('/sales_targets', 'PUT', { rows: [{ slm_code: '101', ym: '2026-09', amount: -5 }] })).status, 400);
  const ok = await call('/sales_targets', 'PUT', { rows: [{ slm_code: '101', ym: '2026-09', amount: 100000 }, { slm_code: '101', ym: '2026-10', amount: 120000 }, { slm_code: '110', ym: '2026-09', amount: 50000 }] });
  assert.deepEqual(ok.data, { saved: 3, removed: 0 });
  await call('/sales_targets', 'PUT', { rows: [{ slm_code: '101', ym: '2026-09', amount: 90000 }, { slm_code: '110', ym: '2026-09', amount: '' }] });
  const got = await call('/sales_targets?year=2026', 'GET', null, 'S');
  assert.deepEqual(got.data.map(r => [r.slm_code, r.ym, r.amount]), [['101', '2026-09', 90000], ['101', '2026-10', 120000]]);
  assert.equal((await call('/sales_targets?year=26', 'GET')).status, 400);

  const billing = { addr: '1 ถ.สุขุมวิท', zip: '10110', rules: [{ type: 'weekly', days: [3] }, { type: 'nth_weekday', n: 2, weekday: 5 }], shift: 'next' };
  const cr = await call('/custreg_subs', 'POST', { id: 'CR-T1', doc_no: 'REG-1', shop: 'ร้าน', status: 'pending', ts: 1, billing_json: billing });
  assert.ok(cr.status < 300, JSON.stringify(cr.data));
  const back = await call('/custreg_subs?id=eq.CR-T1', 'GET');
  assert.deepEqual(back.data[0].billing_json, billing);
});
