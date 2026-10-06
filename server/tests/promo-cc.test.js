const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
// ดักอีเมลก่อนโหลด app — promoApprovalMail ดึง sendMail ตอน require
const mailer = require('../lib/mailer');
const sent = [];
mailer.sendMail = async m => { sent.push(m); return { sent: true }; };
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// อีเมล CC ของเส้นทางอนุมัติใบเคาะราคา (2026-10-06)
test('route CC: validated on save, info mail on submit (no token links), cc on final result', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role, email] of [['S', 'sales', 's@x.co'], ['M', 'sales_manager', 'm@x.co'], ['A', 'admin', 'a@x.co']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash,email) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, 'x', email);
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'ผู้จัดการฝ่ายขาย', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
  ]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const saveCc = map => call('/approval_workflow_templates?upsert=true&onConflict=entity_type', 'POST', { entity_type: 'promo_draft_cc', levels_json: map }, 'A');
  assert.equal((await saveCc({ '': ['not-an-email'] })).status, 400);
  assert.equal((await saveCc({ 'bad id!': ['x@y.co'] })).status, 400);
  assert.equal((await saveCc(['x@y.co'])).status, 400);
  { const r = await saveCc({ '': ['boss@tgm.co.th', 's@x.co'] }); assert.ok([200, 201].includes(r.status), JSON.stringify(r)); }

  const made = await call('/promo_draft_headers', 'POST', { promo_name: 'ทดสอบ CC', start_date: '2026-11-01', due_date: '2026-11-30' });
  const no = made.data.draft_no;
  db.prepare("INSERT INTO promo_drafts(id,draft_no,cust_code,cust_name,corporate,sku,sku_name,normal_price,unit_price,compensate) VALUES('x1',?,'01-L2-0001','โลตัส','โลตัส','TG0026','สโมคเบค่อน',165,155,10)").run(no);
  const route = `/promo_draft_headers?draft_no=eq.${no}`;
  assert.equal((await call(route, 'PATCH', { status: 'pending_approval' })).status, 200);
  await new Promise(r => setTimeout(r, 100));
  const info = sent.find(m => /แจ้งเพื่อทราบ/.test(m.subject));
  assert.ok(info, 'CC info mail sent on submit');
  assert.equal(info.to, 'boss@tgm.co.th, s@x.co');
  assert.ok(!/promo_approve\//.test(info.html), 'CC mail must not carry approval token links');
  const approverMail = sent.find(m => m.to === 'm@x.co');
  assert.ok(approverMail && !approverMail.cc, 'approver token mail is not CC-ed');

  sent.length = 0;
  assert.equal((await call(route, 'PATCH', { status: 'approved' }, 'M')).status, 200);
  await new Promise(r => setTimeout(r, 100));
  const result = sent.find(m => /อนุมัติแล้ว/.test(m.subject));
  assert.ok(result, 'result mail sent');
  assert.equal(result.to, 's@x.co');
  assert.deepEqual(result.cc, ['boss@tgm.co.th'], 'creator removed from cc');
  assert.ok(!sent.some(m => /แจ้งเพื่อทราบ/.test(m.subject)), 'no repeat info mail when advancing');
});
