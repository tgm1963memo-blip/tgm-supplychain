const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// เส้นทางอนุมัติหลายแบบ (2026-09-24): route_id → ขั้นจาก 'promo_draft@<id>', ว่าง → 'promo_draft' มาตรฐาน
test('promo draft approval routes', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales'], ['M', 'sales_manager'], ['L', 'sales_manager'], ['A', 'admin']]) {
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
  const saveTpl = (entity_type, levels_json) => call('/approval_workflow_templates?upsert=true&onConflict=entity_type', 'POST', { entity_type, levels_json }, 'A');

  // รายการเส้นทาง: รูปแบบผิด → 400, ถูกต้อง → บันทึกได้ (ไม่ถูกตรวจแบบขั้นอนุมัติ)
  assert.equal((await saveTpl('promo_draft_routes', [{ id: 'bad id!', name: 'x' }])).status, 400);
  assert.equal((await saveTpl('promo_draft_routes', [{ id: 'lotus', name: '' }])).status, 400);
  assert.ok([200, 201].includes((await saveTpl('promo_draft_routes', [{ id: 'lotus', name: 'โลตัส', match: { corps: ['โลตัส'] } }])).status));
  assert.ok([200, 201].includes((await saveTpl('promo_draft', [{ id: 'm1', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] }])).status));
  assert.ok([200, 201].includes((await saveTpl('promo_draft@lotus', [{ id: 'l1', label: 'ผจก.โลตัส', mode: 'any', approvers: [{ uid: 'L', name: 'User L' }] }])).status));

  // ขั้น "ผู้สร้างเลือกเอง" ปล่อยรายชื่อว่างได้ — บันทึกผ่าน API ได้ (เดิม validateWorkflow ตีกลับ 400)
  assert.ok([200, 201].includes((await saveTpl('promo_draft@pick', [{ id: 'p1', label: 'เซลล์', mode: 'any', pick_by_creator: true, approvers: [] },
    { id: 'p2', label: 'ผจก.', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] }])).status));
  // ขั้นปกติที่ไม่มีผู้อนุมัติยังต้องถูกตีกลับ
  assert.equal((await saveTpl('promo_draft@pick', [{ id: 'p1', label: 'เซลล์', mode: 'any', approvers: [] }])).status, 400);
  // ขั้นเลือกเองที่ mode ผิด / ขั้นผู้บริหารแบบเลือกเองว่าง → ตีกลับ
  assert.equal((await saveTpl('promo_draft@pick', [{ id: 'p1', mode: 'x', pick_by_creator: true, approvers: [] }])).status, 400);
  assert.equal((await saveTpl('promo_draft_exec', [{ id: 'e1', mode: 'any', pick_by_creator: true, approvers: [] }])).status, 400);
  // รหัสเส้นทางต้องเป็นข้อความ
  assert.equal((await saveTpl('promo_draft_routes', [{ id: 5, name: 'A' }])).status, 400);

  const mk = async name => (await call('/promo_draft_headers', 'POST', { promo_name: name })).data.draft_no;
  const route = no => `/promo_draft_headers?draft_no=eq.${no}`;

  // เลือกเส้นทางโลตัส → ขั้นมาจาก promo_draft@lotus + เก็บ route_name
  const a = await mk('route lotus');
  const sa = await call(route(a), 'PATCH', { status: 'pending_approval', route_id: 'lotus', route_name: 'ปลอม' });
  assert.equal(sa.status, 200);
  assert.deepEqual(sa.data[0].levels_json[0].approvers.map(x => x.uid), ['L']);
  assert.equal(sa.data[0].route_id, 'lotus');
  assert.equal(sa.data[0].route_name, 'โลตัส');
  // ห้ามเปลี่ยนเส้นทางระหว่างรออนุมัติ
  assert.equal((await call(route(a), 'PATCH', { route_id: '' }, 'L')).status, 400);
  // ผู้อนุมัติเส้นทางโลตัสอนุมัติได้ → อนุมัติครบ
  const ap = await call(route(a), 'PATCH', { status: 'pending_approval' }, 'L');
  assert.equal(ap.status, 200); assert.equal(ap.data[0].status, 'approved');

  // ไม่ส่ง route_id → มาตรฐาน
  const b = await mk('route std');
  const sb = await call(route(b), 'PATCH', { status: 'pending_approval', route_id: '' });
  assert.equal(sb.status, 200);
  assert.deepEqual(sb.data[0].levels_json[0].approvers.map(x => x.uid), ['M']);
  assert.equal(sb.data[0].route_id, null);

  // เส้นทางที่ไม่มีอยู่ → 400 และสถานะยังเป็นร่าง
  const c = await mk('route missing');
  assert.equal((await call(route(c), 'PATCH', { status: 'pending_approval', route_id: 'nope' })).status, 400);
  assert.equal((await call(route(c))).data[0].status, 'draft');
  // เส้นทางที่มีในรายการแต่ยังไม่มีขั้นอนุมัติ → 400 (ไม่ตกไปกรณี "ไม่มี route" ที่ผู้จัดการอนุมัติเองได้)
  assert.ok([200, 201].includes((await saveTpl('promo_draft_routes', [{ id: 'lotus', name: 'โลตัส' }, { id: 'empty', name: 'ว่าง' }])).status));
  assert.equal((await call(route(c), 'PATCH', { status: 'pending_approval', route_id: 'empty' })).status, 400);
  assert.equal((await call(route(c))).data[0].status, 'draft');

  // คัดลอกไฟล์แนบจากเอกสารต้นทาง → เอกสารใหม่ (ฝั่ง server)
  db.prepare("INSERT INTO promo_draft_attachments (id,draft_no,filename,mime_type,content,uploaded_by) VALUES ('PDA1',?,'a.pdf','application/pdf',?, 'S')").run(a, Buffer.from('%PDF-1.4'));
  const copy = async (to, from) => (await fetch(`${base}/promo_draft_attachments/${to}/copy-from/${from}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.S}` } }));
  const cp = await copy(c, a);
  assert.equal(cp.status, 201); assert.equal((await cp.json()).copied, 1);
  const got = db.prepare('SELECT filename, content FROM promo_draft_attachments WHERE draft_no=?').all(c);
  assert.equal(got.length, 1); assert.equal(Buffer.from(got[0].content).toString(), '%PDF-1.4');
  // ปลายทางที่ส่งอนุมัติแล้ว (a อนุมัติแล้ว) → คัดลอกเข้าไม่ได้
  assert.equal((await copy(a, c)).status, 400);
});
