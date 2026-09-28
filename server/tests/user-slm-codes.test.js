const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ผูกผู้ใช้กับรหัส Sales ใน Express (2026-09-28): sc_users.slm_codes คั่นด้วย , และ dashboard กรองได้หลายรหัส
test('users can be linked to several Express salesman codes', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('A', 'Admin', 'superadmin', 'x');
  db.prepare('INSERT INTO sc_users(uid,name,role,slm_id,pwd_hash) VALUES(?,?,?,?,?)').run('S', 'Sales', 'sales_officer', 'piyaporn', 'x');
  const tokA = createSession(db, 'A').token, tokS = createSession(db, 'S').token;
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method, body, tok = tokA) => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  // บันทึก: ตัดช่องว่าง/ซ้ำ · slm_id เดิมไม่ถูกแตะ
  const up = await call('/sc_users?upsert=true', 'POST', { uid: 'S', name: 'Sales', role: 'sales_officer', slm_codes: ' 213, 110-1,,213 ' });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.slm_codes, '213,110-1');
  assert.equal(up.data.slm_id, 'piyaporn');
  const list = await call('/v_sc_users_safe?uid=eq.S', 'GET', null, tokS);
  assert.equal(list.data[0].slm_codes, '213,110-1');
  // /auth/me ส่ง slm_codes กลับไปให้ client
  const me = await call('/auth/me', 'GET', null, tokS);
  assert.equal(me.data.slm_codes, '213,110-1');
  // ล้างค่า = null
  const clr = await call('/sc_users?uid=eq.S', 'PATCH', { slm_codes: '' });
  assert.equal(clr.data.slm_codes, null);

  // dashboard_sales_summary รับหลายรหัส
  for (const [slm, amt] of [['213', 100], ['110-1', 50], ['999', 7]]) {
    db.prepare("INSERT INTO v_sales_overview_sales_monthly(ym,company,slm_owner,cust_code,prod_code,qty,amount,invoice_count) VALUES('2026-09','TSS',?,'C1','P1',1,?,1)").run(slm, amt);
  }
  const one = await call('/dashboard_sales_summary?startYm=2026-09&endYm=2026-09&slmId=213', 'GET');
  const two = await call('/dashboard_sales_summary?startYm=2026-09&endYm=2026-09&slmId=213,110-1', 'GET');
  const all = await call('/dashboard_sales_summary?startYm=2026-09&endYm=2026-09', 'GET');
  const tot = d => JSON.stringify(d);
  assert.equal(one.status, 200, tot(one.data));
  assert.match(tot(one.data), /100/);
  assert.match(tot(two.data), /150/);
  assert.match(tot(all.data), /157/);
});
