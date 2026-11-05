'use strict';

const fs = require('fs');
const path = require('path');
const { autofillBusinessTypes } = require('../lib/businessType');

// customer_profiles.code เคยมี REFERENCES customers(code) — customers คือ mirror ของ Express ARMAS เท่านั้น
// ลูกค้าของ Bplus โรงงาน (NSL-01-KK, TOA-01-QC, BP-POS …) และสาขาห้างจากห้อง SKU ไม่มีแถวใน customers
// จึงบันทึกกลุ่ม/หมวดให้ไม่ได้เลย (upsert ล้มด้วย FOREIGN KEY constraint failed เงียบๆ ที่ฝั่งหน้าเว็บ) — พบ 2026-10-07
// ตาราง overlay นี้ไม่ต้องการ FK (ข้อมูล master มาจากหลายแหล่ง) จึงสร้างตารางใหม่โดยไม่มี FK ตามขั้นตอน 12 ขั้นของ SQLite
// view/trigger ที่อ้าง customer_profiles ต้องลบก่อนแล้วสร้างคืน ไม่งั้น RENAME จะล้มเพราะ view อ้างตารางที่ยังไม่มี
function dropCustomerProfilesFk(db) {
  const fks = db.prepare("PRAGMA foreign_key_list('customer_profiles')").all();
  if (!fks.length) return;
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_profiles'").get().sql;
  const newSql = tableSql.replace(/\s+REFERENCES\s+customers\s*\(\s*code\s*\)/i, '');
  if (newSql === tableSql) throw new Error('customer_profiles: ไม่พบ REFERENCES customers(code) ใน CREATE TABLE');
  const dependents = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('view','trigger') AND sql LIKE '%customer_profiles%'`).all();
  const indexes = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='customer_profiles' AND sql IS NOT NULL`).all();
  const cols = db.prepare("PRAGMA table_info('customer_profiles')").all().map((c) => `"${c.name}"`).join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const d of dependents) db.exec(`DROP ${d.type.toUpperCase()} IF EXISTS "${d.name}"`);
    db.exec(newSql.replace(/^CREATE TABLE\s+"?customer_profiles"?/i, 'CREATE TABLE customer_profiles_nofk'));
    db.exec(`INSERT INTO customer_profiles_nofk (${cols}) SELECT ${cols} FROM customer_profiles`);
    db.exec('DROP TABLE customer_profiles');
    db.exec('ALTER TABLE customer_profiles_nofk RENAME TO customer_profiles');
    for (const i of indexes) db.exec(i.sql);
    for (const d of dependents.filter((x) => x.type === 'view')) db.exec(d.sql);
    for (const d of dependents.filter((x) => x.type === 'trigger')) db.exec(d.sql);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.log(`[migrations] customer_profiles: dropped FK to customers (restored ${dependents.length} views/triggers)`);
}

// จัดกลุ่มลูกค้าที่มียอดตั้งแต่ 2025 แต่ยังไม่มี Corporate group (2026-10-07, ผู้ใช้ขอ) — รายการตรวจแล้วอยู่ใน
// data/customer-regroup-20261007.json (อิงกลุ่มเดิมก่อน: เครือห้าง/ชื่อบริษัทที่มีกลุ่มอยู่แล้ว/prefix รหัสเดียวกัน
// ไม่งั้นใช้ชื่อบริษัทของลูกค้าเอง) · เขียนเฉพาะแถวที่ corporate ยังว่าง ไม่ทับที่คนตั้งไว้ · รันครั้งเดียว
function applyCustomerRegroup20261007(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261007_customer_regroup_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'customer-regroup-20261007.json'), 'utf8'));
  const by = 'regroup-2026-10-07';
  // ชื่อสำหรับรหัสที่ไม่มีใน customers (Bplus) — ให้หน้า จัดการกลุ่ม แสดงชื่อแทนรหัส
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c,
    (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, corporate, corp_source, corp_confirmed, corp_confirmed_by, corp_confirmed_at, edited_by, updated_at)
    VALUES (?, ?, ?, 'manual', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate, corp_source = 'manual', corp_confirmed = 1,
      corp_confirmed_by = excluded.corp_confirmed_by, corp_confirmed_at = excluded.corp_confirmed_at,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name),
      edited_by = excluded.edited_by, updated_at = excluded.updated_at
    WHERE COALESCE(TRIM(customer_profiles.corporate), '') = ''`);
  const setType = db.prepare(`UPDATE customer_profiles SET business_type = ?, business_type_source = 'manual'
    WHERE code = ? AND COALESCE(business_type_source, '') <> 'manual'`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const nm = nameOf.get(it.code, it.code);
      n += upsert.run(it.code, nm.c ? null : (nm.b || null), it.corporate, by, by).changes;
      if (it.business_type) setType.run(it.business_type, it.code);
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] customer regroup 2026-10-07: set corporate on ${n}/${items.length} customers`);
}

