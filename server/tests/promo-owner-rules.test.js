const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// 2026-10-09 (ผู้ใช้ขอ): ขอยกเลิกได้เฉพาะเจ้าของเอกสาร/admin · ผู้ส่งแก้รายชื่อผู้อนุมัติของแต่ละขั้นในเอกสารได้ (เหลืออย่างน้อย 1 คน)
async function setup(t) {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD; delete process.env.SMTP_PASS;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales_officer'], ['S2', 'sales_officer'], ['M', 'sales_manager'], ['M2', 'sales_manager'], ['ADM', 'admin']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  db.prepare('INSERT OR REPLACE INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'เลขา', mode: 'any', approvers: [{ uid: 'M', name: 'M' }, { uid: 'M2', name: 'M2' }] },
  ]));
  const mk = async (uid = 'S') => {
    const no = (await call('/promo_draft_headers', 'POST', { promo_name: 'T' }, uid)).data.draft_no;
    db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(no, 'C1', 'P1', 1);
    return no;
  };
  const r = no => `/promo_draft_headers?draft_no=eq.${no}`;
  return { call, mk, r };
}

test('cancel request: only the document owner or admin', async t => {
  const { call, mk, r } = await setup(t);
  const no = await mk('S');
  await call(r(no), 'PATCH', { status: 'pending_approval' }, 'S');
  const body = { scope: 'all', reason: 'x', approver_uid: 'M' };
  // M2 เห็นเอกสารได้ (ผู้จัดการ) แต่ไม่ใช่เจ้าของ/admin · S2 เห็นไม่ได้ตั้งแต่แรก (scope)
  assert.equal((await call(`/promo_draft_headers/${no}/cancel-request`, 'POST', body, 'M2')).status, 403);
  assert.equal((await call(`/promo_draft_headers/${no}/recall`, 'POST', {}, 'M2')).status, 403);
  assert.notEqual((await call(`/promo_draft_headers/${no}/cancel-request`, 'POST', body, 'S2')).status, 200);
  assert.equal((await call(`/promo_draft_headers/${no}/cancel-request`, 'POST', body, 'ADM')).status, 200);
});

test('owner can override approvers per level on submit; others cannot; level cannot be emptied', async t => {
  const { call, mk, r } = await setup(t);
  const no = await mk('S');
  const empty = await call(r(no), 'PATCH', { status: 'pending_approval', approver_overrides: { l1: [] } }, 'S');
  assert.equal(empty.status, 400);
  const other = await call(r(no), 'PATCH', { status: 'pending_approval', approver_overrides: { l1: ['M'] } }, 'S2');
  assert.notEqual(other.status, 200);
  // (2026-10-12, security review) ผู้สร้างใส่ตัวเองเป็นผู้อนุมัติแทนรายชื่อกลางไม่ได้ (เดิมอนุมัติเองจนจบได้)
  const self = await call(r(no), 'PATCH', { status: 'pending_approval', approver_overrides: { l1: ['S'] } }, 'S');
  assert.equal(self.status, 400);
  assert.equal((await call(r(no), 'PATCH', { status: 'pending_approval', approver_overrides: { l1: ['M', 'S'] } }, 'S')).status, 400);
  const ok = await call(r(no), 'PATCH', { status: 'pending_approval', approver_overrides: { l1: ['M2'] } }, 'S');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data[0].levels_json[0].approvers.map(a => a.uid), ['M2']);
});
