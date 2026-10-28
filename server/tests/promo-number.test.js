const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { parseCodeMap, ruleForCode, ymPart } = require('../lib/promoNumber');

// แถวตัวอย่างจากไฟล์ "รหัสใบเคาะ ใบโปร Modern trade_update300926.xlsx" (ชีต รหัสใบโปรโมชั่น) — ครบทุกรูปแบบที่พบ
const ROWS = [
  { row: 5, A: 'วิลล่า', B: 'VL', E: 'A', F: 'ตู้สด (ฝากขาย)', H: 'BB-V2-0001 - BB-V2-0050', I: 'BB-V2-0001 - BB-V2-0050', L: '1VLA0000', M: 'VLA0000' },
  { row: 9, E: 'B', F: 'สินค้าขายขาด (ส่งตรง)', H: '30-VL-0009 ถึง 30-VL-0050', L: '1VLB0000', M: 'VLB0000' },
  { row: 11, A: 'โลตัส', B: 'LT', E: 'A', F: 'ตู้สด (ฝากขาย)', H: 'BB-L2-0001 - BB-L2-0102', I: 'BB-L2-0001 - BB-L2-0102', L: '1LTA0000', M: 'LTA0000' },
  { row: 12, E: 'B', F: 'แพ็คซอง', H: '30-NU-0001 ถึง 30-NU-0012', L: '1LTB0000', M: 'LTB0000' },
  { row: 14, A: 'อิออน', B: 'AE', E: 'A', F: 'แพ็คซอง', H: '30-NQ-0003', L: '1AEA0000', M: 'AEA0000' },
  { row: 23, A: 'Makro', B: 'MK', E: 'E', F: 'ตู้แพค 1 แถม 1', H: 'ยกเลิก', I: 'ยกเลิก', L: '1MKE0000', M: 'MKE0000' },
  { row: 26, F: 'สินค้า PDQ (TGM)', H: '30-NW-1015 - 30-NW-1101', I: '30-NW-1015 - 30-NW-1101' },
  { row: 46, A: 'ท๊อปส์', B: 'TP', E: 'B', F: 'ตู้สด (ฝากขาย)', H: '01-TT-0001 ถึงสุดท้าย', L: '1TPB0000', M: 'TPB0000' },
  { row: 66, A: 'บิ๊กซี', B: 'BC', E: 'G', F: 'ฝากขาย', H: '-', L: '1BCG0000', M: 'BCG0000' },
  { row: 75, A: 'CFW', B: 'GO', E: 'F', F: 'แพ็คซอง (Frozen )', H: '30-PT-1000', I: '30-PT-1000', L: '1GOF100', M: 'GOF00' },
  { row: 79, A: 'เดอะมอลล์', B: 'TM', E: 'A', F: 'ตู้สด', H: '30-MZ-0001 ถึง 30-MZ-0020', I: '30-MZ-0003 -30-MZ-0020', L: '1TMA0000', M: 'TMA0000' },
];

test('parseCodeMap reads every range format in the file and skips bad rows', () => {
  const { rules, skipped } = parseCodeMap(ROWS);
  assert.deepEqual(rules.map(r => `${r.prefix}${r.from}-${r.to}:${r.kc}/${r.pm}`), [
    'BB-V2-1-50:1VLA/VLA', '30-VL-9-50:1VLB/VLB', 'BB-L2-1-102:1LTA/LTA', '30-NU-1-12:1LTB/LTB',
    '30-NQ-3-3:1AEA/AEA', '01-TT-1-999999:1TPB/TPB', '30-MZ-3-20:1TMA/TMA']);
  assert.equal(rules[1].name, 'วิลล่า'); // ชื่อลูกค้าต่อจากแถวก่อนหน้า
  assert.deepEqual(skipped.map(s => s.row), [23, 26, 66, 75]);
  // จับคู่: ตรงตัว, คู่ CONSI (01- → BB-), นอกช่วง, I (แก้ไข) แทน H
  assert.equal(ruleForCode(rules, '30-NU-0005').kc, '1LTB');
  assert.equal(ruleForCode(rules, '01-L2-0099').kc, '1LTA');
  assert.equal(ruleForCode(rules, '30-NU-0013'), null);
  assert.equal(ruleForCode(rules, '30-MZ-0001'), null);
  assert.equal(ruleForCode(rules, '01-TT-0450').kc, '1TPB');
});