function migrateCustomerProfilesV2(db) {
  dropCustomerProfilesFk(db);
  applyCustomerRegroup20261007(db);
  // เดาประเภทธุรกิจครั้งแรก (ไม่ทับค่าที่ตั้งเอง) — หลังจากนั้นกดปุ่มในหน้า จัดการกลุ่ม เพื่อเดาใหม่ได้
  const id = '20261007_business_type_autofill_v1';
  if (!db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) {
    const r = autofillBusinessTypes(db, 'system');
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    console.log(`[migrations] business_type autofill: ${r.updated} customers`);
  }
}

// กลุ่มลูกค้าฝั่ง Sales (2026-10-12, ผู้ใช้ขอ) — แยกจาก corporate/category/exec_channel (ของผู้บริหาร)
// ข้อมูลตั้งต้นจากไฟล์ Group ของเซลล์ 9 คน (scripts/build-sales-groups.py → data/sales-groups-20261012.json)
// เขียนเฉพาะช่องที่ยังว่าง ไม่ทับที่คนแก้ไว้ · รันครั้งเดียว
function applySalesGroups20261012(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261012_sales_groups_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-groups-20261012.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, sales_group, sales_group_by, edited_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 'sales-groups-2026-10-12', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET
      sales_category = COALESCE(NULLIF(TRIM(customer_profiles.sales_category), ''), excluded.sales_category),
      sales_group = COALESCE(NULLIF(TRIM(customer_profiles.sales_group), ''), excluded.sales_group),
      sales_group_by = COALESCE(NULLIF(TRIM(customer_profiles.sales_group_by), ''), excluded.sales_group_by),
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name),
      updated_at = excluded.updated_at`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const nm = nameOf.get(it.code, it.code);
      n += upsert.run(it.code, nm.c ? null : (nm.b || null), it.sales_category || null, it.sales_group || null, it.by || null).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales groups 2026-10-12: ${n}/${items.length} customers`);
}

