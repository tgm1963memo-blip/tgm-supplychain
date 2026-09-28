const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// รายละเอียดใบกำกับรายสาขา (2026-09-28): สินค้าจาก invoice_lines ผูกหัวใบ invoices, กรอง Sales/ช่วงวันที่ได้
test('invoice detail per branch: products, invoice list, lines', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('M', 'Mgr', 'sales_manager', 'x');
  const tok = createSession(db, 'M').token;
  const inv = db.prepare('INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES(?,?,?,?,?,?)');
  inv.run('A1', '2026-09-05', 'C1', '106', 300, '3');
  inv.run('A2', '2026-09-20', 'C1', '107', 50, '3');
  inv.run('A3', '2026-08-30', 'C1', '106', 999, '3'); // นอกช่วง
  inv.run('X1', '2026-09-21', 'C1', null, 20, '3'); // ไม่ระบุ Sales
  inv.run('R1', '2026-09-22', 'C1', '106', -40, '5'); // ลดหนี้ ไม่มีบรรทัด
  const ln = db.prepare('INSERT INTO invoice_lines(company,doc_num,seq_num,doc_date,sku,sku_name,qty,unit_code,line_value) VALUES(?,?,?,?,?,?,?,?,?)');
  ln.run('TSS', 'A1', '1', '2026-09-05', 'P1', 'Ham', 2, 'กก', 200);
  ln.run('TSS', 'A1', '2', '2026-09-05', 'P2', 'Bacon', 1, 'กก', 100);
  ln.run('TSS', 'A2', '1', '2026-09-20', 'P1', 'Ham', 1, 'กก', 50);
  ln.run('TSS', 'X1', '1', '2026-09-21', 'P2', 'Bacon', 1, 'กก', 20);
  ln.run('CONSI', 'A1', '9', '2026-09-05', 'P9', 'Other co', 1, 'กก', 7777); // บริษัทอื่น ไม่นับ
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/invoice_detail`;
  const get = async q => { const r = await fetch(base + q, { headers: { Authorization: `Bearer ${tok}` } }); return { status: r.status, data: await r.json() }; };

  assert.equal((await get('?cust=C1')).status, 400);
  const all = await get('?cust=C1&from=2026-09-01&to=2026-09-30');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.products.map(p => [p.sku, p.amount, p.invoices]), [['P1', 250, 2], ['P2', 120, 2]]);
  assert.equal(all.data.invoices.length, 4);
  assert.equal(all.data.invoices.find(x => x.doc_num === 'R1').line_count, 0);
  const s106 = await get('?cust=C1&from=2026-09-01&to=2026-09-30&slm=106');
  assert.deepEqual(s106.data.products.map(p => [p.sku, p.amount]), [['P1', 200], ['P2', 100]]);
  const multi = await get('?cust=C1&from=2026-09-01&to=2026-09-30&slm=106,107');
  assert.equal(multi.data.products.find(p => p.sku === 'P1').amount, 250);
  const none = await get('?cust=C1&from=2026-09-01&to=2026-09-30&slm=' + encodeURIComponent('(ไม่ระบุ)'));
  assert.deepEqual(none.data.products.map(p => [p.sku, p.amount]), [['P2', 20]]);
  // หลายสาขา (สรุปทั้งกลุ่ม) ผ่าน POST + บรรทัดสินค้าของทุกใบ
  inv.run('B1', '2026-09-10', 'C2', '106', 10, '3');
  ln.run('TSS', 'B1', '1', '2026-09-10', 'P1', 'Ham', 1, 'กก', 10);
  const post = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ cust: ['C1', 'C2'], from: '2026-09-01', to: '2026-09-30', lines: 1 }) }).then(r => r.json());
  assert.deepEqual(post.products.map(p => [p.sku, p.amount, p.custs]), [['P1', 260, 2], ['P2', 120, 1]]);
  assert.equal(post.lines.filter(l => l.sku === 'P1').length, 3);
  assert.ok(post.lines.every(l => l.cust_code && l.doc_date));
  const lines = await get('/lines?doc=A1');
  assert.deepEqual(lines.data.lines.map(l => l.sku), ['P1', 'P2']);
  assert.equal(lines.data.head.cust_code, 'C1');
});
