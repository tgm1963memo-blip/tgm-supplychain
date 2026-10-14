const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { applySalesGroups20261012, applySalesGroupsFix20261014, applyMinorGroup20261014 } = require('../db/customerProfilesV2');

// กลุ่มลูกค้าฝั่ง Sales (2026-10-12): seed จากไฟล์ Group ของเซลล์ — ครั้งเดียว ไม่ทับค่าที่คนแก้
test('sales groups seed applies once and never overwrites edited values', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../db/data/sales-groups-20261012.json'), 'utf8'));
  const withGroup = seed.find(x => x.sales_group);
  const row = db.prepare('SELECT sales_category, sales_group, sales_group_by FROM customer_profiles WHERE code = ?').get(withGroup.code);
  assert.equal(row.sales_group, withGroup.sales_group);
  assert.equal(row.sales_category, withGroup.sales_category);
  assert.ok(db.prepare("SELECT 1 FROM app_migrations WHERE id = '20261012_sales_groups_v1'").get());
  // แก้เองแล้วรันซ้ำ = ไม่ทับ (marker กันไว้) · ถอด marker รันใหม่ก็ไม่ทับช่องที่มีค่าแล้ว
  db.prepare("UPDATE customer_profiles SET sales_group = 'แก้เอง' WHERE code = ?").run(withGroup.code);
  applySalesGroups20261012(db);
  db.prepare("DELETE FROM app_migrations WHERE id = '20261012_sales_groups_v1'").run();
  applySalesGroups20261012(db);
  assert.equal(db.prepare('SELECT sales_group FROM customer_profiles WHERE code = ?').get(withGroup.code).sales_group, 'แก้เอง');
  // ไม่ไปแตะ corporate / category ของผู้บริหาร
  const cp = db.prepare("SELECT COUNT(*) n FROM customer_profiles WHERE edited_by = 'sales-groups-2026-10-12' AND (corporate IS NOT NULL OR category IS NOT NULL)").get();
  assert.equal(cp.n, 0);
});

// แก้ v1 (2026-10-14): กลุ่ม Minor ที่รวมข้ามบล็อกผิด + 7 ลูกค้ารหัสท้าย 2 ตัวที่ตกหล่น — แก้เฉพาะค่าที่ยังเป็นค่าผิดเดิม
test('sales groups fix corrects v1 seed values but keeps manual edits', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const get = code => db.prepare('SELECT sales_category, sales_group FROM customer_profiles WHERE code = ?').get(code);
  assert.equal(get('MI-LA-0011').sales_group, 'Burgerking');
  assert.equal(get('OIS-01-KF').sales_category, 'ร้านค้าทั่วไป');
  // จำลอง DB ที่รัน v1 เก่าไปแล้ว
  db.prepare("UPDATE customer_profiles SET sales_group = 'The Coffee Club' WHERE code IN ('MI-LA-0011','MI-LA-0014')").run();
  db.prepare("UPDATE customer_profiles SET sales_group = 'แก้เอง' WHERE code = 'MI-LA-0001'").run();
  db.prepare("UPDATE customer_profiles SET sales_category = NULL WHERE code = 'OIS-01-KF'").run();
  db.prepare("DELETE FROM app_migrations WHERE id = '20261014_sales_groups_fix_v1'").run();
  applySalesGroupsFix20261014(db);
  assert.equal(get('MI-LA-0011').sales_group, 'Burgerking');
  assert.equal(get('MI-LA-0014').sales_group, 'Burgerking');
  assert.equal(get('MI-LA-0001').sales_group, 'แก้เอง');
  assert.equal(get('OIS-01-KF').sales_category, 'ร้านค้าทั่วไป');
});

// Corporate "Minor Group" (2026-10-14): 25 รายในชีต corporate ไมเนอร์ กรุ๊ป · ไม่ทับค่าที่ตั้งเป็นอย่างอื่น · ไม่แตะโรงแรม MI-LD
test('Minor Group corporate replaces the old legal-entity names only', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const set = db.prepare('INSERT INTO customer_profiles (code, name, corporate) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate');
  set.run('MI-LA-0005', 'เอ็มเอฟ คาเฟ่ แอนด์ เรสเตอรองต์ จำกัด', 'เอ็มเอฟ คาเฟ่ แอนด์ เรสเตอรองต์ จำกัด');
  set.run('MI-LA-0013', 'ไมเนอร์ ฟู้ด โฮลดิ้ง จำกัด', 'ไมเนอร์ ฟู้ด โฮลดิ้ง จำกัด');
  set.run('30-LA-0152', 'ซีเลค เซอร์วิส พาร์ทเนอร์ จำกัด', 'กลุ่มที่ตั้งเอง');
  set.run('MI-LD-0001', 'เจ้าพระยา รีซอร์ท จำกัด', 'เจ้าพระยา รีซอร์ท จำกัด');
  db.prepare("DELETE FROM app_migrations WHERE id = '20261014_minor_group_v1'").run();
  applyMinorGroup20261014(db);
  const corp = code => db.prepare('SELECT corporate FROM customer_profiles WHERE code = ?').get(code)?.corporate;
  assert.equal(corp('MI-LA-0005'), 'Minor Group');
  assert.equal(corp('MI-LA-0013'), 'Minor Group');
  assert.equal(corp('MI-LA-0018'), 'Minor Group'); // ยังไม่มีแถว → สร้างใหม่
  assert.equal(corp('30-LA-0152'), 'กลุ่มที่ตั้งเอง');
  assert.equal(corp('MI-LD-0001'), 'เจ้าพระยา รีซอร์ท จำกัด');
});