// แก้ข้อมูลตั้งต้น v1 (2026-10-14, ตรวจซ้ำกับไฟล์ Group) — 1) 7 ลูกค้ารหัสท้าย 2 ตัว (TNA-01-KK ฯลฯ) ตกหล่น → ใส่ Category
// 2) ชีต "corporate ไมเนอร์ กรุ๊ป" (Gike) มี 2 บล็อกที่เริ่มเลขกลุ่มใหม่ สคริปต์เดิมรวมกลุ่มเลขเดียวกันข้ามบล็อก → กลุ่ม (Sales) ผิด 10 ราย
// แก้เฉพาะแถวที่ยังเป็นค่าเดิมจาก v1 (ว่าง / ค่าผิดเดิม) ไม่ทับที่คนแก้ไว้ภายหลัง · รันครั้งเดียว
const SALES_GROUP_FIXES_20261014 = [
  // [code, กลุ่มผิดจาก v1, กลุ่มที่ถูก]
  ['MI-LA-0001', 'Select Service Partner', 'The Pizza Company'],
  ['MI-LA-0002', 'Select Service Partner', 'The Pizza Company'],
  ['MI-LA-0005', 'The Pizza Company', 'The Coffee Club'],
  ['MI-LA-0006', 'Bonchon', 'Sizzler'],
  ['MI-LA-0007', 'Bonchon', 'Sizzler'],
  ['MI-LA-0008', 'Bonchon', 'Sizzler'],
  ['MI-LA-0009', 'Bonchon', 'Sizzler'],
  ['MI-LA-0015', 'Bonchon', 'Sizzler'],
  ['MI-LA-0011', 'The Coffee Club', 'Burgerking'],
  ['MI-LA-0014', 'The Coffee Club', 'Burgerking'],
];
const SALES_CATEGORY_ADDS_20261014 = [
  ['TNA-01-KK', 'ธีระพล'], ['ALS-01-KG', 'ธีระพล'], ['NGT-01-KF', 'ธีระพล'],
  ['OIS-01-KF', 'วีรวุฒิ'], ['ZKC-01-KF', 'วีรวุฒิ'], ['FAD-01-KK', 'วีรวุฒิ'], ['SPS-02-KF', 'วีรวุฒิ'],
];
function applySalesGroupsFix20261014(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261014_sales_groups_fix_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const fixGroup = db.prepare(`UPDATE customer_profiles SET sales_group = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE code = ? AND (sales_group IS NULL OR TRIM(sales_group) IN ('', ?))`);
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const addCat = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, sales_group_by, edited_by, updated_at)
    VALUES (?, ?, 'ร้านค้าทั่วไป', ?, 'sales-groups-2026-10-14', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET
      sales_category = COALESCE(NULLIF(TRIM(customer_profiles.sales_category), ''), excluded.sales_category),
      sales_group_by = COALESCE(NULLIF(TRIM(customer_profiles.sales_group_by), ''), excluded.sales_group_by),
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name),
      updated_at = excluded.updated_at`);
  let g = 0, c = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [code, from, to] of SALES_GROUP_FIXES_20261014) g += fixGroup.run(to, code, from).changes;
    for (const [code, by] of SALES_CATEGORY_ADDS_20261014) {
      const nm = nameOf.get(code, code);
      c += addCat.run(code, nm.c ? null : (nm.b || null), by).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales groups fix 2026-10-14: ${g} groups, ${c} categories`);
}

// Corporate group ของลูกค้าเครือ Minor (2026-10-14, ผู้ใช้ขอ) — ไฟล์ Group Gike ชีต "corporate ไมเนอร์ กรุ๊ป" จัด 25 รายนี้
// (ร้านอาหาร MI-LA-* + ซีเลค เซอร์วิส พาร์ทเนอร์ 30-LA-*) เป็นกลุ่ม Minor แยกไว้ แต่ corporate ยังเป็นชื่อนิติบุคคล 7 ชื่อ
// → รวมเป็น "Minor Group" (ผู้ใช้เลือก: รวมเป็นกลุ่มเดียว แบรนด์อยู่ใน กลุ่ม (Sales) · ไม่รวมโรงแรม MI-LD-*)
// แก้เฉพาะแถวที่ corporate ยังว่างหรือเป็นชื่อนิติบุคคลเดิม ไม่ทับที่คนตั้งเป็นอย่างอื่นไว้ · รันครั้งเดียว
const MINOR_GROUP_CODES = [
  'MI-LA-0001', 'MI-LA-0002', 'MI-LA-0003', 'MI-LA-0005', 'MI-LA-0006', 'MI-LA-0007', 'MI-LA-0008', 'MI-LA-0009',
  'MI-LA-0010', 'MI-LA-0011', 'MI-LA-0012', 'MI-LA-0013', 'MI-LA-0014', 'MI-LA-0015', 'MI-LA-0016', 'MI-LA-0017', 'MI-LA-0018',
  '30-LA-0152', '30-LA-0155', '30-LA-0158', '30-LA-0163', '30-LA-0164', '30-LA-0166', '30-LA-0171', '30-LA-0178',
];
const MINOR_OLD_CORPS = ['ซีเลค เซอร์วิส พาร์ทเนอร์', 'ไมเนอร์', 'เอ็มเอฟ คาเฟ่', 'ชิคเก้น ไทม์', 'เบอร์เกอร์', 'เบอรเกอร์', 'บีทีเอ็ม'];
function applyMinorGroup20261014(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261014_minor_group_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const by = 'minor-group-2026-10-14';
  const cur = db.prepare('SELECT corporate FROM customer_profiles WHERE code = ?');
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, corporate, corp_source, corp_confirmed, corp_confirmed_by, corp_confirmed_at, edited_by, updated_at)
    VALUES (?, ?, 'Minor Group', 'manual', 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate, corp_source = 'manual', corp_confirmed = 1,
      corp_confirmed_by = excluded.corp_confirmed_by, corp_confirmed_at = excluded.corp_confirmed_at,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name),
      edited_by = excluded.edited_by, updated_at = excluded.updated_at`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const code of MINOR_GROUP_CODES) {
      const c = String(cur.get(code)?.corporate || '').replace(/[\s\u00a0]+/g, ' ').trim();
      if (c && c !== 'Minor Group' && !MINOR_OLD_CORPS.some((x) => c.includes(x))) continue;
      const nm = nameOf.get(code, code);
      n += upsert.run(code, nm.c ? null : (nm.b || null), by, by).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] Minor Group 2026-10-14: corporate set on ${n}/${MINOR_GROUP_CODES.length} customers`);
}

