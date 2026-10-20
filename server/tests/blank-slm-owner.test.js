const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { factSql, slmListSql, ownerSlmExpr } = require('../lib/customerScope');
const { refreshDataCounts } = require('../lib/dataCounts');

// 2026-10-20 (code review): ใบไม่มีรหัส Sales นับให้เซลล์เจ้าของลูกค้าด้วยกติกาเดียวกันทุกหน้า
// และเฉพาะแฟ้ม Express ฝั่ง TSS — ฝากขาย / TGM / โรงงาน ที่ไม่มีรหัส Sales ไม่โอนให้ใคร
function memDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  return db;
}

test('owner rule: only TSS-family blank rows go to the master owner; filters and labels agree', () => {
  const db = memDb();
  db.prepare("INSERT INTO customers(code,name,slm_id) VALUES ('C1','ลูกค้า 1','105'),('C2','ลูกค้า 2',NULL)").run();
  const ins = db.prepare('INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount) VALUES (?,?,?,?,?)');
  ins.run('TSS', '2026-08', 'C1', '105', 10);
  ins.run('TSS', '2026-08', 'C1', '(none)', 20);   // TSS ไม่มีรหัส ลูกค้าของ 105 → 105
  ins.run('TSS-NV', '2026-08', 'C1', '', 40);      // แฟ้ม TSS อีกแฟ้ม → 105
  ins.run('CONSI', '2026-08', 'C1', '(none)', 80); // ฝากขาย ไม่มีรหัส → ไม่โอน
  ins.run('TSS', '2026-08', 'C2', '(none)', 160);  // ลูกค้าไม่ผูกใคร → (ไม่ระบุ)
  const sum = (w) => db.prepare(`SELECT SUM(amount) AS a FROM invoice_sales_monthly WHERE ${w.sql}`).get(...w.params).a;
  const scope = { all: false, slmCodes: ['105'], mtCodes: [], masterCodes: ['C1'] };

  assert.equal(sum(factSql(scope, { blankToOwner: true, company: 'company' })), 70, 'สิทธิ์เซลล์: 10 + 20 + 40 ไม่รวมฝากขาย');
  assert.equal(sum(slmListSql(['105'], { company: 'company' })), 70, 'เลือก Sales 105 = ตัวเลขเดียวกับสิทธิ์');
  assert.equal(sum(slmListSql(['(ไม่ระบุ)'], { company: 'company' })), 240, '(ไม่ระบุ) = ฝากขายไม่มีรหัส + ลูกค้าไม่ผูกใคร');
  assert.equal(sum(slmListSql(['105', '(ไม่ระบุ)'], { company: 'company' })), 310, 'ทุกแถวมีเจ้าของเดียว รวมได้ยอดทั้งหมด');

  const by = Object.fromEntries(db.prepare(`SELECT ${ownerSlmExpr({ company: 'company' })} AS s, SUM(amount) AS a FROM invoice_sales_monthly GROUP BY s`).all().map(r => [r.s, r.a]));
  assert.deepEqual(by, { 105: 70, '(ไม่ระบุ)': 240 }, 'ป้ายตามเจ้าของยอดตรงกับตัวกรอง');
});

test('dashboard exec: salesperson filter and restricted user include blank TSS invoices of their customers', async t => {
  const db = memDb();
  db.prepare("INSERT INTO customers(code,name,slm_id) VALUES ('C1','ลูกค้า 1','105'),('C2','ลูกค้า 2','110')").run();
  for (const [uid, role, codes] of [['A', 'superadmin', null], ['S', 'sales_officer', '105']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run(uid, uid, role, 'ฝ่ายขายร้านค้า', codes, 'x');
  }
  const tok = { A: createSession(db, 'A').token, S: createSession(db, 'S').token };
  const ins = db.prepare('INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES (?,?,?,?,?,1)');
  ins.run('TSS', '2026-08', 'C1', '105', 100);
  ins.run('TSS', '2026-08', 'C1', '(none)', 30);
  ins.run('TSS', '2026-08', 'C2', '(none)', 7);
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (route, uid) => (await (await fetch(base + route, { headers: { Authorization: `Bearer ${tok[uid]}` } })).json());
  const dx = (q, uid = 'A') => get(`/dashboard/exec?from=2026-08&to=2026-08&co=all${q}`, uid);

  assert.equal((await dx('&slm=105')).kpi.ty_net, 130, 'admin เลือก 105 = 100 + ใบไม่มีรหัสของลูกค้า 105');
  assert.equal((await dx('', 'S')).kpi.ty_net, 130, 'เซลล์ 105 เห็นยอดเท่ากับ Sales Overview');
  const rows = await get('/invoice_sales_monthly?ym=eq.2026-08', 'S');
  assert.equal((Array.isArray(rows) ? rows : rows.data || []).reduce((a, r) => a + r.amount, 0), 130);
});

test('pivot: blank-salesman rows are labelled with their owner and "(ไม่ระบุ)" is filterable', async t => {
  const db = memDb();
  db.prepare("INSERT INTO customers(code,name,slm_id) VALUES ('C1','ลูกค้า 1','105'),('C2','ลูกค้า 2',NULL)").run();
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('A', 'A', 'admin', 'x');
  const tok = createSession(db, 'A').token;
  const head = db.prepare('INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES(?,?,?,?,?,?)');
  const line = db.prepare("INSERT INTO invoice_lines(company,doc_num,seq_num,doc_date,sku,qty,line_value) VALUES('TSS',?,'1',?,'P1',1,?)");
  head.run('D1', '2026-09-01', 'C1', '(none)', 50, '3'); line.run('D1', '2026-09-01', 50);
  head.run('D2', '2026-09-01', 'C2', null, 9, '3'); line.run('D2', '2026-09-01', 9);
  head.run('D3', '2026-09-01', 'C1', '105', 5, '3'); line.run('D3', '2026-09-01', 5);
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const pivot = async body => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/invoice_detail/pivot`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '2026-09-01', to: '2026-09-30', ...body }) })).json());
  const all = await pivot({});
  const by = {};
  for (const r of all.rows) by[r.s] = (by[r.s] || 0) + r.a;
  assert.deepEqual(by, { 105: 55, '(ไม่ระบุ)': 9 });
  assert.equal((await pivot({ slm: '(ไม่ระบุ)' })).rows.reduce((a, r) => a + r.a, 0), 9);
  assert.equal((await pivot({ slm: '105' })).rows.reduce((a, r) => a + r.a, 0), 55);
});

test('data counts: heavy confidence numbers come from the stored snapshot, refreshed on demand', () => {
  const db = memDb();
  const view = () => db.prepare('SELECT so_count, orphan_sku_sales_count, synced_at FROM v_sc_data_confidence').get();
  assert.equal(view().so_count, 0, 'migration นับครั้งแรกให้แล้ว');
  db.prepare("INSERT INTO sales_transactions(company,sku,tx_date,qty,amount) VALUES ('TSS','NOPE','2026-09-01',1,1)").run();
  assert.equal(view().orphan_sku_sales_count, 0, 'ยังเป็น snapshot เดิมจนกว่าจะนับใหม่');
  refreshDataCounts(db);
  assert.equal(view().orphan_sku_sales_count, 1);
  db.prepare("INSERT INTO sync_log(source,status,started_at,finished_at) VALUES ('express','ok','2026-10-20T00:00:00Z','2026-10-20T00:01:00Z')").run();
  assert.equal(view().synced_at, '2026-10-20T00:01:00Z', 'เวลา sync อ่านสด ไม่ต้องรอแคช');
});
