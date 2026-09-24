const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// เลขที่ใบโปรแยกตามลูกค้า (2026-09-24): ต่อเลขชุดเดิมของกลุ่มลูกค้าใน Express (LT-0149 → LT-0150)
test('promo_no continues the customer group series from Express', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales'], ['M', 'sales_manager'], ['A', 'admin']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  // สาขาโลตัส (01-L2) / ฝั่ง CONSI (BB-L2) / สำนักงานใหญ่ TSS (30-NU) — ชื่อกลุ่มต่างกันแต่เป็นลูกค้าเดียวกัน
  for (const [code, corp] of [['01-L2-0001', 'โลตัส'], ['01-L2-0002', 'โลตัส'], ['BB-L2-0001', 'โลตัส (ยอดสั่ง)'], ['30-NU-0001', 'โลตัส TGM'], ['30-CJ-0001', 'ซี.เจ'], ['99-XX-0001', 'ลูกค้าใหม่']]) {
    db.prepare('INSERT OR IGNORE INTO customers(code,name) VALUES(?,?)').run(code, code);
    db.prepare('INSERT INTO customer_profiles(code,corporate) VALUES(?,?)').run(code, corp);
  }
  const doc = db.prepare('INSERT INTO promo_docs(company,sonum,seqnum,cust_code,sku,unit_price,doc_ref) VALUES(?,?,?,?,?,?,?)');
  doc.run('TSS', 'P1', '1', '30-NU-0001', 'A', 10, 'LT-0149 compensate..');
  doc.run('CONSI', 'P2', '1', 'BB-L2-0001', 'A', 10, 'LT-0120');
  doc.run('TSS', 'P3', '1', '30-CJ-0001', 'A', 10, 'CJ-0083 compensate');

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  // สร้าง → ใส่บรรทัดสาขา → ส่ง (ไม่มีเส้นทาง) → ผู้จัดการอนุมัติ → ได้ promo_no
  const approve = async (name, branches) => {
    const no = (await call('/promo_draft_headers', 'POST', { promo_name: name })).data.draft_no;
    for (const cc of branches) db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(no, cc, 'A', 1);
    const r = `/promo_draft_headers?draft_no=eq.${no}`;
    assert.equal((await call(r, 'PATCH', { status: 'pending_approval' })).status, 200);
    const ap = await call(r, 'PATCH', { status: 'approved' }, 'M');
    assert.equal(ap.status, 200, JSON.stringify(ap.data));
    return ap.data[0].promo_no;
  };
  assert.equal(await approve('lotus 1', ['01-L2-0001', '01-L2-0002']), 'LT-0150');
  assert.equal(await approve('lotus 2', ['01-L2-0001']), 'LT-0151');
  assert.equal(await approve('cj', ['30-CJ-0001']), 'CJ-0084');
  // ไม่มีประวัติ → ชุดเดิมของระบบ
  assert.match(await approve('new cust', ['99-XX-0001']), /^PM\d{4}-0001$/);
  // ตั้งตัวอักษรนำเอง → ชุดใหม่ของตัวอักษรนั้น
  const save = body => call('/approval_workflow_templates?upsert=true&onConflict=entity_type', 'POST', { entity_type: 'promo_no_prefixes', levels_json: body }, 'A');
  assert.equal((await save([{ corp: 'ลูกค้าใหม่', prefix: 'lt1' }])).status, 400);
  assert.ok([200, 201].includes((await save([{ corp: 'ลูกค้าใหม่', prefix: 'NW' }])).status));
  assert.equal(await approve('new cust 2', ['99-XX-0001']), 'NW-0001');
  // ตัวอย่างเลขถัดไป
  const pv = (await call('/promo_draft_headers/promo-no-preview?corp=' + encodeURIComponent('โลตัส'))).data[0];
  assert.equal(pv.prefix, 'LT'); assert.equal(pv.next, 'LT-0152'); assert.equal(pv.source, 'express');
});