// Category (Sales) ของลูกค้าทีมฝ่ายขายร้านค้าที่ยังว่าง (2026-10-14, ผู้ใช้ขอ "ตรวจร้านค้าที่ยังไม่ระบุกลุ่ม ดึงข้อมูลมาให้เรียบร้อย")
// 154 รายที่มียอดตั้งแต่ 2025 แต่ไม่อยู่ในไฟล์ Group ของเซลล์ (ลูกค้าใหม่หลัง 9 ต.ค., ลูกค้าโรงงาน Bplus เช่น NSL,
// เครือ Minor ที่ไฟล์มีแค่ชีต corporate) → ใช้ Category ที่ลูกค้า corporate เดียวกันส่วนใหญ่ใช้ ไม่มี = "ร้านค้าทั่วไป"
// (ค่าหลักของไฟล์ร้านค้า 2,762/3,176 ราย) · data/sales-category-fill-20261014.json · เติมเฉพาะช่องที่ยังว่าง · รันครั้งเดียว
function applySalesCategoryFill20261014(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261014_sales_category_fill_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-category-fill-20261014.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, edited_by, updated_at)
    VALUES (?, ?, ?, 'sales-category-2026-10-14', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_category = excluded.sales_category,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name), updated_at = excluded.updated_at
    WHERE COALESCE(TRIM(customer_profiles.sales_category), '') = ''`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const nm = nameOf.get(it.code, it.code);
      n += upsert.run(it.code, nm.c ? null : (nm.b || null), it.sales_category).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales category fill 2026-10-14: ${n}/${items.length} customers`);
}

