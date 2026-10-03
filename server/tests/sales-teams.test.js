const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ทีมขาย (2026-10-03): ทีมห้าง = แผนกขายธุรกิจค้าปลีก (Director ดูทั้งแผนก, Senior SM ดูลูกทีมที่เลือก)
// ทีมร้านค้า = ฝ่ายขายร้านค้า + ธุรกิจค้าส่ง (Sales Manager ดูทั้งแผนก) · Sales ดูของตัวเอง · ผู้บริหาร/admin ดูทั้งหมด
test('sales team scopes follow the org chart defaults and can be configured', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  const U = [
    ['DIR', 'sales_manager', 'แผนกขายธุรกิจค้าปลีก', 'Sales Director', '202'],
    ['SSM', 'sales_manager', 'แผนกขายธุรกิจค้าปลีก', 'Senior Sales Manager', ''],
    ['MT1', 'sales_officer', 'แผนกขายธุรกิจค้าปลีก', 'Sales', '207'],
    ['MT2', 'sales_officer', 'แผนกขายธุรกิจค้าปลีก', 'Sales', '211,21'],
    ['SM', 'sales_manager', 'ฝ่ายขายร้านค้า', 'Sales Manager', '500'],
    ['ST1', 'sales_officer', 'ฝ่ายขายร้านค้า', 'Sales', '103,17'],
    ['WSM', 'sales_manager', 'ธุรกิจค้าส่ง', 'Sales', '114'],
    ['WS1', 'sales_officer', 'ธุรกิจค้าส่ง', 'Sales', ''],
    ['EXE', 'superadmin', 'ผู้บริหาร', 'ผู้บริหาร', ''],
    ['AUD', 'sales_manager', 'Audit', 'Senior audit', ''],
  ];
  for (const [uid, role, dept, pos, codes] of U) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,position,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?,?)').run(uid, 'U ' + uid, role, dept, pos, codes || null, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'EXE') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  const me = async uid => (await call('/sales_teams/me', 'GET', null, uid)).data;

  // ค่าเริ่มต้นตามตำแหน่ง
  assert.deepEqual((await me('DIR')).codes.sort(), ['202', '207', '21', '211']);       // Director = ทั้งแผนก
  assert.equal((await me('SSM')).scope, 'members');
  assert.deepEqual((await me('SSM')).codes, []);                                       // ยังไม่เลือกลูกทีม
  assert.deepEqual((await me('MT1')).codes, ['207']);                                  // Sales = ตัวเอง
  assert.deepEqual((await me('SM')).codes.sort(), ['103', '17', '500']);              // ร้านค้า: ทั้งแผนก (ไม่รวมค้าส่ง)
  assert.deepEqual((await me('WSM')).codes, ['114']);                                  // ค้าส่ง: ทั้งแผนก
  const exe = await me('EXE');
  assert.equal(exe.all, true);
  assert.deepEqual(exe.filters.map(f => f.label), ['ทีมห้าง', 'แผนกขายธุรกิจค้าปลีก', 'ทีมร้านค้า', 'ฝ่ายขายร้านค้า', 'ธุรกิจค้าส่ง']);
  assert.deepEqual(exe.filters.find(f => f.label === 'ทีมร้านค้า').codes.sort(), ['103', '114', '17', '500']);
  assert.equal((await me('AUD')).all, true);                                           // ผู้จัดการแผนกอื่น = ทั้งหมด

  // ตั้งค่า: Sales แก้ไม่ได้, แผนกซ้ำ 2 ทีมไม่ได้, admin เลือกลูกทีม SSM + ผูกรหัส
  const teams = (await call('/sales_teams')).data.teams;
  assert.equal((await call('/sales_teams', 'PUT', { teams, scopes: {} }, 'SM')).status, 403);
  assert.equal((await call('/sales_teams', 'PUT', { teams: [...teams, { id: 'x', name: 'X', depts: ['ธุรกิจค้าส่ง'] }], scopes: {} })).status, 400);
  const put = await call('/sales_teams', 'PUT', { teams, scopes: { SSM: { scope: 'members', members: ['MT2', 'NOPE'] }, ST1: { scope: 'team' } }, slm_codes: { SSM: '208', WS1: '120, 120' } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual((await me('SSM')).codes.sort(), ['208', '21', '211']);
  assert.deepEqual((await me('ST1')).codes.sort(), ['103', '114', '120', '17', '500']); // ทั้งทีมร้านค้า
  assert.equal(db.prepare("SELECT slm_codes FROM sc_users WHERE uid='WS1'").get().slm_codes, '120');
  const list = (await call('/sales_teams')).data.users;
  assert.equal(list.find(u => u.uid === 'SSM').source, 'set');
  assert.deepEqual(list.find(u => u.uid === 'SSM').members, ['MT2']);
  assert.equal(list.find(u => u.uid === 'MT1').source, 'default');

  // ผู้บริหาร: ตั้งให้ดูเฉพาะทีมที่เลือก / เฉพาะคนที่เลือกจากทุกทีม (ค่าเริ่มต้น = ทั้งหมด)
  const scopes = (await call('/sales_teams')).data.scopes;
  assert.equal((await call('/sales_teams', 'PUT', { teams, scopes: { ...scopes, EXE: { scope: 'teams', teams: [] } } })).status, 400);
  assert.equal((await call('/sales_teams', 'PUT', { teams, scopes: { ...scopes, EXE: { scope: 'teams', teams: ['mt'] }, AUD: { scope: 'members', members: ['MT1', 'ST1'] } } })).status, 200);
  const ex = await me('EXE');
  assert.equal(ex.all, false);
  assert.deepEqual(ex.codes.sort(), ['202', '207', '208', '21', '211']);
  assert.deepEqual(ex.filters.map(f => f.label), ['ทีมห้าง', 'แผนกขายธุรกิจค้าปลีก']);
  assert.deepEqual((await me('AUD')).codes.sort(), ['103', '17', '207']);
});
