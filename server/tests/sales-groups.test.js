const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { applySalesGroups20261012, applySalesGroupsFix20261014 } = require('../db/customerProfilesV2');

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
