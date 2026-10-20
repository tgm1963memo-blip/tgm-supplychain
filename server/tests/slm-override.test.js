const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../db/migrations');
const { loadSlmOverrides, effectiveSlm } = require('../lib/slmOverride');

// 2026-10-20 (ผู้ใช้สั่ง): Tops 30-LC-0013 ออกจากยอดคุณปู (106) → เป็นของ 207 · กำหนดรายลูกค้าใน sales_slm_override
test('slm override: seeded once, applied to sales attribution and v_invoice_heads, not to invoices', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const ov = loadSlmOverrides(db);
  assert.equal(ov.get('30-LC-0013'), '207');
  assert.equal(effectiveSlm(ov, ' 30-lc-0013 ', '106'), '207');
  assert.equal(effectiveSlm(ov, '30-TA-0001', '106'), '106');

  db.prepare("INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES ('AB1','2026-09-01','30-LC-0013','106',100,'3'),('AB2','2026-09-01','30-TA-0001','106',50,'3')").run();
  db.prepare("INSERT INTO invoice_heads(doc_num,doc_date,cust_code,slm_code,total,rectyp) VALUES ('AB0','2025-01-01','30-LC-0013','106',10,'3')").run();
  const v = Object.fromEntries(db.prepare('SELECT doc_num, slm_code FROM v_invoice_heads').all().map(r => [r.doc_num, r.slm_code]));
  assert.deepEqual(v, { AB1: '207', AB2: '106', AB0: '207' });
  assert.equal(db.prepare("SELECT slm_code FROM invoices WHERE doc_num = 'AB1'").get().slm_code, '106', 'tgm-wms เห็นรหัสในใบจริง');

  // แก้เป็นค่าอื่นแล้วเปิด server ใหม่ — ไม่ถูกตั้งกลับ
  db.prepare("UPDATE sales_slm_override SET slm_code = '211' WHERE cust_code = '30-LC-0013'").run();
  runMigrations(db);
  assert.equal(loadSlmOverrides(db).get('30-LC-0013'), '211');
});
