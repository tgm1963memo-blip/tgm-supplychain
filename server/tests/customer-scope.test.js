const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { parseCodeMap } = require('../lib/promoNumber');

// สิทธิ์การเห็นลูกค้า ฝั่ง server (2026-10-06, lib/customerScope.js): รหัส Sales ตามทีมขาย + เจ้า Modern Trade ตามไฟล์
test('customer scope: sales see own codes + own MT chains, manager sees team + managed chains, others see all', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const RETAIL = 'แผนกขายธุรกิจค้าปลีก';
  const tokens = {};
  for (const [uid, name, role, dept, codes] of [
    ['S1', 'คุณหทัยกาญจน์ (คุณเมย์)', 'sales_officer', RETAIL, '207'],
    ['S2', 'คุณปิยะธเนศ (คุณอาร์ม)', 'sales_officer', RETAIL, '211'],
    ['MG', 'คุณเกษณี (คุณปู)', 'sales_manager', RETAIL, ''],
    ['P', 'Planner', 'planning_officer', 'ฝ่ายวางแผน', ''],
    ['ADM', 'Admin', 'admin', 'IT', ''],
  ]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run(uid, name, role, dept, codes || null, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  // ตารางรหัสเอกสาร + ชื่อเซลล์ (N) / ผู้จัดการ (O)
  const { rules } = parseCodeMap([
    { row: 1, A: 'ท๊อปส์', B: 'TP', F: 'ตู้สด', H: '30-MJ-0001 ถึง 30-MJ-0002', L: '1TPA0000', M: 'TPA0000', N: 'เมย์', O: 'คุณตุ๊ก' },
    { row: 2, A: 'โลตัส', B: 'LT', F: 'ฝากขาย', H: 'BB-L2-0001 - BB-L2-0102', L: '1LTA0000', M: 'LTA0000', N: 'อาร์ม', O: '' },
    { row: 3, A: 'โลตัส', B: 'LT', F: 'แพ็คซอง', H: '30-NU-0001 ถึงสุดท้าย', L: '1LTB0000', M: 'LTB0000', N: 'ใครสักคน', O: 'คุณปู' },
  ]);
  assert.equal(rules.length, 3);
  db.prepare("INSERT INTO approval_workflow_templates(entity_type,levels_json,updated_at) VALUES('promo_code_map',?,'2026-10-06')").run(JSON.stringify({ rules, skipped: [] }));
  const custs = [['30-MJ-0001', '999'], ['BB-L2-0005', 'C1'], ['01-L2-0005', '777'], ['30-NU-0003', '888'], ['10-AA-0001', '207'], ['10-BB-0001', '211'], ['50-ZZ-0001', '555']];
  for (const [c, slm] of custs) {
    db.prepare('INSERT INTO customers(code,name,slm_id,is_active) VALUES(?,?,?,1)').run(c, 'ลูกค้า ' + c, slm);
    db.prepare("INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES('TSS','2026-01',?,?,100,1)").run(c, slm);
  }
  db.prepare(`INSERT INTO promo_docs(company,sonum,seqnum,cust_code,sku,start_date,due_date,docstat,doc_ref) VALUES
    ('TSS','P1-1','1','30-MJ-0001','A','2026-01-01','2026-01-31','M','TOPS-1'),('TSS','P1-2','1','30-NU-0003','A','2026-01-01','2026-01-31','M','LT-1')`).run();

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'ADM') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };
  const codes = async (uid, route = '/customers', key = 'code') => (await call(route, 'GET', undefined, uid)).data.map(r => r[key]).sort();

  // ก่อนจับคู่ชื่อ: sales เห็นเฉพาะรหัส Sales ตัวเอง
  assert.deepEqual(await codes('S1'), ['10-AA-0001']);
  // จับคู่ชื่อในไฟล์ → ผู้ใช้ (admin เท่านั้น)
  assert.equal((await call('/sales_teams/mt', 'PUT', { map: { 'sales:เมย์': 'S1' } }, 'S1')).status, 403);
  assert.equal((await call('/sales_teams/mt', 'PUT', { map: { 'sales:เมย์': 'NOPE' } })).status, 400);
  const mt = await call('/sales_teams/mt');
  assert.equal(mt.data.names.find(n => n.key === 'sales:เมย์').suggest.uid, 'S1', 'แนะนำจากชื่อเล่นในวงเล็บ');
  assert.equal((await call('/sales_teams/mt', 'PUT', { map: { 'sales:เมย์': 'S1', 'sales:อาร์ม': 'S2', 'mgr:คุณปู': 'MG' } })).status, 200);

  assert.deepEqual(await codes('S1'), ['10-AA-0001', '30-MJ-0001']);
  assert.deepEqual(await codes('S2'), ['01-L2-0005', '10-BB-0001', 'BB-L2-0005'], 'คู่ BB- นับเป็นเจ้าเดียวกัน');
  assert.deepEqual(await codes('MG'), ['01-L2-0005', '10-AA-0001', '10-BB-0001', '30-MJ-0001', '30-NU-0003', 'BB-L2-0005'], 'ลูกทีม + เจ้าที่เป็นผู้จัดการ');
  assert.equal((await codes('P')).length, 7, 'ฝ่ายแผนเห็นทั้งหมด');
  assert.equal((await codes('ADM')).length, 7);

  // ตารางยอดขาย + ปลอมตัวกรอง
  assert.deepEqual(await codes('S1', '/invoice_sales_monthly', 'cust_code'), ['10-AA-0001', '30-MJ-0001']);
  assert.deepEqual((await call('/invoice_sales_monthly?slm_code=eq.211', 'GET', undefined, 'S1')).data, [], 'ขอรหัสคนอื่น = ว่าง');
  assert.deepEqual(await codes('S1', '/promo_docs', 'cust_code'), ['30-MJ-0001']);
  assert.deepEqual(await codes('MG', '/promo_docs', 'cust_code'), ['30-MJ-0001', '30-NU-0003']);

  // Dashboard ผู้บริหาร
  const dx = uid => call('/dashboard/exec?from=2026-01&to=2026-01&co=tss', 'GET', undefined, uid);
  assert.equal((await dx('S1')).data.kpi.ty_net, 200);
  assert.equal((await dx('ADM')).data.kpi.ty_net, 700);
  assert.equal((await call('/dashboard/exec?from=2026-01&to=2026-01&co=tss&slm=555', 'GET', undefined, 'S1')).data.kpi.ty_net, 0, 'ปลอม slm=555');

  // ยอดขายโรงงาน Bplus รายบรรทัด (2026-10-12, security review) — กรองตามสิทธิ์ + ส่งชื่อเฉพาะรหัสที่เห็น
  db.prepare("INSERT INTO sales_lines_monthly(company,ym,cust_code,slm_code,sku,qty,amount) VALUES('BP-TGM','2026-01','10-AA-0001','207','X',1,50),('BP-TGM','2026-01','50-ZZ-0001','BP-9','X',1,70)").run();
  db.prepare("INSERT INTO bplus_customers(code,name) VALUES('10-AA-0001','A'),('50-ZZ-0001','Z')").run();
  db.prepare("INSERT INTO bplus_salesman_map(bp_code,bp_name) VALUES('9','BP Nine')").run();
  const bp = uid => call('/dashboard/bplus/sales_lines?from=2026-01&to=2026-01', 'GET', undefined, uid);
  const bs1 = (await bp('S1')).data;
  assert.deepEqual(bs1.rows.map(r => r.cust_code), ['10-AA-0001']);
  assert.deepEqual(Object.keys(bs1.customers), ['10-AA-0001']);
  assert.deepEqual(bs1.salesmen, {});
  const bad = (await bp('ADM')).data;
  assert.equal(bad.rows.length, 2);
  assert.equal(bad.salesmen['BP-9'], 'BP Nine');

  // บรรทัดใบเคาะ (2026-10-12): ผู้ถูกจำกัดบันทึกได้เฉพาะสาขาที่มองเห็น · admin ได้ทุกสาขา
  const pd = (cust, uid, no = 'PMD-' + cust) => call('/promo_drafts', 'POST', { draft_no: no, cust_code: cust, sku: 'X', unit_price: 1 }, uid);
  assert.equal((await pd('10-BB-0001', 'S1')).status, 403, 'สาขาของคนอื่น');
  assert.equal((await pd('10-AA-0001', 'S1')).status, 201, 'สาขาของตัวเอง');
  assert.equal((await pd('30-MJ-0001', 'S1')).status, 201, 'เจ้า MT ที่ดูแล');
  assert.equal((await pd('50-ZZ-0001', 'ADM')).status, 201);
  // ใบเคาะ 1 ใบ = ห้างเดียว: ท๊อปส์ (30-MJ) + โลตัส (BB-L2) ใบเดียวกันไม่ได้ · ห้างเดียวกันหลายสาขาได้
  assert.equal((await pd('30-MJ-0002', 'ADM', 'PMD-30-MJ-0001')).status, 201, 'ท๊อปส์ 2 สาขา');
  const mix = await pd('BB-L2-0005', 'ADM', 'PMD-30-MJ-0001');
  assert.equal(mix.status, 400);
  assert.match(mix.data.error, /ห้างเดียว/);

  // ใบเคาะ: เห็นเมื่อมีสาขาที่มองเห็น
  const made = await call('/promo_draft_headers', 'POST', { promo_name: 'Tops' });
  const no = made.data.draft_no;
  db.prepare("INSERT INTO promo_drafts(id,draft_no,cust_code,sku,normal_price,unit_price) VALUES('x1',?,'30-MJ-0001','A',10,9)").run(no);
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'GET', undefined, 'S1')).data.length, 1);
  assert.equal((await call(`/promo_draft_headers?draft_no=eq.${no}`, 'GET', undefined, 'S2')).data.length, 0);
  assert.equal((await call(`/promo_drafts?draft_no=eq.${no}`, 'GET', undefined, 'S2')).data.length, 0);
  assert.equal((await call(`/promo_draft_headers/${no}/logs`, 'GET', undefined, 'S2')).status, 404);

  // /me
  const me = (await call('/sales_teams/me', 'GET', undefined, 'S1')).data;
  assert.equal(me.restricted, true);
  assert.deepEqual(me.mt_chains.map(c => c.name), ['ท๊อปส์']);
  assert.equal((await call('/sales_teams/me', 'GET', undefined, 'P')).data.restricted, false);
});
