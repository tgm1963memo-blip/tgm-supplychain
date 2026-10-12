const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { applySalesGroups20261012 } = require('../db/customerProfilesV2');

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