// กลุ่ม (Sales) ของเครือ Minor แบบเดียวกับ TCC (2026-10-14, ผู้ใช้ขอ) — TCC ใช้กลุ่มเดียว "TCC Group (Marriott/Hilton/…)"
// ครอบหลายบริษัท · Minor เดิมแยก 7 กลุ่มตามแบรนด์ในชีต (The Pizza Company / The Coffee Club / …) ทำให้ Sales Overview
// กระจายหลายแถว → รวมเป็นกลุ่มเดียว ชื่อบอกแบรนด์ในวงเล็บ · 25 รายเดียวกับ corporate Minor Group (ไม่รวมโรงแรม MI-LD-*)
// เปลี่ยนเฉพาะแถวที่ยังว่าง หรือยังเป็นชื่อแบรนด์เดิมจากไฟล์ ไม่ทับที่ตั้งเป็นอย่างอื่น · รันครั้งเดียว
const MINOR_SALES_GROUP = 'Minor Group (The Pizza Company/The Coffee Club/Sizzler/Bonchon/Burger King/Breadtalk/Select Service Partner)';
const MINOR_BRAND_GROUPS = ['The Pizza Company', 'The Coffee Club', 'Sizzler', 'Bonchon', 'Burgerking', 'Breadtalk', 'Select Service Partner'];
function applyMinorSalesGroup20261014(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261014_minor_sales_group_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const upd = db.prepare(`UPDATE customer_profiles SET sales_group = ?, sales_group_by = COALESCE(NULLIF(TRIM(sales_group_by), ''), 'Gike'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE code = ? AND (COALESCE(TRIM(sales_group), '') = '' OR sales_group IN (SELECT value FROM json_each(?)))`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const code of MINOR_GROUP_CODES) n += upd.run(MINOR_SALES_GROUP, code, JSON.stringify(MINOR_BRAND_GROUPS)).changes;
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] Minor sales group 2026-10-14: ${n}/${MINOR_GROUP_CODES.length} customers`);
}

// Category (Sales) = คอลัมน์ "Group" ในไฟล์ Group ของเซลล์ (2026-10-14, ผู้ใช้ขอ) — แทนค่ารอบแรกจากคอลัมน์ A
// (ร้านค้าทั่วไป / ชื่อห้าง) · Scripts/build-sales-category-group.py → data/sales-category-group-20261014.json
//   groups: รหัส → Group (Restaurant / Bakery / Hotel / Retail / …) · old_map: ค่ารอบแรก → Group สำหรับรายที่ไฟล์ไม่มีค่า Group
//   ("ร้านค้าทั่วไป" แปลงตรงไม่ได้ → เดาจากประเภทธุรกิจเฉพาะ 3 ประเภทที่แม่น ที่เหลือว่าง — ร้านอาหาร/เบเกอรี่ ตรงกับไฟล์แค่ ~60% ไม่ใช้)
// เปลี่ยนเฉพาะแถวที่ยังว่าง หรือยังเป็นค่าแบบรอบแรก (คีย์ของ old_map) — ค่าที่คนตั้งใหม่แบบ Group แล้วไม่ทับ · รันครั้งเดียว
function applySalesCategoryGroup20261014(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261014_sales_category_group_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-category-group-20261014.json');
  if (!fs.existsSync(file)) return;
  const { groups, old_map: oldMap } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const isOld = (v) => !String(v || '').trim() || Object.prototype.hasOwnProperty.call(oldMap, String(v).trim());
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const set = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, edited_by, updated_at)
    VALUES (?, ?, ?, 'sales-category-group-2026-10-14', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_category = excluded.sales_category,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name), updated_at = excluded.updated_at`);
  const cur = db.prepare('SELECT sales_category FROM customer_profiles WHERE code = ?');
  let fromFile = 0, mapped = 0, cleared = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [code, g] of Object.entries(groups)) {
      const row = cur.get(code);
      if (row && !isOld(row.sales_category)) continue;
      if (row && row.sales_category === g) continue;
      const nm = nameOf.get(code, code);
      fromFile += set.run(code, nm.c ? null : (nm.b || null), g).changes;
    }
    // ไม่อยู่ในไฟล์ (หรือไฟล์ไม่มีค่า Group) แต่ยังเป็นค่าแบบรอบแรก → แปลงตาม old_map
    const left = db.prepare(`SELECT code, sales_category FROM customer_profiles WHERE COALESCE(TRIM(sales_category), '') <> ''`).all()
      .filter((r) => !groups[r.code] && Object.prototype.hasOwnProperty.call(oldMap, r.sales_category.trim()));
    const upd = db.prepare(`UPDATE customer_profiles SET sales_category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`);
    // ล้างแล้ว ("ร้านค้าทั่วไป" ที่ไฟล์ไม่มี Group) → เดาจากประเภทธุรกิจเฉพาะที่ตรงกับไฟล์สูง (เทียบ 2,956 รายในไฟล์:
    // modern_trade → Retail 92%, food_processor → Food Industry 100%, hotel → Hotel 79%) ที่เหลือว่างให้เซลล์กรอก
    const BT_GROUP = { modern_trade: 'Retail', food_processor: 'Food Industry', hotel: 'Hotel' };
    const bt = db.prepare('SELECT business_type FROM customer_profiles WHERE code = ?');
    for (const r of left) {
      const g = oldMap[r.sales_category.trim()] || BT_GROUP[bt.get(r.code)?.business_type] || null;
      upd.run(g, r.code);
      if (g) mapped++; else cleared++;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales category = Group 2026-10-14: file ${fromFile}, mapped ${mapped}, cleared ${cleared}`);
}

// Category (Sales) ของ 67 รายที่ยังว่างหลังใช้คอลัมน์ Group (2026-10-14, ผู้ใช้ขอ "ทำให้เรียบร้อย") — ลูกค้าทีมร้านค้าที่มียอด ต.ค.
// แต่ไฟล์ไม่มีค่า Group · data/sales-category-manual-20261014.json (มี reason ต่อราย): ลูกค้าบริษัท/ชื่อเดียวกันในไฟล์ 9 ราย,
// บุคคลธรรมดา → Direct Domestic (แบบเดียวกับในไฟล์) 15 ราย, ที่เหลือจัดจากชื่อร้าน/ประเภทกิจการ · ตั้งเฉพาะที่ยังว่าง · รันครั้งเดียว
function applySalesCategoryManual20261014(db) {
  applySalesCategoryList(db, '20261014_sales_category_manual_v1', 'sales-category-manual-20261014.json', 'sales-category-manual-2026-10-14');
}
// ลูกค้าทั้งระบบที่ยังไม่มี Category (Sales) (2026-10-14, ผู้ใช้ขอ "ระบุโดยใช้ข้อมูลกลุ่มเดิมในระบบก่อน") — 1,458 ราย
// data/sales-category-fill2-20261014.json (reason ต่อราย): ห้าง/ซูเปอร์ฯ (หมวดผู้บริหาร mall/makro, modern_trade,
// ตันตราภัณฑ์/สุวรรณชาด/สยามวิชโก้/สินทรัพย์ก้าวหน้า) → Retail · ส่งออก → Export (ใหม่) · Online → Online (ใหม่) ·
// ประเภทธุรกิจในระบบ → Restaurant/Bakery/Hotel/… · ที่เหลือ (ร้านค้าทั่วไปไม่ทราบประเภท) → Direct Domestic (ผู้ใช้เลือก)
// ไม่รวมลูกค้าที่ไม่นับเป็นยอดขาย (lib/nonSales.js) · ตั้งเฉพาะที่ยังว่าง · รันครั้งเดียว
function applySalesCategoryFill2_20261014(db) {
  applySalesCategoryList(db, '20261014_sales_category_fill2_v1', 'sales-category-fill2-20261014.json', 'sales-category-fill2-2026-10-14');
}
function applySalesCategoryList(db, id, fileName, editedBy) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', fileName);
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, edited_by, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_category = excluded.sales_category,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name), updated_at = excluded.updated_at
    WHERE COALESCE(TRIM(customer_profiles.sales_category), '') = ''`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const nm = nameOf.get(it.code, it.code);
      n += upsert.run(it.code, nm.c ? null : (nm.b || null), it.sales_category, editedBy).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] ${id}: ${n}/${items.length} customers`);
}

// กลุ่ม (Sales) ตามบล็อก "หมายเหตุ Corporate" (2026-10-19, ผู้ใช้แจ้ง "เคนชินของเซลล์เชลไม่รวมกัน") — สคริปต์รอบแรกหา
// คอลัมน์หมายเหตุด้วย startswith('หมายเหตุ corp') ทำให้ 3 ชีตที่สะกด "หมายเหตุcorporate" (เชล, เน) / "หมายเหตุ Cororate" (สุนทรี)
// ไม่เจอคอลัมน์ → จับกลุ่มตามชื่อบริษัทแทนบล็อกในไฟล์ (Kenshin Izakaya แตกเป็น 4 กลุ่ม, เคนโซตกไป) · แก้สคริปต์แล้วสร้าง
// data/sales-groups-fix-20261019.json = [รหัส, ค่าเดิมจากรอบแรก, ค่าที่ถูก] · เปลี่ยนเฉพาะแถวที่ยังเป็นค่าเดิมหรือว่าง
// (ไม่ทับที่คนแก้ในหน้า จัดการกลุ่ม) · รันครั้งเดียว
function applySalesGroupsFix20261019(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20261019_sales_groups_corp_note_v1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-groups-fix-20261019.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  // upsert (code review): รหัสที่ยังไม่มีแถวใน customer_profiles ต้องได้กลุ่มด้วย ไม่งั้นถูกข้ามแล้ว migration ถือว่าเสร็จ
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upd = db.prepare(`INSERT INTO customer_profiles (code, name, sales_group, edited_by, updated_at)
    VALUES (?, ?, ?, 'sales-groups-fix-2026-10-19', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_group = excluded.sales_group, updated_at = excluded.updated_at,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name)
    WHERE COALESCE(TRIM(customer_profiles.sales_group), '') = '' OR TRIM(customer_profiles.sales_group) = ?`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [code, from, to] of items) {
      if (!to) continue;
      const nm = nameOf.get(code, code);
      n += upd.run(code, nm.c ? null : (nm.b || null), to, String(from || '').trim()).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales groups corp-note fix 2026-10-19: ${n}/${items.length} customers`);
}

