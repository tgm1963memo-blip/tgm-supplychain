const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const cs = require('../lib/customerScope');

// สิทธิ์ "ดูทีมห้างทั้งหมด" (2026-10-22): scope 'teams' ที่รวมทีมห้าง = เห็นลูกค้าทุกรายที่ Dashboard จัดเป็นห้าง/Makro
// แม้ไม่อยู่ในไฟล์ MT และขายโดยเซลล์นอกทีม — แต่ไม่เห็นร้านค้าทั่วไปของเซลล์นอกทีม
test('modern trade migration: Retail renamed, CP Axtra names filled, booth stays empty', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare("DELETE FROM app_migrations WHERE id = '20261106_modern_trade_cp_axtra'").run();
  for (const [code, name] of [['A1', 'สยามแม็คโคร สาขาพัทยา'], ['A6', 'สยามเเม็คโคร สาขาภูเก็ต'], ['A2', 'แม็คโคร HORECA 2026 (เมืองทองธานี)'], ['A3', 'ร้านป้าแดง']]) {
    db.prepare('INSERT INTO customers(code,name,is_active) VALUES(?,?,1)').run(code, name);
  }
  db.prepare("INSERT INTO customer_profiles(code,name,sales_category) VALUES('A4','บิ๊กซี','Retail'),('A5','ร้านอาหาร','Restaurant')").run();
  require('../db/customerProfilesV2').applyModernTrade20261106(db);
  const cat = c => db.prepare('SELECT sales_category s FROM customer_profiles WHERE code = ?').get(c)?.s ?? null;
  assert.equal(cat('A1'), 'Modern Trade');
  assert.equal(cat('A6'), 'Modern Trade', 'ห้อง MAKRO สะกดด้วยสระเอสองตัว');
  assert.equal(cat('A2'), null);
  assert.equal(cat('A3'), null);
  assert.equal(cat('A4'), 'Modern Trade');
  assert.equal(cat('A5'), 'Restaurant');
});

test('customer scope allMt: sees every mall/makro customer, not other teams\' general stores', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const RETAIL = 'แผนกขายธุรกิจค้าปลีก';
  for (const [uid, role, dept, codes] of [['MT', 'sales_manager', RETAIL, '201'], ['OT', 'sales_manager', RETAIL, '201']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run(uid, uid, role, dept, codes, 'x');
  }
  db.prepare("INSERT INTO approval_workflow_templates(entity_type,levels_json,updated_at) VALUES('sales_teams',?,'2026-10-22')")
    .run(JSON.stringify({ scopes: { MT: { scope: 'teams', teams: ['mt'] }, OT: { scope: 'self' } } }));
  for (const [code, name, corporate, slm] of [
    ['30-LE-0015', 'ท็อปส์ ฟู้ดส์ เซ็นเตอร์', 'ท็อปส์ ฟู้ดส์ เซ็นเตอร์', '105'],
    ['30-NW-0015', 'ซีพี แอ็กซ์ตร้า', 'Makro TGM', 'BP-0'],
    ['10-AA-0001', 'ร้านป้าแดง', '', '105'],
  ]) {
    db.prepare('INSERT INTO customers(code,name,slm_id,is_active) VALUES(?,?,?,1)').run(code, name, slm);
    db.prepare('INSERT INTO customer_profiles(code,name,corporate) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET corporate = excluded.corporate').run(code, name, corporate);
    db.prepare("INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES('TSS','2026-01',?,?,100,1)").run(code, slm);
  }
  cs.clearScopeCache();
  const mt = cs.resolveScope(db, { uid: 'MT' });
  assert.equal(mt.allMt, true);
  assert.ok(cs.canSeeCust(mt, '30-LE-0015'), 'ห้างที่เซลล์นอกทีมขาย');
  assert.ok(cs.canSeeCust(mt, '30-NW-0015'), 'Makro ของโรงงาน');
  assert.ok(!cs.canSeeCust(mt, '10-AA-0001'), 'ร้านค้าทั่วไปของเซลล์นอกทีม');
  const ot = cs.resolveScope(db, { uid: 'OT' });
  assert.ok(!ot.allMt);
  assert.ok(!cs.canSeeCust(ot, '30-LE-0015'));
  // ยอดขาย: ลูกค้าห้างของเซลส์นอกทีมไม่นับ ส่วนยอดโรงงาน (BP-*) และรหัสในทีมยังนับ (2026-11-06)
  db.prepare("INSERT INTO invoice_sales_monthly(company,ym,cust_code,slm_code,amount,invoice_count) VALUES('TSS','2026-01','30-LE-0015','201',50,1)").run();
  const f = cs.factSql(mt, { cust: 'cust_code', slm: 'slm_code' });
  const seen = db.prepare(`SELECT cust_code, slm_code FROM invoice_sales_monthly WHERE ${f.sql} ORDER BY cust_code`).all(...f.params).map(r => `${r.cust_code}|${r.slm_code}`);
  assert.deepEqual(seen, ['30-LE-0015|201', '30-NW-0015|BP-0']);
});
