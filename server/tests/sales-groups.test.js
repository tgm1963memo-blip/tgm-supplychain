const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { applySalesGroups20261012, applySalesGroupsFix20261014, applyMinorGroup20261014, applySalesCategoryFill20261014, applyMinorSalesGroup20261014, applySalesCategoryGroup20261014 } = require('../db/customerProfilesV2');

// กลุ่มลูกค้าฝั่ง Sales (2026-10-12): seed จากไฟล์ Group ของเซลล์ — ครั้งเดียว ไม่ทับค่าที่คนแก้
test('sales groups seed applies once and never overwrites edited values', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '../db/data/sales-groups-20261012.json'), 'utf8'));
  const withGroup = seed.find(x => x.sales_group);
  const row = db.prepare('SELECT sales_category, sales_group, sales_group_by FROM customer_profiles WHERE code = ?').get(withGroup.code);
  assert.equal(row.sales_group, withGroup.sales_group);
  // Category ภายหลังแปลงเป็นค่าคอลัมน์ Group (20261014_sales_category_group_v1) — ดูเทสต์ท้ายไฟล์
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
  assert.match(get('MI-LA-0011').sales_group, /^Minor Group \(/); // ภายหลังรวมเป็นกลุ่ม Minor แบบ TCC (20261014_minor_sales_group_v1)
  assert.equal(get('OIS-01-KF').sales_category, 'Food Industry'); // ภายหลังเป็นค่า Group จากไฟล์
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

// Category (Sales) ที่ยังว่างของลูกค้าทีมร้านค้า (2026-10-14) — เติมเฉพาะช่องว่าง ไม่ทับที่ตั้งไว้
test('sales category fill only fills empty values', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const get = code => db.prepare('SELECT sales_category FROM customer_profiles WHERE code = ?').get(code)?.sales_category;
  // หลังรันครบ: ร้านค้าทั่วไปที่ไฟล์ไม่มี Group → เดาจากประเภทธุรกิจที่แม่น · ห้าง → Retail
  assert.equal(get('NSL-01-KK'), 'Food Industry'); // business_type food_processor (autofill)
  assert.equal(get('BD-LF-0134'), 'Retail');
  db.prepare("UPDATE customer_profiles SET sales_category = 'ตั้งเอง' WHERE code = 'NSL-01-KK'").run();
  db.prepare("UPDATE customer_profiles SET sales_category = NULL WHERE code = 'MI-LA-0001'").run();
  db.prepare("DELETE FROM app_migrations WHERE id = '20261014_sales_category_fill_v1'").run();
  applySalesCategoryFill20261014(db);
  assert.equal(get('NSL-01-KK'), 'ตั้งเอง');
  assert.equal(get('MI-LA-0001'), 'ร้านค้าทั่วไป');
});

// กลุ่ม (Sales) Minor แบบ TCC (2026-10-14): แบรนด์เดิมจากไฟล์ → กลุ่มเดียว · ไม่ทับค่าที่ตั้งเป็นอย่างอื่น · ไม่แตะโรงแรม
test('Minor brand sales groups merge into one group like TCC', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const sg = code => db.prepare('SELECT sales_group FROM customer_profiles WHERE code = ?').get(code)?.sales_group;
  assert.match(sg('MI-LA-0001'), /^Minor Group \(The Pizza Company\//);
  db.prepare("UPDATE customer_profiles SET sales_group = 'Sizzler' WHERE code = 'MI-LA-0006'").run();
  db.prepare("UPDATE customer_profiles SET sales_group = 'ตั้งเอง' WHERE code = 'MI-LA-0011'").run();
  db.prepare("INSERT INTO customer_profiles (code, sales_group) VALUES ('MI-LD-0001', 'Minor Group') ON CONFLICT(code) DO UPDATE SET sales_group = 'Minor Group'").run();
  db.prepare("DELETE FROM app_migrations WHERE id = '20261014_minor_sales_group_v1'").run();
  applyMinorSalesGroup20261014(db);
  assert.equal(sg('MI-LA-0006'), sg('MI-LA-0001'));
  assert.equal(sg('MI-LA-0011'), 'ตั้งเอง');
  assert.equal(sg('MI-LD-0001'), 'Minor Group');
});

// Category (Sales) = คอลัมน์ Group ในไฟล์ (2026-10-14): ค่าแบบรอบแรก → Group · ห้าง → Retail · ร้านค้าทั่วไปไม่มี Group →
// เดาเฉพาะประเภทธุรกิจที่แม่น (food_processor → Food Industry) ไม่งั้นว่าง · ค่าที่ตั้งเป็นแบบ Group แล้วไม่ทับ
test('sales category becomes the Group column, old values mapped or cleared', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const { groups } = JSON.parse(fs.readFileSync(path.join(__dirname, '../db/data/sales-category-group-20261014.json'), 'utf8'));
  const get = code => db.prepare('SELECT sales_category FROM customer_profiles WHERE code = ?').get(code)?.sales_category;
  assert.equal(get('MI-LA-0001'), groups['MI-LA-0001']);
  assert.equal(groups['MI-LA-0001'], 'Chain Restaurants');
  const set = db.prepare(`INSERT INTO customer_profiles (code, sales_category, business_type) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET sales_category = excluded.sales_category, business_type = excluded.business_type`);
  set.run('MI-LA-0001', 'ร้านค้าทั่วไป', null);        // ค่ารอบแรก → ค่า Group จากไฟล์
  set.run('MI-LA-0013', 'Hotel', null);                // ตั้งเป็นแบบ Group แล้ว → ไม่ทับ
  set.run('ZZ-TS-0001', 'โลตัส', null);                // ไม่อยู่ในไฟล์ + ชื่อห้าง → Retail
  set.run('ZZ-TS-0002', 'ร้านค้าทั่วไป', 'food_processor');
  set.run('ZZ-TS-0003', 'ร้านค้าทั่วไป', 'restaurant'); // เดาไม่แม่น → ว่าง
  db.prepare("DELETE FROM app_migrations WHERE id = '20261014_sales_category_group_v1'").run();
  applySalesCategoryGroup20261014(db);
  assert.equal(get('MI-LA-0001'), 'Chain Restaurants');
  assert.equal(get('MI-LA-0013'), 'Hotel');
  assert.equal(get('ZZ-TS-0001'), 'Retail');
  assert.equal(get('ZZ-TS-0002'), 'Food Industry');
  assert.equal(get('ZZ-TS-0003'), null);
});
