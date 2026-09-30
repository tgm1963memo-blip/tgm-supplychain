const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// 2026-09-30: ยกเลิกทั้งใบ/รายสินค้า, ขั้น "เฉพาะเมื่อมีรายการขาดทุน", เรียกเอกสารกลับ, log การดำเนินการ
async function setup(t) {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales_officer'], ['S2', 'sales_officer'], ['M', 'sales_manager'], ['A', 'sales_manager'], ['X', 'sales_manager'], ['ADM', 'superadmin']]) {
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
  const setRoute = levels => db.prepare('INSERT OR REPLACE INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify(levels));
  const mk = async (name, skus) => {
    const no = (await call('/promo_draft_headers', 'POST', { promo_name: name })).data.draft_no;
    for (const sku of skus) db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(no, 'C1', sku, 1);
    return no;
  };
  const r = no => `/promo_draft_headers?draft_no=eq.${no}`;
  const logs = async no => (await call(`/promo_draft_headers/${no}/logs`)).data.map(l => l.action);
  return { db, call, setRoute, mk, r, logs };
}

test('only_if_loss level is skipped when every line is profit, required when any line is loss', async t => {
  const { call, setRoute, mk, r, logs } = await setup(t);
  // เส้นทาง: ตรวจสอบ (audit) → ปกติ → เฉพาะเมื่อขาดทุน
  setRoute([
    { id: 'a', label: 'ตรวจสอบ', mode: 'any', audit_verdict: true, approvers: [{ uid: 'A', name: 'A' }] },
    { id: 'm', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'M' }] },
    { id: 'x', label: 'อนุมัติขาดทุน', mode: 'any', only_if_loss: true, approvers: [{ uid: 'X', name: 'X' }] },
  ]);
  // ขายได้หมด → ผ่านผู้จัดการแล้วจบ (ขั้น x ถูกข้าม)
  const n1 = await mk('profit', ['P1', 'P2']);
  assert.equal((await call(r(n1), 'PATCH', { status: 'pending_approval' })).status, 200);
  assert.equal((await call(r(n1), 'PATCH', { status: 'pending_approval', approval_line_verdicts: { P1: 'profit', P2: 'profit' } }, 'A')).status, 200);
  const done1 = await call(r(n1), 'PATCH', { status: 'pending_approval' }, 'M');
  assert.equal(done1.data[0].status, 'approved');
  assert.equal(done1.data[0].levels_json[2].skipped, 'no_loss');
  assert.ok((await logs(n1)).includes('skip_level'));
  // มีขาดทุน 1 รายการ → ต้องผ่านขั้น x
  const n2 = await mk('loss', ['P1', 'P2']);
  await call(r(n2), 'PATCH', { status: 'pending_approval' });
  await call(r(n2), 'PATCH', { status: 'pending_approval', approval_line_verdicts: { P1: 'profit', P2: 'loss' } }, 'A');
  const mid = await call(r(n2), 'PATCH', { status: 'pending_approval' }, 'M');
  assert.equal(mid.data[0].status, 'pending_approval');
  assert.equal(mid.data[0].current_level, 2);
  const fin = await call(r(n2), 'PATCH', { status: 'pending_approval' }, 'X');
  assert.equal(fin.data[0].status, 'approved');
  // ตั้งค่าเส้นทางที่ขั้น only_if_loss ไม่มีขั้นตรวจสอบก่อนหน้า → 400
  const bad = await call('/approval_workflow_templates', 'POST', { entity_type: 'promo_draft', levels_json: [{ id: 'x', label: 'x', mode: 'any', only_if_loss: true, approvers: [{ uid: 'X' }] }] }, 'ADM');
  assert.equal(bad.status, 400);
});

test('recall returns a pending document to draft and logs it', async t => {
  const { call, setRoute, mk, r, logs } = await setup(t);
  setRoute([{ id: 'm', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'M' }] }, { id: 'x', label: 'ผู้อำนวยการ', mode: 'any', approvers: [{ uid: 'X', name: 'X' }] }]);
  const no = await mk('recall', ['P1']);
  await call(r(no), 'PATCH', { status: 'pending_approval' });
  await call(r(no), 'PATCH', { status: 'pending_approval' }, 'M');
  assert.equal((await call(`/promo_draft_headers/${no}/recall`, 'POST', { note: 'แก้ราคา' }, 'S2')).status, 403); // ไม่ใช่ผู้ส่ง
  const rc = await call(`/promo_draft_headers/${no}/recall`, 'POST', { note: 'แก้ราคา' });
  assert.equal(rc.status, 200, JSON.stringify(rc.data));
  assert.equal(rc.data.status, 'draft');
  assert.deepEqual(rc.data.levels_json, []);
  const re = await call(r(no), 'PATCH', { status: 'pending_approval' });
  assert.equal(re.data[0].current_level, 0); // ส่งใหม่เริ่มขั้น 1
  assert.ok(re.data[0].levels_json.every(lv => lv.approvers.every(a => a.status === 'pending'))); // ผลอนุมัติเดิมไม่ติดมา
  assert.equal((await call(`/promo_draft_headers/${no}/recall`, 'POST', {}, 'S')).status, 200);
  const l = await logs(no);
  for (const a of ['create', 'submit', 'approve', 'recall']) assert.ok(l.includes(a), a + ' missing in ' + l.join(','));
});

