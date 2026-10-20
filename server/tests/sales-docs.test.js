const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { isNonSalesDocNum, salesDocSql } = require('../lib/salesDocs');

// 2026-10-20 (ผู้ใช้สั่ง "ใบค่าขนส่งและวัสดุ ไม่นับมารวมคำนวน"): เล่ม IT (ค่าขนส่ง) / IV (ขายวัสดุ) ไม่นับเป็นยอดขาย
test('sales docs: IT / IV / LF / LE / LG are not sales; other series are', () => {
  for (const d of ['IT6903422', 'iv6900052', ' LF123', 'LE1', 'LG9']) assert.equal(isNonSalesDocNum(d), true, d);
  for (const d of ['AB6939022', 'AK6900394', 'INV001', 'IC1', 'IE1', '']) assert.equal(isNonSalesDocNum(d), false, d);
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE t (doc_num TEXT); INSERT INTO t VALUES ('IT1'),('IV2'),('AB3'),('INV4'),(' lf5')");
  assert.deepEqual(db.prepare(`SELECT doc_num FROM t WHERE ${salesDocSql()}`).all().map(r => r.doc_num), ['AB3', 'INV4']);
});

test('pivot and invoice detail skip shipping-fee / material invoices', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('A', 'A', 'admin', 'x');
  const tok = createSession(db, 'A').token;
  const head = db.prepare("INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES(?,'2026-09-01','C1','103',?,'3')");
  const line = db.prepare("INSERT INTO invoice_lines(company,doc_num,seq_num,doc_date,sku,qty,line_value) VALUES('TSS',?,'1','2026-09-01',?,1,?)");
  head.run('AB1', 1000); line.run('AB1', 'P1', 1000);
  head.run('IT1', 250); line.run('IT1', '30383', 250);
  head.run('IV1', 90); line.run('IV1', '45000', 90);
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/invoice_detail${p}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const piv = await post('/pivot', { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(piv.rows.map(r => [r.k, r.a]), [['P1', 1000]]);
  const det = await post('', { cust: 'C1', from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(det.invoices.map(i => i.doc_num), ['AB1']);
});
