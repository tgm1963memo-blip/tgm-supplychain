'use strict';

// ใบเสนอราคา รอบ 2 (routes/quotationHeaders.js) — กติกาที่ server ต้องบังคับเอง
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { buildDoc } = require('../routes/quotationHeaders');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE price_tiers (code TEXT PRIMARY KEY, name_th TEXT, name_en TEXT, unit TEXT,
    price_a REAL, price_b REAL, price_c REAL, price_d REAL, price_e REAL, price_f REAL, price_g REAL, is_active INTEGER NOT NULL DEFAULT 1)`);
  db.prepare("INSERT INTO price_tiers VALUES ('10001-2','ค๊อกเทล 500 ก.','Cocktail 500g','กิโลกรัม',140,150,155,155,160,165,175,1)").run();
  db.prepare("INSERT INTO price_tiers VALUES ('X1','ยกเลิก',NULL,'กก.',1,1,1,1,1,1,1,0)").run();
  db.prepare("INSERT INTO price_tiers VALUES ('NOP','ไม่มีราคา',NULL,'กก.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1)").run();
  return db;
}
const sales = { uid: 's1', name: 'Sale', role: 'sales_officer', min_price_tier: 'E' };
const base = { customer_name: 'ลูกค้าทดสอบ', price_tier: 'F', lines: [{ product_code: '10001-2' }] };

test('ชื่อ/หน่วย/ราคาฐาน มาจาก price_tiers ไม่ใช่ client', () => {
  const { lines } = buildDoc(makeDb(), { ...base, lines: [{ product_code: '10001-2', name_th: 'ปลอม', base_price: 1 }] }, sales);
  assert.equal(lines[0].name_th, 'ค๊อกเทล 500 ก.');
  assert.equal(lines[0].base_price, 165);
  assert.equal(lines[0].quoted_price, 165);
  assert.equal(lines[0].price_source, 'tier');
  assert.equal(lines[0].needs_approval, 0);
});

test('ฐานต่ำกว่าสิทธิ์ถูกปฏิเสธ (รอบ 2 ยังไม่มีการขออนุมัติ)', () => {
  assert.throws(() => buildDoc(makeDb(), { ...base, price_tier: 'C' }, sales), /ต่ำกว่าสิทธิ์/);
  // ผู้ใช้ที่ตั้งสิทธิ์ D ใช้ฐาน D ได้
  assert.doesNotThrow(() => buildDoc(makeDb(), { ...base, price_tier: 'D' }, { ...sales, min_price_tier: 'D' }));
});

test('ราคาเสนอต่ำกว่าราคาฐานสิทธิ์ต่ำสุดถูกปฏิเสธ · สูงกว่าได้ (manual)', () => {
  assert.throws(() => buildDoc(makeDb(), { ...base, lines: [{ product_code: '10001-2', quoted_price: 159 }] }, sales), /ต่ำกว่าฐาน E/);
  const { lines } = buildDoc(makeDb(), { ...base, lines: [{ product_code: '10001-2', quoted_price: 170 }] }, sales);
  assert.equal(lines[0].price_source, 'manual');
});

test('รหัสไม่มี / ยกเลิกขาย / ไม่มีราคาและไม่ระบุราคา ถูกปฏิเสธ', () => {
  assert.throws(() => buildDoc(makeDb(), { ...base, lines: [{ product_code: 'ZZZ' }] }, sales), /ไม่พบรหัส/);
  assert.throws(() => buildDoc(makeDb(), { ...base, lines: [{ product_code: 'X1' }] }, sales), /ยกเลิกขาย/);
  assert.throws(() => buildDoc(makeDb(), { ...base, lines: [{ product_code: 'NOP' }] }, sales), /กรุณาระบุราคาเสนอ/);
  assert.equal(buildDoc(makeDb(), { ...base, lines: [{ product_code: 'NOP', quoted_price: 99 }] }, sales).lines[0].quoted_price, 99);
});

test('ต้องมีลูกค้าและสินค้า', () => {
  assert.throws(() => buildDoc(makeDb(), { ...base, customer_name: ' ' }, sales), /ลูกค้า/);
  assert.throws(() => buildDoc(makeDb(), { ...base, lines: [] }, sales), /อย่างน้อย 1/);
});