test('cancel whole document or selected lines — sales requests with reason, chosen manager decides', async t => {
  const { call, setRoute, mk, r, logs } = await setup(t);
  setRoute([{ id: 'm', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'M' }] }]);
  const no = await mk('cancel', ['P1', 'P2', 'P3']);
  // ร่างยังขอยกเลิกไม่ได้
  assert.equal((await call(`/promo_draft_headers/${no}/cancel-request`, 'POST', { scope: 'all', reason: 'x', approver_uid: 'M' })).status, 400);
  await call(r(no), 'PATCH', { status: 'pending_approval' });
  await call(r(no), 'PATCH', { status: 'pending_approval' }, 'M');
  const url = `/promo_draft_headers/${no}/cancel-request`;
  assert.equal((await call(url, 'POST', { scope: 'lines', skus: ['P1'], reason: '', approver_uid: 'M' })).status, 400); // หมายเหตุบังคับ
  assert.equal((await call(url, 'POST', { scope: 'lines', skus: ['P1'], reason: 'ของหมด', approver_uid: 'S2' })).status, 400); // ไม่ใช่ manager
  assert.equal((await call(url, 'POST', { scope: 'lines', skus: ['ZZ'], reason: 'ของหมด', approver_uid: 'M' })).status, 400); // SKU ไม่อยู่ในเอกสาร
  const ok = await call(url, 'POST', { scope: 'lines', skus: ['P1'], reason: 'ของหมด', approver_uid: 'M' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.cancel_request_json.approver_uid, 'M');
  assert.equal((await call(url, 'POST', { scope: 'all', reason: 'ซ้ำ', approver_uid: 'M' })).status, 400); // มีคำขอค้างอยู่
  const dec = `/promo_draft_headers/${no}/cancel-decision`;
  assert.equal((await call(dec, 'POST', { approve: true }, 'X')).status, 403); // ไม่ใช่ผู้อนุมัติที่เลือก
  const a1 = await call(dec, 'POST', { approve: true, note: 'ok' }, 'M');
  assert.equal(a1.status, 200);
  assert.deepEqual(a1.data.cancelled_skus_json, ['P1']);
  assert.equal(a1.data.status, 'approved');
  assert.equal(a1.data.cancel_request_json, null);
  // ขอยกเลิก P1 ซ้ำไม่ได้ (ยกเลิกไปแล้ว)
  assert.equal((await call(url, 'POST', { scope: 'lines', skus: ['P1'], reason: 'x', approver_uid: 'M' })).status, 400);
  // ไม่อนุมัติ → ไม่เปลี่ยน
  await call(url, 'POST', { scope: 'all', reason: 'ลูกค้ายกเลิก', approver_uid: 'M' });
  const rj = await call(dec, 'POST', { approve: false, note: 'ยังขายได้' }, 'M');
  assert.equal(rj.data.status, 'approved');
  assert.equal(rj.data.cancel_history_json.length, 2);
  // ยกเลิกทั้งใบ → cancelled, แก้ไขต่อไม่ได้
  await call(url, 'POST', { scope: 'all', reason: 'ลูกค้ายกเลิก', approver_uid: 'M' });
  const all = await call(dec, 'POST', { approve: true }, 'M');
  assert.equal(all.data.status, 'cancelled');
  assert.equal((await call(r(no), 'PATCH', { promo_name: 'แก้' })).status, 400);
  assert.equal((await call(r(no), 'PATCH', { status: 'keyed_to_express' })).status, 400);
  const l = await logs(no);
  for (const a of ['cancel_request', 'cancel_approve', 'cancel_reject', 'approved_final']) assert.ok(l.includes(a), a + ' missing');
  // ยกเลิกรายสินค้าครบทุกตัว = cancelled ทั้งใบ
  const n2 = await mk('cancel2', ['Q1']);
  await call(r(n2), 'PATCH', { status: 'pending_approval' });
  await call(`/promo_draft_headers/${n2}/cancel-request`, 'POST', { scope: 'lines', skus: ['Q1'], reason: 'x', approver_uid: 'M' });
  assert.equal((await call(`/promo_draft_headers/${n2}/cancel-decision`, 'POST', { approve: true }, 'M')).data.status, 'cancelled');
  // client เขียน log เองไม่ได้ / แก้ cancel_* ผ่าน PATCH ไม่ได้
  const n3 = await mk('x', ['R1']);
  await call(r(n3), 'PATCH', { cancelled_skus_json: ['R1'], cancel_request_json: { scope: 'all' } });
  const h3 = (await call(r(n3).replace('?', '?') , 'GET')).data;
  assert.equal(h3[0].cancelled_skus_json ?? null, null);
});
