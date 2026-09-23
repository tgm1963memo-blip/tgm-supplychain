const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const promoMail = require('../lib/promoApprovalMail');

// อนุมัติใบเคาะราคาผ่านอีเมล + ผู้อนุมัติที่ไม่ใช่ฝ่ายขาย (2026-09-23)
test('email approval tokens: submit issues links, GET confirms, POST approves once, next level + non-sales approver', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD; // ไม่ส่งจริง — mailer แค่ log
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role, email] of [['S', 'sales', 's@x.co'], ['M', 'sales_manager', 'm@x.co'], ['P', 'planning_manager', 'p@x.co']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash,email) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, 'x', email);
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'ผู้จัดการฝ่ายขาย', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
    { id: 'l2', label: 'ฝ่ายวางแผน', mode: 'any', approvers: [{ uid: 'P', name: 'User P' }] },
  ]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const made = await call('/promo_draft_headers', 'POST', { promo_name: 'ทดสอบอีเมล', start_date: '2026-11-01', due_date: '2026-11-30' });
  const no = made.data.draft_no;
  db.prepare("INSERT INTO promo_drafts(id,draft_no,cust_code,cust_name,corporate,sku,sku_name,normal_price,unit_price,compensate) VALUES('x1',?,'01-L2-0001','โลตัส','โลตัส','TG0026','สโมคเบค่อน',165,155,10)").run(no);
  const route = `/promo_draft_headers?draft_no=eq.${no}`;

  // ส่งอนุมัติ → ออก token ให้ M (ขั้นที่ 1)
  assert.equal((await call(route, 'PATCH', { status: 'pending_approval' })).status, 200);
  await new Promise(r => setTimeout(r, 100));
  const tokM = db.prepare("SELECT * FROM promo_approval_tokens WHERE draft_no=? AND uid='M'").get(no);
  assert.ok(tokM, 'token issued for level-1 approver');

  // GET = หน้ายืนยัน ไม่เปลี่ยนสถานะ
  const page = await fetch(`${base}/promo_approve/${tokM.token}?action=approve`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ยืนยันอนุมัติ/);
  assert.equal((await call(route)).data[0].current_level, 0);
  assert.equal((await fetch(`${base}/promo_approve/not-a-token`)).status, 404);

  // POST อนุมัติ → ขั้นที่ 2, ความเห็นถูกเก็บ, token ใหม่ของ P
  const post = await fetch(`${base}/promo_approve/${tokM.token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=approve&comment=' + encodeURIComponent('โอเค <b>ok</b>') });
  assert.equal(post.status, 200);
  const h1 = (await call(route)).data[0];
  assert.equal(h1.status, 'pending_approval'); assert.equal(h1.current_level, 1);
  const mEntry = h1.levels_json[0].approvers.find(a => a.uid === 'M');
  assert.equal(mEntry.status, 'approved'); assert.equal(mEntry.comment, 'โอเค ok');
  // ลิงก์เดิมใช้ซ้ำไม่ได้
  assert.equal((await fetch(`${base}/promo_approve/${tokM.token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=approve' })).status, 409);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(db.prepare("SELECT 1 FROM promo_approval_tokens WHERE draft_no=? AND uid='P'").get(no), 'next level approver notified');

  // ผู้อนุมัติฝ่ายวางแผน (ไม่มี role ฝ่ายขาย): แก้ข้อมูลอื่นไม่ได้ แต่อนุมัติในระบบได้เมื่อถึงคิว
  assert.equal((await call(route, 'PATCH', { promo_name: 'แก้ชื่อ' }, 'P')).status, 403);
  const done = await call(route, 'PATCH', { status: 'pending_approval' }, 'P');
  assert.equal(done.status, 200); assert.equal(done.data[0].status, 'approved');
  // หลังจบแล้วฝ่ายวางแผน PATCH ไม่ได้อีก
  assert.equal((await call(route, 'PATCH', { status: 'approved' }, 'P')).status, 403);

  // อีเมลมีปุ่มอนุมัติ/ไม่อนุมัติ/เปิดในระบบ
  const header = db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no=?').get(no);
  const mail = promoMail.renderApprovalRequestEmail({ header, sum: promoMail.docSummary(db, header), approverName: 'User M', stepLabel: 'ขั้นที่ 1',
    approveUrl: 'https://x/api/promo_approve/T?action=approve', rejectUrl: 'https://x/api/promo_approve/T?action=reject', openUrl: 'https://app/?draft=' + no });
  assert.match(mail.html, /อนุมัติ/); assert.match(mail.html, /ไม่อนุมัติ/); assert.match(mail.html, /เปิดดูในระบบ/); assert.match(mail.html, /TG0026/);
});