// ไทยซอสเซส มีทซัพพลาย จำกัด นับเป็นยอดขาย และเป็นลูกค้าของคุณอุ้ม 114 (2026-11-04, ผู้ใช้สั่ง)
// เดิมถูกตัดจากยอดเพราะระบบเดาเป็น affiliate จากคำว่า "ไทยซอสเซส" (lib/nonSales.js) — ตั้ง manual กันระบบเดาทับ
// LA-30-0005 ไม่ตั้ง override: ใบปัจจุบันลงรหัส 114 อยู่แล้ว ส่วนใบก่อน พ.ย. 2567 เป็นยอดของคุณหลิน 111 ต้องคงไว้
function applyMeatSupplyCounted20261104(db) {
  const id = '20261104_meat_supply_counted_oum';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const by = 'user-2026-11-04';
  const setProfile = db.prepare(`UPDATE customer_profiles SET corporate = ?, corp_source = 'manual', corp_confirmed = 1,
      corp_confirmed_by = ?, corp_confirmed_at = ?, business_type = 'agent', business_type_source = 'manual',
      sales_category = COALESCE(NULLIF(TRIM(sales_category), ''), 'Agent Domestic'), edited_by = ?, updated_at = ?
    WHERE code = ?`);
  const setOwner = db.prepare('INSERT OR IGNORE INTO sales_slm_override (cust_code, slm_code, note) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const code of ['LA-30-0005', 'TSM-02-QA', '30-NL-0001', '30-TS-0002']) {
    setProfile.run('ไทยซอสเซส มีทซัพพลาย จำกัด', by, now, by, now, code);
  }
  for (const code of ['TSM-02-QA', '30-NL-0001']) {
    setOwner.run(code, '114', 'ไทยซอสเซส มีทซัพพลาย — เป็นของคุณอุ้ม (114) ตามที่ผู้ใช้สั่ง 2026-11-04');
  }
  db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
}

