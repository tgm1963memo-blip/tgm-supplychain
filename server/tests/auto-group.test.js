const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { autoGroupNewCustomers, companyName } = require('../lib/autoGroup');

// ลูกค้าใหม่ที่ยังไม่มี corporate (2026-10-14) — เช่น 30-PL-0021 สาขานวมินทร์ เคยขึ้นเป็น "FF"
test('new customers get the corporate of their code prefix or their own company name', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const prof = db.prepare(`INSERT INTO customer_profiles (code, corporate, sales_category) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate, sales_category = excluded.sales_category`);
  for (const c of ['ZP-PL-0001', 'ZP-PL-0002', 'ZP-PL-0003', 'ZP-PL-0004']) prof.run(c, 'เซ็นทรัล ฟุ้ด กรุ๊ป', 'Retail');
  const cust = db.prepare('INSERT INTO customers (code, name) VALUES (?, ?)');
  cust.run('ZP-PL-0021', 'เซ็นทรัล ฟู้ด รีเทล จำกัด สาขานวมินทร์');
  cust.run('ZP-LD-0295', 'บริษัท ร็อคส์ ไวบส์ จำกัด');
  cust.run('ZP-LD-0296', 'มีกลุ่มแล้ว');
  prof.run('ZP-LD-0296', 'ตั้งเอง', null);
  const inv = db.prepare(`INSERT INTO invoice_sales_monthly (company, ym, cust_code, slm_code, amount) VALUES (?, ?, ?, '', 100)`);
  const ym = new Date().toISOString().slice(0, 7);
  for (const c of ['ZP-PL-0021', 'ZP-LD-0295', 'ZP-LD-0296']) inv.run('TSS', ym, c);
  inv.run('BP-TGM-IC', ym, 'ZP-IC-0001');
  const r = autoGroupNewCustomers(db);
  const get = code => db.prepare('SELECT corporate, sales_category, corp_source FROM customer_profiles WHERE code = ?').get(code);
  assert.equal(get('ZP-PL-0021').corporate, 'เซ็นทรัล ฟุ้ด กรุ๊ป');
  assert.equal(get('ZP-PL-0021').sales_category, 'Retail');
  assert.equal(get('ZP-PL-0021').corp_source, 'auto');
  assert.equal(get('ZP-LD-0295').corporate, 'ร็อคส์ ไวบส์');
  assert.equal(get('ZP-LD-0296').corporate, 'ตั้งเอง');
  assert.equal(get('ZP-IC-0001'), undefined);
  assert.equal(r.updated, 2);
  assert.equal(autoGroupNewCustomers(db).updated, 0); // รอบถัดไปไม่มีอะไรต้องทำ
  assert.equal(companyName('บริษัท ศรีฟ้าโฟรเซนฟู้ด จำกัด (สำนักงานใหญ่)'), 'ศรีฟ้าโฟรเซนฟู้ด');
});
