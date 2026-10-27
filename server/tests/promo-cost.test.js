const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { forecastCost, daysByMonth, getSettings } = require('../lib/promoCost');
const { parsePct, parseCost } = require('../routes/promoCosts');

// ทุนคาดการณ์จากราคาหมู (2026-10-22, พิจารณาอนุมัติโปร เฟส 1)
test('daysByMonth splits a promo period across months', () => {
  assert.deepEqual(daysByMonth('2026-11-25', '2026-12-05'), [{ month: '2026-11', days: 6 }, { month: '2026-12', days: 5 }]);
  assert.deepEqual(daysByMonth('2026-12-05', '2026-11-25'), []);
});

test('forecastCost: c(m) = c_now × (1 + pork% × (pig(m)/pig_base − 1)), weighted by promo days', () => {
  const pig = new Map([['2026-10', { actual: 80, forecast: 78 }], ['2026-11', { actual: null, forecast: 88 }], ['2026-12', { actual: null, forecast: 96 }]]);
  const row = { cost: 100, pork_pct: 0.5, month: '2026-10' };
  // พ.ย. ทั้งเดือน: 100 × (1 + 0.5 × (88/80 − 1)) = 105
  const nov = forecastCost(row, pig, '2026-11-01', '2026-11-30');
  assert.equal(nov.c_now, 100);
  assert.equal(nov.pig_base, 80); // actual ก่อน forecast
  assert.equal(nov.c_f, 105);
  assert.deepEqual(nov.flags, []);
  // 30 พ.ย. – 1 ธ.ค.: (105 + 110) / 2
  assert.equal(forecastCost(row, pig, '2026-11-30', '2026-12-01').c_f, 107.5);
});

test('forecastCost never guesses: missing pork%, pig base, pig month, or cost', () => {
  const pig = new Map([['2026-10', { actual: 80, forecast: null }]]);
  assert.deepEqual(forecastCost(null, pig, '2026-11-01', '2026-11-30').flags, ['no_cost']);
  const noPork = forecastCost({ cost: 100, pork_pct: null, month: '2026-10' }, pig, '2026-11-01', '2026-11-30');
  assert.equal(noPork.c_f, 100); assert.deepEqual(noPork.flags, ['no_pork_pct']);
  const noBase = forecastCost({ cost: 100, pork_pct: 0.5, month: '2026-09' }, pig, '2026-11-01', '2026-11-30');
  assert.equal(noBase.c_f, 100); assert.deepEqual(noBase.flags, ['no_pig_base']);
  const noMonth = forecastCost({ cost: 100, pork_pct: 0.5, month: '2026-10' }, pig, '2026-11-01', '2026-11-30');
  assert.equal(noMonth.c_f, 100); assert.deepEqual(noMonth.flags, ['pig_missing']);
});

test('parsePct / parseCost accept Excel and typed forms', () => {
  assert.equal(parsePct(0.6).value, 0.6);
  assert.equal(parsePct(60).value, 0.6);
  assert.equal(parsePct('60%').value, 0.6);
  assert.equal(parsePct('0.6').value, 0.6);
  assert.equal(parsePct('').value, null);
  assert.ok(parsePct(150).invalid);
  assert.ok(parsePct('abc').invalid);
  assert.equal(parseCost('1,234.5').value, 1234.5);
  assert.ok(parseCost(0).invalid);
  assert.ok(parseCost('').empty);
});

test('promo_costs routes: import preview → import, pork% carry-forward, pig price, settings, roles', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['A', 'admin'], ['M', 'manager'], ['SM', 'sales_manager'], ['S', 'sales']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO products(code,name) VALUES('P1','ไส้กรอก'),('P2','แฮม')").run();
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/promo_costs`;
  const call = async (route, method = 'GET', body, uid = 'A') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };

  // สิทธิ์ (ผู้ใช้สั่ง 2026-10-27): เห็นเฉพาะ admin/superadmin — manager / sales_manager / sales อ่านไม่ได้
  for (const uid of ['S', 'SM', 'M']) assert.equal((await call('/sku', 'GET', null, uid)).status, 403);
  assert.equal((await call('/sku', 'GET', null, 'A')).status, 200);
  const rows = [{ row: 2, code: 'P1', cost: 100, pork_pct: 0.5, unit: 'แพค' }, { row: 3, code: 'P2', cost: '80', pork_pct: '' }, { row: 4, code: 'X9', cost: 'abc' }];
  assert.equal((await call('/sku/import/preview', 'POST', { month: '2026-10', rows }, 'SM')).status, 403);

  const pv = (await call('/sku/import/preview', 'POST', { month: '2026-10', rows })).data;
  assert.equal(pv.new_count, 2);
  assert.equal(pv.invalid.length, 1);
  assert.deepEqual(pv.no_pork, ['P2']);
  const imp = (await call('/sku/import', 'POST', { month: '2026-10', rows, file: 'cost.xlsx' })).data;
  assert.deepEqual([imp.created, imp.updated], [2, 0]);

  // เดือนถัดไป ไฟล์ไม่มี %เนื้อหมู → ยกค่าเดือนก่อนมา
  const nov = (await call('/sku/import', 'POST', { month: '2026-11', rows: [{ row: 2, code: 'P1', cost: 104 }] })).data;
  assert.equal(nov.created, 1);
  const latest = (await call('/sku')).data;
  assert.deepEqual(latest.map(r => [r.sku, r.month, r.cost, r.pork_pct]), [['P1', '2026-11', 104, 0.5], ['P2', '2026-10', 80, null]]);

  // เติม %เนื้อหมูรายตัว + log
  assert.equal((await call('/sku/P2', 'PUT', { month: '2026-10', pork_pct: 40 })).data.pork_pct, 0.4);
  const logs = (await call('/sku/logs?sku=P2')).data;
  assert.ok(logs.some(l => l.field === 'pork_pct' && l.new_value === '0.4'));

  // ราคาหมู: เพิ่ม / แก้ / ลบ + log
  assert.equal((await call('/pig', 'PUT', { month: '2026-11', kind: 'forecast', price_per_kg: 88 })).data.price_per_kg, 88);
  await call('/pig', 'PUT', { month: '2026-11', kind: 'forecast', price_per_kg: 90 });
  assert.equal((await call('/pig', 'PUT', { month: '2026-11', kind: 'bogus', price_per_kg: 90 })).status, 400);
  assert.equal((await call('/pig', 'PUT', { month: '2026-11', kind: 'forecast', price_per_kg: null })).data.price_per_kg, null);
  assert.equal((await call('/pig')).data.length, 0);
  assert.deepEqual((await call('/pig/logs')).data.map(l => [l.old_value, l.new_value]), [[90, null], [88, 90], [null, 88]]);

  // เกณฑ์: manager แก้ไม่ได้ · null = กลับค่าเริ่มต้น
  assert.equal((await call('/settings', 'PUT', { g1_margin_ok: 0.12 }, 'M')).status, 403);
  assert.equal((await call('/settings', 'PUT', { g1_margin_ok: 0.12 }, 'A')).data.values.g1_margin_ok, 0.12);
  assert.equal(getSettings(db).g1_margin_ok, 0.12);
  assert.equal((await call('/settings', 'PUT', { g1_margin_ok: null }, 'A')).data.values.g1_margin_ok, 0.10);
});