// Category (Sales) ของลูกค้าคุณปู (คุณลักษณา) ตามชีตหลักของไฟล์ Group (2026-11-05, ผู้ใช้แจ้ง "จารุณี เหมือนสุวรรณ เป็น Restaurant แต่ในระบบเป็น
// Direct Domestic") — ชีตหลักมีค่าในคอลัมน์ M แต่ไม่มีหัว "Group" สคริปต์รอบ 2026-10-14 เลยอ่านแต่ Sheet1 (ชีต Corporate ของคุณปู): 87 รายไม่อยู่ใน Sheet1
// ตกไปเป็นค่าเดา และ 128 รายสองชีตไม่ตรงกัน (แบล็คแคนยอน/Yakun: ชีตหลัก Chain Restaurants, Sheet1 Bakery) · ถือชีตหลักเป็นค่าจริง + 7 รหัสที่ไม่อยู่ในไฟล์
// แต่ corporate เดียวกัน · data/sales-category-fix-20261105.json = [รหัส, ค่าเดิม, ค่าที่ถูก] · เปลี่ยนเฉพาะแถวที่ยังเป็นค่าเดิมหรือว่าง
// (ไม่ทับที่คนแก้ในหน้า จัดการกลุ่ม) · รันครั้งเดียว
function applySalesCategoryFix20261105(db) {
  const id = '20261105_sales_category_poo_main_sheet';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-category-fix-20261105.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upd = db.prepare(`INSERT INTO customer_profiles (code, name, sales_category, edited_by, updated_at)
    VALUES (?, ?, ?, 'sales-category-fix-2026-11-05', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_category = excluded.sales_category, edited_by = excluded.edited_by, updated_at = excluded.updated_at,
      name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name)
    WHERE COALESCE(TRIM(customer_profiles.sales_category), '') = '' OR TRIM(customer_profiles.sales_category) = ?`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [code, from, to] of items) {
      const nm = nameOf.get(code, code);
      n += upd.run(code, nm.c ? null : (nm.b || null), to, from).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales category fix 2026-11-05: ${n}/${items.length} customers`);
}

// กลุ่ม (Sales) ของลูกค้าคุณปู (2026-11-05) — Sheet1 คือชีต Corporate ของคุณปู (บล็อกคั่นด้วยแถวว่าง ชื่อกลุ่มอยู่คอลัมน์ "หมายเหตุ") แต่ชื่อชีตไม่มี "corp"
// และหัวไม่มี "co" Scripts/build-sales-groups.py เลยไม่อ่าน ลูกค้าคุณปูจึงไม่มีกลุ่มเลย (เซลล์คนอื่นมีครบ) · data/sales-groups-poo-20261105.json = [รหัส, กลุ่ม]
// ไม่รวม 30-TC-0001 ("ไม่ใช้ ลบได้") · รวมแบล็คแคนยอน 4 รหัสที่ไม่อยู่ในไฟล์ · เติมเฉพาะช่องที่ยังว่าง (ไม่ทับที่คนแก้) · รันครั้งเดียว
function applySalesGroupsPoo20261105(db) {
  const id = '20261105_sales_groups_poo_sheet1';
  if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) return;
  const file = path.join(__dirname, 'data', 'sales-groups-poo-20261105.json');
  if (!fs.existsSync(file)) return;
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nameOf = db.prepare(`SELECT (SELECT name FROM customers WHERE code = ?) AS c, (SELECT name FROM bplus_customers WHERE code = ?) AS b`);
  const upd = db.prepare(`INSERT INTO customer_profiles (code, name, sales_group, sales_group_by, edited_by, updated_at)
    VALUES (?, ?, ?, 'ลักษณา', 'sales-groups-poo-2026-11-05', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET sales_group = excluded.sales_group, sales_group_by = excluded.sales_group_by,
      edited_by = excluded.edited_by, updated_at = excluded.updated_at, name = COALESCE(NULLIF(customer_profiles.name, ''), excluded.name)
    WHERE COALESCE(TRIM(customer_profiles.sales_group), '') = ''`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [code, group] of items) {
      const nm = nameOf.get(code, code);
      n += upd.run(code, nm.c ? null : (nm.b || null), group).changes;
    }
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrations] sales groups poo 2026-11-05: ${n}/${items.length} customers`);
}

module.exports = { migrateCustomerProfilesV2, applySalesGroups20261012, applySalesGroupsFix20261014, applyMinorGroup20261014, applySalesCategoryFill20261014, applyMinorSalesGroup20261014, applySalesCategoryGroup20261014, applySalesCategoryManual20261014, applySalesCategoryFill2_20261014, applySalesGroupsFix20261019, applyMeatSupplyCounted20261104, applySalesCategoryFix20261105, applySalesGroupsPoo20261105 };
