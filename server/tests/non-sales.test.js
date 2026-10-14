const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { nonSalesCodes, withExclude, resetNonSalesCache } = require('../lib/nonSales');

// ลูกค้าที่ไม่นับเป็นยอดขาย (2026-10-14): บริษัทในเครือ / Shop / พนักงาน / เบิกตัวอย่าง-ออกบูธ / ทีจีเอ็ม+รายได้อื่น
test('non-sales customers: in-group, shops, staff, samples are excluded; normal customers stay', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const p = db.prepare(`INSERT INTO customer_profiles (code, corporate, category, exec_channel, business_type) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate, category = excluded.category, exec_channel = excluded.exec_channel, business_type = excluded.business_type`);
  p.run('NS-01', 'ไทยซอสเซส (บริษัทในเครือ)', null, null, null);
  p.run('NS-02', 'TGM Shop พระราม 3', null, 'general', null);
  p.run('NS-03', 'Shop โรงงาน (ตู้ทอด)', 'เอเย่น', 'shop_factory', 'company_shop');
  p.run('NS-04', 'พนักงาน', 'พนักงาน', 'general', 'employee');
  p.run('NS-05', 'ออกบูธ', 'ออกบูธ', 'general', 'other');
  p.run('NS-06', 'ไทย-เยอรมัน', 'ไทย-เยอรมัน', 'general', 'affiliate');
  p.run('OK-01', 'Makro TSS', 'Makro TSS', 'makro', 'modern_trade');
  p.run('OK-02', 'ร้านอาหาร A', 'ร้านค้าทั่วไป', 'general', 'restaurant');
  resetNonSalesCache();
  const ns = nonSalesCodes(db);
  for (const c of ['NS-01', 'NS-02', 'NS-03', 'NS-04', 'NS-05', 'NS-06']) assert.ok(ns.has(c), c);
  for (const c of ['OK-01', 'OK-02']) assert.ok(!ns.has(c), c);
  // ใช้ใน SQL: ยอดรวมไม่นับลูกค้ากลุ่มนี้ (รวมกับเงื่อนไขสิทธิ์ได้)
  const ins = db.prepare(`INSERT INTO invoice_sales_monthly (company, ym, cust_code, slm_code, amount) VALUES ('TSS', '2026-10', ?, 'S1', 100)`);
  for (const c of ['NS-01', 'NS-02', 'NS-04', 'OK-01', 'OK-02']) ins.run(c);
  const w = withExclude(db, { sql: "slm_code = ?", params: ['S1'] });
  assert.equal(db.prepare(`SELECT SUM(amount) a FROM invoice_sales_monthly WHERE ${w.sql}`).get(...w.params).a, 200);
  const w2 = withExclude(db, null);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM invoice_sales_monthly WHERE ${w2.sql}`).get(...w2.params).n, 2);
});

// Category (Sales) ทั้งระบบที่ยังว่าง (2026-10-14) — ห้าง → Retail, ส่งออก → Export, Online → Online, ไม่ทราบ → Direct Domestic
test('remaining sales categories come from existing system groups', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const get = code => db.prepare('SELECT sales_category FROM customer_profiles WHERE code = ?').get(code)?.sales_category;
  assert.equal(get('30-PN-1001'), 'Retail');
  assert.equal(get('TOA-01-QC'), 'Export');
  assert.equal(get('01-ON-0001'), 'Online');
  assert.equal(get('CNC-01-QC'), 'Direct Domestic');
});
