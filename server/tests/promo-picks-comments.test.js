const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ขั้น "ผู้สร้างเลือกผู้อนุมัติเอง" + คอมเมนต์ลอยปักตำแหน่ง (2026-09-24)
test('creator-picked approval step and anchored comments', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales'], ['M', 'sales_manager'], ['P', 'planning_manager'], ['X', 'planning']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'เซลล์', mode: 'any', pick_by_creator: true, default_self: true, approvers: [] },
    { id: 'l2', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
  ]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const no = (await call('/promo_draft_headers', 'POST', { promo_name: 'pick test' })).data.draft_no;
  const route = `/promo_draft_headers?draft_no=eq.${no}`;
  // ขั้นที่ต้องเลือกแต่ไม่ได้เลือก + ไม่มีค่าแนะนำ → ส่งไม่ได้
  assert.equal((await call(route, 'PATCH', { status: 'pending_approval', picked_approvers: {} })).status, 400);
  // ผู้สร้างเลือกตัวเองเป็นขั้นที่ 1
  const sent = await call(route, 'PATCH', { status: 'pending_approval', picked_approvers: { l1: ['S'] } });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.data[0].levels_json[0].approvers.map(a => a.uid), ['S']);
  assert.equal(sent.data[0].levels_json[0].approvers[0].name, 'User S');
  // ผู้สร้างอนุมัติขั้นตัวเองได้ → ขั้น 2
  const a1 = await call(route, 'PATCH', { status: 'pending_approval', approval_comment: 'ตรวจแล้ว' });
  assert.equal(a1.status, 200); assert.equal(a1.data[0].current_level, 1);
  assert.equal(a1.data[0].levels_json[0].approvers[0].comment, 'ตรวจแล้ว');

  // คอมเมนต์ลอย: role ฝ่ายขายได้, คนนอกเอกสารที่ไม่ใช่ฝ่ายขายไม่ได้, ผู้อนุมัติต่างแผนกได้
  db.prepare("UPDATE promo_draft_headers SET levels_json = json_insert(levels_json, '$[1].approvers[#]', json('{\"uid\":\"P\",\"name\":\"User P\",\"status\":\"pending\"}')) WHERE draft_no = ?").run(no);
  assert.equal((await call('/promo_draft_line_comments', 'POST', { draft_no: no, anchor: 'cell:TG0026:8|TG0026 · GP%', text: 'GP ต่ำไป' }, 'S')).status, 201);
  assert.equal((await call('/promo_draft_line_comments', 'POST', { draft_no: no, anchor: 'field:draft-purpose|วัตถุประสงค์', text: 'ขอเพิ่ม' }, 'X')).status, 403);
  assert.equal((await call('/promo_draft_line_comments', 'POST', { draft_no: no, anchor: 'field:draft-purpose|วัตถุประสงค์', text: 'ขอเพิ่ม' }, 'P')).status, 201);
  assert.equal((await call('/promo_draft_line_comments', 'POST', { draft_no: no, text: 'no target' }, 'S')).status, 400);
  const rows = (await call(`/promo_draft_line_comments?draft_no=eq.${no}`, 'GET', undefined, 'P')).data;
  assert.equal(rows.filter(r => r.anchor).length, 2);
  assert.equal(rows.find(r => r.uid === 'P').sku, '');
});
