const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProductGroupMatcher } = require('../lib/productGroupMatch');

// สินค้าโรงงาน (Bplus) ที่ไม่มีรหัสใน Express → จัดกลุ่มจากชื่อเทียบสินค้า Express (2026-10-14)
test('factory SKUs get the Express STKGRP group of the closest-named product', () => {
  const by = buildProductGroupMatcher([
    { code: '10053', name: 'ฮอทดอกรมควัน', group_name: '003' },
    { code: '10028', name: 'สโมคเบค่อน (คัดพิเศษ) TSS', group_name: '002' },
    { code: '10100', name: 'แฮม 4*6 1000ก. TSS', group_name: '002' },
    { code: '10200', name: 'ไส้กรอกไก่ 3นิ้ว แช่แข็ง', group_name: '003' },
    { code: '10300', name: 'ซาลามี่ 80g.', group_name: '001' },
    { code: 'EO046', name: 'ถุงพิมพ์สโมคเบค่อน TGM', group_name: 'EO' },
  ]);
  assert.equal(by('ฮอทดอกรมควัน (รวมพิเศษ) 500 กรัม'), '003');
  assert.equal(by('สโมคเบค่อน 15 mm. ตราทีจีเอ็ม 1000 ก. แช่แข็ง(กก.) (HK)'), '002');
  assert.equal(by('Prime Bacon 250 G. (Freeze)(Pack)'), '002');
  assert.equal(by('ไส้กรอกชีสหมู 4 นิ้ว 500 กรัม SP'), '003');
  assert.equal(by('Haus Salami 80 G.'), '001');
  // ไม่ใช่สินค้า (เครื่องดื่ม/รายได้อื่น) → ไม่เดากลุ่ม
  assert.equal(by('อเมริกาโน่(เย็น)'), '');
  assert.equal(by('รายได้เบ็ดเตล็ดอื่นๆ'), '');
  assert.equal(by(''), '');
});

// ตัวหากลุ่มของรหัส (ใช้ใน /api/invoice_detail/pivot, 2026-10-14) — รหัสตรง → รหัสขึ้นต้นเดียวกัน → ชื่อ
test('productGroupResolver: own group, then shared code prefix, then name', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { productGroupResolver } = require('../lib/productGroupMatch');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE products (code TEXT, name TEXT, group_name TEXT)');
  db.exec(`INSERT INTO products VALUES ('20018-10','โทสต์แฮม 1000 ก.','002'), ('20018-11','โทสต์แฮม 500 ก.','002'), ('10200','ไส้กรอกไก่ 3นิ้ว','003')`);
  const { resolve } = productGroupResolver(db);
  assert.equal(resolve('X1', 'อะไรก็ได้', '005'), '005');
  assert.equal(resolve('20018-227', 'โทสต์แฮม สไลด์ 2.2mm. 500 กรัม แช่แข็ง', ''), '002');
  assert.equal(resolve('10396-18', 'ไส้กรอกไก่สโมคกี้ 3.5 นิ้ว (พาสเจอร์ไรซ์)', ''), '003');
  assert.equal(resolve('99-1', 'รายได้เบ็ดเตล็ดอื่นๆ', ''), '');
});

// หน่วยขาย: รหัสย่อ Express กับชื่อเต็ม Bplus เป็นชื่อเดียวกัน (ไม่แยกเป็นคนละหน่วยในตาราง)
test('unitLabel normalizes Express codes and Bplus names', () => {
  const { unitLabel } = require('../lib/productGroupMatch');
  assert.equal(unitLabel('กก'), 'กก.');
  assert.equal(unitLabel('กิโลกรัม'), 'กก.');
  assert.equal(unitLabel('แพ'), 'แพ็ค');
  assert.equal(unitLabel('Pack'), 'แพ็ค');
  assert.equal(unitLabel(' ขวด '), 'ขวด');
  assert.equal(unitLabel(''), '');
});
