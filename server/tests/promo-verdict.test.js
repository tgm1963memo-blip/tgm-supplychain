const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ผลตรวจสอบ ขายได้/ขาดทุน รายบรรทัดสินค้า (2026-09-24): เฉพาะขั้นที่ตั้ง audit_verdict ต้องเลือกครบทุก SKU ตอนอนุมัติ
test('per-line audit verdicts (profit/loss) only at the review step', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales'], ['M', 'sales_manager'], ['C', 'sales_manager']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
    { id: 'l2', label: 'ตรวจสอบ', mode: 'any', audit_verdict: true, approvers: [{ uid: 'C', name: 'User C' }] },
  ]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const mk = async (name, skus) => {
    const no = (await call('/promo_draft_headers', 'POST', { promo_name: name })).data.draft_no;
    // 2 สาขา × SKU — ผลตรวจสอบนับต่อ SKU (ไม่ใช่ต่อสาขา)
    for (const sku of skus) for (const cc of ['C1', 'C2']) db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(no, cc, sku, 1);
    return no;
  };
  const no = await mk('verdict', ['A', 'B']);
  const r = `/promo_draft_headers?draft_no=eq.${no}`;
  const sent = await call(r, 'PATCH', { status: 'pending_approval' });
  assert.equal(sent.status, 200);
  assert.equal(sent.data[0].levels_json[1].audit_verdict, true); // คัดลอกค่าขั้นตรวจสอบลงเอกสาร
  // ขั้นที่ 1 (ไม่ใช่ขั้นตรวจสอบ) ส่งผลมาไม่ได้
  assert.equal((await call(r, 'PATCH', { status: 'pending_approval', approval_line_verdicts: { A: 'profit' } }, 'M')).status, 400);
  assert.equal((await call(r, 'PATCH', { status: 'pending_approval' }, 'M')).status, 200);
  // ขั้นตรวจสอบ: ไม่ส่ง → 400, ขาดบาง SKU → 400, ค่าผิด → 400
  assert.equal((await call(r, 'PATCH', { status: 'pending_approval' }, 'C')).status, 400);
  const miss = await call(r, 'PATCH', { status: 'pending_approval', approval_line_verdicts: { A: 'profit' } }, 'C');
  assert.equal(miss.status, 400); assert.match(miss.data.error, /B/);
  assert.equal((await call(r, 'PATCH', { status: 'pending_approval', approval_line_verdicts: { A: 'profit', B: 'maybe' } }, 'C')).status, 400);
  // ครบ → อนุมัติครบ + เก็บผลรายบรรทัด (ค่าที่ไม่ใช่ SKU ของเอกสารไม่ถูกเก็บ)
  const ok = await call(r, 'PATCH', { status: 'pending_approval', approval_line_verdicts: { A: 'profit', B: 'loss', ZZ: 'loss' }, approval_comment: 'B ทุนต่ำกว่าราคาขาย' }, 'C');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data[0].status, 'approved');
  assert.deepEqual(ok.data[0].levels_json[1].approvers[0].line_verdicts, { A: 'profit', B: 'loss' });

  // เอกสารไม่มีบรรทัดสินค้า (นอกสัญญา) → ขั้นตรวจสอบอนุมัติได้โดยไม่ต้องมีผล
  const off = await mk('off', []);
  const ro = `/promo_draft_headers?draft_no=eq.${off}`;
  assert.equal((await call(ro, 'PATCH', { status: 'pending_approval' })).status, 200);
  assert.equal((await call(ro, 'PATCH', { status: 'pending_approval' }, 'M')).status, 200);
  const offOk = await call(ro, 'PATCH', { status: 'pending_approval' }, 'C');
  assert.equal(offOk.status, 200); assert.equal(offOk.data[0].status, 'approved');
});
