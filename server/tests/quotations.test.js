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
  db.exec(`CREATE TABLE customer_special_prices (id INTEGER PRIMARY KEY, cust_key TEXT, customer_code TEXT, customer_name TEXT, product_code TEXT,
    price REAL, source_quotation_id TEXT, approved_by TEXT, approved_at TEXT, is_active INTEGER DEFAULT 1, updated_at TEXT)`);
  db.exec('CREATE TABLE quotation_headers (id TEXT PRIMARY KEY, created_by TEXT)');
  db.prepare("INSERT INTO quotation_headers VALUES ('Q-S1','s1'),('Q-S2','s2')").run();
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

// รอบ 3 (2026-10-09): ต่ำกว่าสิทธิ์ไม่ปฏิเสธแล้ว — บรรทัดนั้น needs_approval (ส่งขออนุมัติ)
test('ฐานต่ำกว่าสิทธิ์ = ต้องขออนุมัติ · ผู้ใช้ที่ได้สิทธิ์ D ใช้ฐาน D ได้เลย', () => {
  assert.equal(buildDoc(makeDb(), { ...base, price_tier: 'C' }, sales).lines[0].needs_approval, 1);
  assert.equal(buildDoc(makeDb(), { ...base, price_tier: 'D' }, { ...sales, min_price_tier: 'D' }).lines[0].needs_approval, 0);
});

test('ราคาเสนอต่ำกว่าราคาฐานสิทธิ์ต่ำสุด = ต้องขออนุมัติ · สูงกว่า = manual ไม่ต้องอนุมัติ', () => {
  assert.equal(buildDoc(makeDb(), { ...base, lines: [{ product_code: '10001-2', quoted_price: 159 }] }, sales).lines[0].needs_approval, 1);
  const { lines } = buildDoc(makeDb(), { ...base, lines: [{ product_code: '10001-2', quoted_price: 170 }] }, sales);
  assert.equal(lines[0].price_source, 'manual');
  assert.equal(lines[0].needs_approval, 0);
});

test('ราคาพิเศษประจำลูกค้า: เป็นราคาตั้งต้น และราคา ≥ ราคาพิเศษไม่ต้องขออนุมัติซ้ำ', () => {
  const db = makeDb();
  db.prepare("INSERT INTO customer_special_prices (cust_key, product_code, price, source_quotation_id) VALUES ('N:ลูกค้าทดสอบ', '10001-2', 150, 'Q-S1')").run();
  const d = buildDoc(db, base, sales).lines[0];
  assert.equal(d.quoted_price, 150);
  assert.equal(d.price_source, 'special');
  assert.equal(d.needs_approval, 0);
  assert.equal(buildDoc(db, { ...base, lines: [{ product_code: '10001-2', quoted_price: 149 }] }, sales).lines[0].needs_approval, 1);
  // ลูกค้าอื่นไม่ได้ราคาพิเศษนี้
  assert.equal(buildDoc(db, { ...base, customer_name: 'ลูกค้าอื่น' }, sales).lines[0].quoted_price, 165);
});

// 2026-10-28 (security review): ลูกค้าใหม่ไม่มีรหัส = คีย์จากชื่อที่พิมพ์เอง — Sales อื่นพิมพ์ชื่อเดียวกันต้องไม่ได้ราคาพิเศษนี้
test('ราคาพิเศษลูกค้าใหม่ (คีย์ชื่อ) ใช้ได้เฉพาะผู้สร้างใบที่ได้รับอนุมัติ', () => {
  const db = makeDb();
  db.prepare("INSERT INTO customer_special_prices (cust_key, product_code, price, source_quotation_id) VALUES ('N:ลูกค้าทดสอบ', '10001-2', 150, 'Q-S1')").run();
  const other = { ...sales, uid: 's2' };
  const d = buildDoc(db, { ...base, customer_name: ' ลูกค้าทดสอบ ' }, other).lines[0];
  assert.equal(d.price_source, 'tier');
  assert.equal(buildDoc(db, { ...base, lines: [{ product_code: '10001-2', quoted_price: 150 }] }, other).lines[0].needs_approval, 1);
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
