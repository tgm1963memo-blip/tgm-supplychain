const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// 2026-10-12: เลขาสร้างใบเคาะแทนคนในแผนก · ผู้มีสิทธิ์คีย์ Express · เห็นเฉพาะใบที่เกี่ยวข้อง · Inbox
test('secretary creates on behalf, keyer lock, related-only visibility, inbox', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD; delete process.env.SMTP_PASS;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role, dept] of [['SEC', 'sales_officer', 'ขาย A'], ['S1', 'sales_officer', 'ขาย A'], ['S2', 'sales_officer', 'ขาย B'],
    ['M', 'sales_manager', 'ขาย A'], ['K', 'Audit', 'บัญชี'], ['ADM', 'admin', 'IT']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,pwd_hash) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, dept, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft',
    JSON.stringify([{ id: 'l1', label: 'ผจก', mode: 'any', approvers: [{ uid: 'M', name: 'M' }] }]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S1') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const see = async (no, uid) => (await call(`/promo_draft_headers?draft_no=eq.${no}`, 'GET', undefined, uid)).data.length;

  // ตั้งค่าบทบาท: admin เท่านั้น
  const roles = { keyers: ['K'], secretaries: [{ uid: 'SEC', departments: ['ขาย A'] }] };
  assert.equal((await call('/promo_draft_headers/roles', 'PUT', roles, 'S1')).status, 403);
  assert.equal((await call('/approval_workflow_templates', 'POST', { entity_type: 'promo_roles', levels_json: roles }, 'ADM')).status, 400);
  assert.equal((await call('/promo_draft_headers/roles', 'PUT', roles, 'ADM')).status, 200);
  assert.deepEqual((await call('/promo_draft_headers/act-for', 'GET', undefined, 'SEC')).data.map(u => u.uid).sort(), ['M', 'S1']);

  // เลขาสร้างแทน S1 ได้ · แทน S2 (คนละแผนก) ไม่ได้ · Sales ทั่วไปสร้างแทนไม่ได้
  assert.equal((await call('/promo_draft_headers', 'POST', { promo_name: 'x', _on_behalf_of: 'S2' }, 'SEC')).status, 403);
  assert.equal((await call('/promo_draft_headers', 'POST', { promo_name: 'x', _on_behalf_of: 'M' }, 'S1')).status, 403);
  const made = await call('/promo_draft_headers', 'POST', { promo_name: 'แทน S1', _on_behalf_of: 'S1' }, 'SEC');
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.created_by, 'S1');
  assert.equal(made.data.created_by_actual, 'SEC');
  const no = made.data.draft_no;
  db.prepare("INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,'C1','P1',1)").run(no);

  // เห็นเฉพาะที่เกี่ยวข้อง: เจ้าของ + เลขา + admin · คนอื่น/คีย์เออร์ยังไม่เห็น (ยังไม่อนุมัติ)
  assert.equal(await see(no, 'S1'), 1);
  assert.equal(await see(no, 'SEC'), 1);
  assert.equal(await see(no, 'ADM'), 1);
  assert.equal(await see(no, 'S2'), 0);
  assert.equal(await see(no, 'K'), 0);
  assert.equal(await see(no, 'M'), 0, 'ผู้อนุมัติยังไม่เห็นก่อนส่ง');

  // เลขาส่งอนุมัติแทน → ผู้อนุมัติเห็น + Inbox มีรายการ
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'PATCH', { status: 'pending_approval' }, 'SEC')).status, 200);
  assert.equal(await see(no, 'M'), 1);
  const inboxM = (await call('/inbox', 'GET', undefined, 'M')).data;
  assert.equal(inboxM.actionable, 1);
  assert.equal(inboxM.items[0].kind, 'promo_approve');
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'PATCH', { status: 'approved' }, 'M')).status, 200);

  // อนุมัติแล้ว: คีย์เออร์เห็น + Inbox รอคีย์ · เจ้าของได้แจ้งผล · Sales ทั่วไปกดคีย์ไม่ได้
  assert.equal(await see(no, 'K'), 1);
  assert.ok((await call('/inbox', 'GET', undefined, 'K')).data.items.some(i => i.kind === 'promo_key'));
  assert.ok((await call('/inbox', 'GET', undefined, 'S1')).data.items.some(i => i.kind === 'promo_result'));
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'PATCH', { status: 'keyed_to_express' }, 'S1')).status, 400);
  // K เป็นฝ่ายบัญชี (ไม่ใช่ role ฝ่ายขาย) แต่อยู่ในรายชื่อผู้มีสิทธิ์คีย์ → กดคีย์ได้ แต่แก้ข้อมูลอื่นไม่ได้
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'PATCH', { promo_name: 'แก้' }, 'K')).status, 403);
  const keyed = await call(`/promo_draft_headers?draft_no=eq.${no}`, 'PATCH', { status: 'keyed_to_express', keyed_by: 'K', keyed_at: new Date().toISOString() }, 'K');
  assert.equal(keyed.status, 200, JSON.stringify(keyed.data));
  assert.equal(keyed.data[0].status, 'keyed_to_express');
});
