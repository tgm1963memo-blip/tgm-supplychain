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

module.exports = { migrateCustomerProfilesV2, applySalesGroups20261012, applySalesGroupsFix20261014 };
