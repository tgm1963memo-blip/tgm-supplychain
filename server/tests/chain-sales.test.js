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
  // ตั้ง updated_at แบบเดียวกับ PUT /chain_sales/map จริง — /dashboard/exec แคชตาม version นี้ (lib/responseCache.js)
  db.prepare("UPDATE approval_workflow_templates SET levels_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+1 second') WHERE entity_type = 'chain_sales_map'").run(JSON.stringify({ chains: { TOPS: { replace: false, cust: p.cust, groups: p.groups } } }));
  assert.equal((await dx('&slm=207')).kpi.ty_net, 50);
});

// ห้อง SKU ที่ไม่แทนรายกลุ่ม (2026-10-20, ผู้ใช้แจ้ง "คุณปูยังขาดข้อมูลการขายของ TOP") — Tops เบเกอรี่ KK เป็นของฝ่ายขายร้านค้า
test('chain sales: keep_skus keeps the DC invoice for that SKU room and drops its branch rows', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run('A', 'A', 'superadmin', 'x', null, 'x');
  db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run('P', 'P', 'sales_officer', 'ฝ่ายขายร้านค้า', '106', 'x');
  const tok = { A: createSession(db, 'A').token, P: createSession(db, 'P').token };
  // DC เบเกอรี่ 30-TA-0001 ใต้ 106 = 1,000 · DC ห้อง MJ ใต้ 201 = 400
  db.prepare("INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES('TSS','2026-08','30-TA-0001','106',1000,1),('TSS','2026-08','30-MJ-0001','201',400,1)").run();
  // สาขา KK ของ 207 = 1,000 · สาขา EU ของ 207 = 400
  db.prepare("INSERT INTO chain_sales_monthly(chain,ym,cust_code,raw_slm,amount,invoice_count) VALUES('TOPS','2026-08','30-KK-0004','x',1000,1),('TOPS','2026-08','30-EU-0004','x',400,1)").run();
  const groups = [{ skus: ['KK'], vat: [{ prefix: '30-TA-', from: 1, to: 999999 }], src: '30-TA-0001-สุดท้าย', company: 'TSS' },
    { skus: ['EU'], vat: [{ prefix: '30-MJ-', from: 1, to: 999999 }], src: '30-MJ-0001-สุดท้าย', company: 'TSS' }];
  const cfg = keep => JSON.stringify({ chains: { TOPS: { replace: true, cust: { '30-KK-0004': '207', '30-EU-0004': '207' }, groups, keep_skus: keep } } });
  db.prepare("INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES('chain_sales_map',?)").run(cfg(['KK']));

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const req = async (route, uid = 'A', opt = {}) => (await (await fetch(base + route, { ...opt, headers: { Authorization: `Bearer ${tok[uid]}`, 'Content-Type': 'application/json' } })).json());
  const dx = q => req(`/dashboard/exec?from=2026-08&to=2026-08&co=all${q}`);

  assert.equal((await dx('&slm=106')).kpi.ty_net, 1000, '106 เห็นยอด DC เบเกอรี่ (KK ไม่แทน)');
  assert.equal((await dx('&slm=207')).kpi.ty_net, 400, '207 ได้เฉพาะสาขา EU — สาขา KK ไม่ถูกเพิ่ม (กันนับซ้ำ)');
  assert.equal((await dx('&slm=201')).kpi.ty_net, 0, 'DC ห้อง MJ ยังถูกแทน');
  const sw = await req('/chain_sales/swap?from=2026-08&to=2026-08');
  assert.deepEqual(sw.ranges.map(r => r.prefix), ['30-MJ-'], 'ช่วง DC ของ KK ไม่อยู่ในรายการที่แทน');
  assert.deepEqual(sw.rows.map(r => r.cust_code), ['30-EU-0004']);

  // บันทึกจากหน้า Master: เลิกติ๊ก "ไม่แทน" → KK กลับมาถูกแทน · นำเข้าไฟล์ใหม่ไม่ล้างค่า keep_skus
  const put = await req('/chain_sales/map/TOPS', 'A', { method: 'PUT', body: JSON.stringify({ keep_skus: [] }) });
  assert.deepEqual(put.chains.TOPS.keep_skus, []);
  assert.equal((await req('/chain_sales/swap?from=2026-08&to=2026-08')).ranges.length, 2);
  assert.ok((await req('/chain_sales/map/TOPS', 'A', { method: 'PUT', body: JSON.stringify({ keep_skus: 'KK' }) })).error, 'keep_skus ต้องเป็นรายการ');
});

test('chain sales migration: TOPS keep_skus defaults to KK/AA once, never overwrites an explicit value', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare("INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES('chain_sales_map',?)").run(JSON.stringify({ chains: { TOPS: { replace: true }, MAKRO: { replace: true } } }));
  runMigrations(db);
  const get = () => JSON.parse(db.prepare("SELECT levels_json FROM approval_workflow_templates WHERE entity_type='chain_sales_map'").get().levels_json).chains;
  assert.deepEqual(get().TOPS.keep_skus, ['KK', 'AA']);
  assert.equal(get().MAKRO.keep_skus, undefined);
  db.prepare("UPDATE approval_workflow_templates SET levels_json = ? WHERE entity_type='chain_sales_map'").run(JSON.stringify({ chains: { TOPS: { replace: true, keep_skus: [] } } }));
  runMigrations(db);
  assert.deepEqual(get().TOPS.keep_skus, []);
});

// code review 2026-10-20: กลุ่ม KK/KF ที่ตั้งไม่แทนแค่ KK ยังถูกแทนทั้งกลุ่ม → ยอดสาขา KK ต้องยังอยู่ (เดิมหายทั้ง DC และสาขา)
test('chain sales: a partly kept SKU group is still replaced as a whole and keeps all its branch rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare("INSERT INTO chain_sales_monthly(chain,ym,cust_code,raw_slm,amount,invoice_count) VALUES('TOPS','2026-08','30-KK-0004','x',600,1),('TOPS','2026-08','30-KF-0004','x',400,1)").run();
  const map = { chains: { TOPS: { replace: true, keep_skus: ['KK'], office_slm: '', aliases: {}, cust: { '30-KK-0004': '207', '30-KF-0004': '207' },
    groups: [{ skus: ['KK', 'KF'], vat: [{ prefix: '30-TA-', from: 1, to: 999999 }], src: '30-TA-0001-สุดท้าย', company: 'TSS' }] },
    MAKRO: { replace: false, groups: [], keep_skus: [] }, GO: { replace: false, groups: [], keep_skus: [] } } };
  assert.equal(ch.replacedRanges(map).length, 1, 'DC ยังถูกแทน');
  assert.equal(ch.chainFacts(db, map, '2026-08', '2026-08').reduce((a, r) => a + r.amount, 0), 1000, 'สาขา KK + KF อยู่ครบ');
  map.chains.TOPS.keep_skus = ['KK', 'KF'];
  assert.equal(ch.replacedRanges(map).length, 0);
  assert.equal(ch.chainFacts(db, map, '2026-08', '2026-08').length, 0);
});
