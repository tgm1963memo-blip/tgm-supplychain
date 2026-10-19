const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { factSql } = require('../lib/customerScope');

// 2026-10-19 ("ร้านโจโจ้บางรายการหายไป"): invoices เก็บหัวใบแค่ 90 วัน แต่ invoice_lines ย้อนถึง 2024 →
// รายสินค้า/pivot ต้องหาหัวใบเก่าจาก invoice_heads ผ่าน v_invoice_heads · ใบที่อยู่ทั้งสองตารางนับครั้งเดียว
test('invoice detail + pivot read old invoice headers from invoice_heads', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('A', 'Admin', 'admin', 'x');
  const tok = createSession(db, 'A').token;
  db.prepare('INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES(?,?,?,?,?,?)').run('N1', '2026-09-10', 'C1', '112', 100, '3');
  const head = db.prepare('INSERT INTO invoice_heads(doc_num,doc_date,cust_code,slm_code,so_num,total,rectyp) VALUES(?,?,?,?,?,?,?)');
  head.run('O1', '2026-03-05', 'C1', '112', null, 300, '3');   // เก่ากว่า 90 วัน — มีแค่ใน invoice_heads
  head.run('N1', '2026-09-10', 'C1', '112', null, 100, '3');   // ซ้ำกับ invoices — ต้องไม่นับซ้ำ
  const ln = db.prepare('INSERT INTO invoice_lines(company,doc_num,seq_num,doc_date,sku,sku_name,qty,unit_code,line_value) VALUES(?,?,?,?,?,?,?,?,?)');
  ln.run('TSS', 'O1', '1', '2026-03-05', 'P1', 'Ham', 3, 'กก', 300);
  ln.run('TSS', 'N1', '1', '2026-09-10', 'P1', 'Ham', 1, 'กก', 100);
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/invoice_detail`;
  const call = async (q, body) => {
    const r = await fetch(base + q, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };

  const march = await call('?cust=C1&from=2026-03-01&to=2026-03-31');
  assert.deepEqual(march.products.map(p => [p.sku, p.amount]), [['P1', 300]]);
  assert.equal(march.coverage_from, '2026-03-05');
  const year = await call('?cust=C1&from=2026-01-01&to=2026-12-31');
  assert.equal(year.products[0].amount, 400);           // O1 + N1 ครั้งเดียว
  assert.equal(year.invoices.length, 2);
  const piv = await call('/pivot', { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(piv.rows.reduce((a, r) => a + r.a, 0), 400);
  const lines = await (await fetch(`${base}/lines?doc=O1`, { headers: { Authorization: `Bearer ${tok}` } })).json();
  assert.equal(lines.head.cust_code, 'C1');
});

// 2026-10-19 ("ลูกค้าของแด้มาไม่ครบ"): ใบกำกับที่ Express ไม่ใส่รหัส Sales นับให้เซลล์ที่ master ผูกลูกค้าไว้
test('factSql counts blank-salesman invoices for the customer master owner', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE f (cust_code TEXT, slm_code TEXT, amount REAL)');
  const ins = db.prepare('INSERT INTO f VALUES (?,?,?)');
  ins.run('C1', '105', 10);      // รหัสของเรา
  ins.run('C1', '(none)', 20);   // ไม่มีรหัส ลูกค้าของเรา (master)
  ins.run('C2', null, 40);       // ไม่มีรหัส ลูกค้าของคนอื่น
  ins.run('C1', '110', 80);      // รหัสคนอื่น — ไม่นับ
  const s = factSql({ all: false, slmCodes: ['105'], mtCodes: [], masterCodes: ['C1'] }, { blankToOwner: true });
  // ไม่ขอ = กติกาเดิม (Bplus/ฝากขาย ไม่ถูกนับตาม master)
  const plain = factSql({ all: false, slmCodes: ['105'], mtCodes: [], masterCodes: ['C1'] });
  assert.equal(db.prepare(`SELECT SUM(amount) AS a FROM f WHERE ${plain.sql}`).get(...plain.params).a, 10);
  assert.equal(db.prepare(`SELECT SUM(amount) AS a FROM f WHERE ${s.sql}`).get(...s.params).a, 30);
  assert.equal(factSql({ all: true }), null);
  // scope เก่าที่ยังไม่มี masterCodes (cache) ต้องไม่พัง
  const old = factSql({ all: false, slmCodes: ['105'], mtCodes: [] }, { blankToOwner: true });
  assert.equal(db.prepare(`SELECT SUM(amount) AS a FROM f WHERE ${old.sql}`).get(...old.params).a, 10);
});
