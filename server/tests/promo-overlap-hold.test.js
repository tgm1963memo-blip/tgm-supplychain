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

// ใบเคาะที่ช่วงโปรซ้อน (2026-10-06): ส่งอนุมัติได้ · หลังขั้นตรวจสอบ (หรือขั้นแรกถ้าไม่มีขั้นตรวจสอบ) พักให้ Sales
// ยกเลิกโปรเก่า — ใบเคาะในระบบต้องยกเลิกจริง ใบ Express ต้องติ๊กยืนยัน — แล้วจึงเดินขั้นถัดไป
test('overlap hold: pause after audit level, block next approver, clear rules, finalize', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role, email] of [['S', 'sales', 's@x.co'], ['A', 'sales_manager', 'a@x.co'], ['M', 'sales_manager', 'm@x.co'], ['X', 'admin', 'x@x.co']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash,email) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, 'x', email);
    tokens[uid] = createSession(db, uid).token;
  }
  const setRoute = levels => db.prepare(`INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES('promo_draft',?)
    ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json`).run(JSON.stringify(levels));
  setRoute([
    { id: 'l1', label: 'ตรวจสอบ', mode: 'any', audit_verdict: true, approvers: [{ uid: 'A', name: 'User A' }] },
    { id: 'l2', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
  ]);
  // ใบโปร Express เดิมที่ทับช่วง (สาขา/สินค้าเดียวกัน)
  db.prepare(`INSERT INTO promo_docs(company,sonum,seqnum,cust_code,cust_name,sku,sku_name,unit_price,start_date,due_date,docstat,doc_ref)
    VALUES('TSS','P1-0001','1','01-L2-0001','โลตัส','TG0026','สโมคเบค่อน',150,'2026-10-15','2026-11-15','M','LT-0154')`).run();

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const tick = () => new Promise(r => setTimeout(r, 80));
  const mkDraft = async (name, sku, start, due) => {
    const made = await call('/promo_draft_headers', 'POST', { promo_name: name, start_date: start, due_date: due });
    const no = made.data.draft_no;
    db.prepare(`INSERT INTO promo_drafts(id,draft_no,cust_code,cust_name,corporate,sku,sku_name,normal_price,unit_price,compensate,start_date,due_date)
      VALUES(?,?,'01-L2-0001','โลตัส','โลตัส',?,'x',165,155,10,?,?)`).run('L' + no, no, sku, start, due);
    return { no, route: `/promo_draft_headers?draft_no=eq.${no}` };
  };

  // ── เคส 1: มีขั้นตรวจสอบ ──
  const d1 = await mkDraft('ซ้อน Express', 'TG0026', '2026-11-01', '2026-11-30');
  assert.equal((await call(d1.route, 'PATCH', { status: 'pending_approval' })).status, 200, 'ส่งอนุมัติได้แม้ซ้อน');
  sent.length = 0;
  const audit = await call(d1.route, 'PATCH', { status: 'approved', approval_line_verdicts: { TG0026: 'profit' } }, 'A');
  assert.equal(audit.status, 200, JSON.stringify(audit.data));
  const h1 = audit.data[0];
  assert.equal(h1.status, 'pending_approval');
  assert.equal(h1.current_level, 1);
  assert.ok(h1.overlap_hold_json && !h1.overlap_hold_json.cleared_at, 'พักรอ Sales');
  assert.equal(h1.overlap_hold_json.docs[0].ref, 'LT-0154');
  await tick();
  assert.ok(sent.some(m => m.to === 's@x.co' && /ยกเลิกโปรเก่า/.test(m.subject)), 'แจ้ง Sales');
  assert.ok(!sent.some(m => m.to === 'm@x.co'), 'ยังไม่แจ้งผู้อนุมัติลำดับถัดไป');
  assert.equal((await call(d1.route, 'PATCH', { status: 'approved' }, 'M')).status, 400, 'ผู้อนุมัติถัดไปกดอนุมัติไม่ได้ระหว่างพัก');
  assert.equal((await call(d1.route, 'PATCH', { overlap_hold_json: null })).status, 400, 'client แก้สถานะพักเองไม่ได้');
  assert.equal((await call(`/promo_draft_headers/${d1.no}/overlap_clear`, 'POST', { confirm: [] }, 'M')).status, 403, 'เฉพาะผู้สร้าง');
  assert.equal((await call(`/promo_draft_headers/${d1.no}/overlap_clear`, 'POST', { confirm: [] })).status, 400, 'ต้องติ๊กใบ Express');
  const key = h1.overlap_hold_json.docs[0].key;
  sent.length = 0;
  const clr = await call(`/promo_draft_headers/${d1.no}/overlap_clear`, 'POST', { confirm: [key], note: 'ยกเลิกใน Express แล้ว' });
  assert.equal(clr.status, 200, JSON.stringify(clr.data));
  assert.ok(clr.data.overlap_hold_json.cleared_at);
  await tick();
  assert.ok(sent.some(m => m.to === 'm@x.co'), 'แจ้งผู้อนุมัติลำดับถัดไปหลังยืนยัน');
  const fin = await call(d1.route, 'PATCH', { status: 'approved' }, 'M');
  assert.equal(fin.status, 200);
  assert.equal(fin.data[0].status, 'approved');

  // ── เคส 2: ไม่มีขั้นตรวจสอบ (ขั้นเดียว) + ซ้อนกับใบเคาะในระบบ (d1) และ Express → พักหลังขั้นแรก (ขั้นสุดท้าย) ──
  setRoute([{ id: 'm1', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] }]);
  const d2 = await mkDraft('ซ้อนใบเคาะ', 'TG0026', '2026-11-10', '2026-11-20');
  assert.equal((await call(d2.route, 'PATCH', { status: 'pending_approval' })).status, 200);
  const a2 = await call(d2.route, 'PATCH', { status: 'approved' }, 'M');
  assert.equal(a2.data[0].status, 'pending_approval', 'ครบทุกขั้นแล้วแต่ยังพัก');
  const docs2 = a2.data[0].overlap_hold_json.docs;
  assert.deepEqual(docs2.map(o => o.kind).sort(), ['draft', 'express']);
  const allKeys = docs2.map(o => o.key);
  const blocked = await call(`/promo_draft_headers/${d2.no}/overlap_clear`, 'POST', { confirm: allKeys });
  assert.equal(blocked.status, 400, 'ใบเคาะในระบบที่ซ้อนต้องยกเลิกก่อน');
  // ยกเลิก d1 ผ่านขั้นตอนยกเลิกปกติ
  assert.equal((await call(`/promo_draft_headers/${d1.no}/cancel-request`, 'POST', { scope: 'all', reason: 'ซ้อนกับใบใหม่', approver_uid: 'X' })).status, 200);
  assert.equal((await call(`/promo_draft_headers/${d1.no}/cancel-decision`, 'POST', { approve: true }, 'X')).status, 200);
  const ok2 = await call(`/promo_draft_headers/${d2.no}/overlap_clear`, 'POST', { confirm: allKeys });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.data));
  assert.equal(ok2.data.status, 'approved', 'ขั้นสุดท้ายผ่านแล้ว → อนุมัติหลังยืนยัน');
  assert.ok(ok2.data.promo_no, 'ออกเลขใบโปร');

  // ── เคส 3: ไม่ซ้อน → เดินขั้นปกติ ──
  const d3 = await mkDraft('ไม่ซ้อน', 'TG9999', '2026-11-01', '2026-11-30');
  assert.equal((await call(d3.route, 'PATCH', { status: 'pending_approval' })).status, 200);
  const a3 = await call(d3.route, 'PATCH', { status: 'approved' }, 'M');
  assert.equal(a3.data[0].status, 'approved');
  assert.ok(!a3.data[0].overlap_hold_json);
});