test('doc_no / promo_no follow the customer code table, renumber drafts and existing documents', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales'], ['M', 'sales_manager'], ['A', 'admin']]) {
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
  const ym = ymPart();

  // ยังไม่มีตาราง → เลขเดิม PC/PM
  const old = (await call('/promo_draft_headers', 'POST', { promo_name: 'old', _branch_codes: ['30-NU-0001'] })).data;
  assert.match(old.doc_no, /^PC\d{4}-0001$/);

  // นำเข้าตาราง: sales บันทึกไม่ได้, admin ได้; CRUD เดิมเขียน entity นี้ไม่ได้
  assert.equal((await call('/promo_draft_headers/code-map', 'PUT', { rows: ROWS }, 'S')).status, 403);
  const pv = await call('/promo_draft_headers/code-map/preview', 'POST', { rows: ROWS });
  assert.equal(pv.data.rules.length, 7);
  const saved = await call('/promo_draft_headers/code-map', 'PUT', { rows: ROWS, file: 'x.xlsx' }, 'A');
  assert.equal(saved.status, 200); assert.equal(saved.data.rules.length, 7); assert.equal(saved.data.skipped.length, 4);
  assert.equal((await call('/approval_workflow_templates?upsert=true&onConflict=entity_type', 'POST', { entity_type: 'promo_code_map', levels_json: [] }, 'A')).status, 400);
  const tst = (await call('/promo_draft_headers/code-map/test?codes=30-NU-0005')).data;
  assert.equal(tst.next_doc_no, `1LTB${ym}001`); assert.equal(tst.next_promo_no, `LTB${ym}001`);

  // สร้างใบเคาะ: เลขตามรหัสสาขา, วิ่งต่อในเดือน, หลายรหัส = รหัสที่มีสาขามากสุด
  const mk = async (name, codes) => {
    const h = (await call('/promo_draft_headers', 'POST', { promo_name: name, _branch_codes: codes })).data;
    for (const cc of codes) db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(h.draft_no, cc, 'A', 1);
    return h;
  };
  const a1 = await mk('lotus b 1', ['30-NU-0001', '30-NU-0002']);
  assert.equal(a1.doc_no, `1LTB${ym}001`);
  const a2 = await mk('lotus b 2', ['30-NU-0003']);
  assert.equal(a2.doc_no, `1LTB${ym}002`);
  const a3 = await mk('mixed', ['01-L2-0001', '01-L2-0002', '30-NU-0004']);
  assert.equal(a3.doc_no, `1LTA${ym}001`);
  const a4 = await mk('unknown', ['99-XX-0001']);
  assert.match(a4.doc_no, /^PC\d{4}-0002$/);

  // เปลี่ยนสาขาตอนร่าง → ออกเลขใหม่ + log; รหัสเดิมตรงอยู่แล้ว = ไม่เปลี่ยน
  assert.equal((await call(`/promo_draft_headers/${a2.draft_no}/renumber`, 'POST', {})).data.changed, false);
  db.prepare('UPDATE promo_drafts SET cust_code = ? WHERE draft_no = ?').run('BB-L2-0005', a2.draft_no);
  const rn = (await call(`/promo_draft_headers/${a2.draft_no}/renumber`, 'POST', {})).data;
  assert.equal(rn.changed, true); assert.equal(rn.doc_no, `1LTA${ym}002`);
  assert.ok(db.prepare("SELECT 1 FROM promo_draft_logs WHERE draft_no = ? AND action = 'renumber'").get(a2.draft_no));

  // ส่งอนุมัติ → อนุมัติครบ → เลขใบโปรตามรหัส; ส่งแล้วเปลี่ยนสาขา = ไม่ออกเลขใหม่
  const r1 = `/promo_draft_headers?draft_no=eq.${a1.draft_no}`;
  assert.equal((await call(r1, 'PATCH', { status: 'pending_approval' })).status, 200);
  db.prepare('UPDATE promo_drafts SET cust_code = ? WHERE draft_no = ?').run('BB-L2-0009', a1.draft_no);
  assert.equal((await call(`/promo_draft_headers/${a1.draft_no}/renumber`, 'POST', {})).data.changed, false);
  const ap = await call(r1, 'PATCH', { status: 'approved' }, 'M');
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data[0].promo_no, `LTA${ym}001`);
  // ไม่เข้ากฎ → PM เดิม
  const r4 = `/promo_draft_headers?draft_no=eq.${a4.draft_no}`;
  await call(r4, 'PATCH', { status: 'pending_approval' });
  assert.match((await call(r4, 'PATCH', { status: 'approved' }, 'M')).data[0].promo_no, /^PM\d{4}-0001$/);

  // ออกเลขใหม่ให้เอกสารทั้งหมด: ตัวอย่างก่อน แล้ว admin ยืนยัน — เอกสาร PC เดิมของ 30-NU ได้เลขตามรหัส + log
  assert.equal((await call('/promo_draft_headers/renumber-all', 'GET', undefined, 'S')).status, 403); // ตัวอย่างก็ admin เท่านั้น
  const plan = (await call('/promo_draft_headers/renumber-all', 'GET', undefined, 'A')).data;
  assert.equal(plan.find(p => p.draft_no === old.draft_no).new_doc_no, old.doc_no); // ไม่มีบรรทัดสินค้า = คงเลขเดิม
  db.prepare('INSERT INTO promo_drafts(draft_no,cust_code,sku,unit_price) VALUES(?,?,?,?)').run(old.draft_no, '30-NU-0011', 'A', 1);
  assert.equal((await call('/promo_draft_headers/renumber-all', 'POST', {}, 'S')).status, 403);
  const done = (await call('/promo_draft_headers/renumber-all', 'POST', {}, 'A')).data;
  assert.ok(done.changed >= 1, JSON.stringify(done));
  const after = db.prepare('SELECT draft_no, doc_no, promo_no FROM promo_draft_headers').all();
  const nos = after.map(x => x.doc_no);
  assert.equal(new Set(nos).size, nos.length); // ไม่มีเลขซ้ำ
  assert.equal(after.find(x => x.draft_no === old.draft_no).doc_no, `1LTB${ym}001`); // สร้างก่อนสุด = 001
  assert.equal(after.find(x => x.draft_no === a4.draft_no).doc_no, a4.doc_no); // ไม่เข้ากฎคงเดิม
  const lg = db.prepare("SELECT detail_json FROM promo_draft_logs WHERE draft_no = ? AND action = 'renumber'").get(old.draft_no);
  assert.equal(JSON.parse(lg.detail_json).from_doc_no, old.doc_no);
});
