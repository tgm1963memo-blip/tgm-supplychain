const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const ch = require('../lib/chainSales');

// ยอดห้อง SKU แทนยอด DC ในมุมมองราย Sales (2026-10-07, lib/chainSales.js)
test('chain sales: parse mapping file, company total unchanged, salesperson view swaps DC for branch sales', async t => {
  // อ่านไฟล์: ชีตจับคู่สาขา + ชีตเทียบห้อง
  const p = ch.parseChainFile({
    Sheet2: [['รหัสลูกค้า Express', 'รหัสคุมสาขา', 'SKU', 'สาขา', 'รหัสคุม', 'ประเภท', 'ประเภทย่อย', 'เขต Sale'],
      ['30-KK-0004', 'TP-0004', 'KK', 'บางรัก', '', '', '', '207'], ['30-KK-0005', '', 'KK', 'สุขุมวิท', '', '', '', 'ออฟฟิต'], ['30-KK-0006', '', 'KK', 'x', '', '', '', 'คุณอนิตา']],
    Sheet1: [['รายงาน'], ['ห้อง SKU', 'ห้อง VAT'], ['KK', '30-TA-0001-สุดท้าย/30-TB-0001-สุดท้าย'], ['NW', '30-NW-1001-1102', 'ห้อง TGM']],
  });
  assert.equal(p.custCount, 3);
  assert.deepEqual(p.groups.map(g => [g.skus.join('/'), g.vat.length, g.company]), [['KK', 2, 'TSS'], ['NW', 1, 'TGM']]);

  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  for (const [uid, role] of [['A', 'superadmin'], ['S', 'sales_officer']]) db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run(uid, uid, role, 'แผนกขายธุรกิจค้าปลีก', role === 'sales_officer' ? '207' : null, 'x');
  const tok = { A: createSession(db, 'A').token, S: createSession(db, 'S').token };
  // ห้อง VAT: DC Tops 30-TA-0001 ใต้ 201 = 1,000 · ลูกค้าทั่วไปของ 207 = 50
  db.prepare("INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES('TSS','2026-08','30-TA-0001','201',1000,1),('TSS','2026-08','10-AA-0001','207',50,1)").run();
  // ห้อง SKU: สาขาของ 207 = 600, ออฟฟิศ = 300, คุณอนิตา = 100
  db.prepare("INSERT INTO chain_sales_monthly(chain,ym,cust_code,raw_slm,amount,invoice_count) VALUES('TOPS','2026-08','30-KK-0004','x',600,1),('TOPS','2026-08','30-KK-0005','x',300,1),('TOPS','2026-08','30-KK-0006','x',100,1)").run();
  db.prepare("INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES('chain_sales_map',?)").run(JSON.stringify({ chains: { TOPS: { replace: true, cust: p.cust, groups: p.groups, office_slm: '201', aliases: { 'คุณอนิตา': '209' } } } }));

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (route, uid = 'A') => (await (await fetch(base + route, { headers: { Authorization: `Bearer ${tok[uid]}` } })).json());
  const dx = q => get(`/dashboard/exec?from=2026-08&to=2026-08&co=all${q}`);

  assert.equal((await dx('')).kpi.ty_net, 1050, 'ยอดบริษัทไม่แตะ');
  assert.equal((await dx('&slm=207')).kpi.ty_net, 650, '207 = ลูกค้าทั่วไป 50 + สาขาห้อง 600');
  assert.equal((await dx('&slm=201')).kpi.ty_net, 300, '201 = สาขาออฟฟิศ 300 (ยอด DC 1,000 ถูกแทน)');
  assert.equal((await dx('&slm=209')).kpi.ty_net, 100, 'ค่า "คุณอนิตา" แปลงเป็น 209');
  assert.equal((await dx('&slm=201,207,209')).kpi.ty_net, 1050, 'รวมทุกคน = ยอดบริษัท (ห้อง SKU เท่ากับ DC)');

  const sw = await get('/chain_sales/swap?from=2026-08&to=2026-08', 'S');
  assert.deepEqual(sw.rows.map(r => r.slm_code), ['207'], 'Sales เห็นเฉพาะสาขาของตัวเอง');
  assert.equal(sw.ranges.length, 3, 'KK 2 ช่วง + NW 1 ช่วง');
  // ปิดการแทน → ไม่ตัด DC และไม่เพิ่มสาขา
  db.prepare("UPDATE approval_workflow_templates SET levels_json = ? WHERE entity_type = 'chain_sales_map'").run(JSON.stringify({ chains: { TOPS: { replace: false, cust: p.cust, groups: p.groups } } }));
  assert.equal((await dx('&slm=207')).kpi.ty_net, 50);
});
