const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ใบสั่งซื้อ Express สำหรับหน้ารับของเข้า tss-wms (2026-11-04): อ่านได้ตามช่วงวันกำหนดรับ เขียนผ่าน API ไม่ได้
test('express_po_lines: filter by due date, read-only', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run('M', 'Mgr', 'sales_manager', 'x');
  const tok = createSession(db, 'M').token;
  const ins = db.prepare('INSERT INTO express_po_lines(id,company,po_no,seq,due_date,sku,ordered_qty) VALUES(?,?,?,?,?,?,?)');
  ins.run('TSS:PP1:1', 'TSS', 'PP1', '1', '2026-11-03', 'A', 10);
  ins.run('TSS:PP2:1', 'TSS', 'PP2', '1', '2026-11-04', 'A', 20);
  ins.run('TSS:PP3:1', 'TSS', 'PP3', '1', '2026-11-05', 'B', 30);
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/express_po_lines`;
  const headers = { Authorization: `Bearer ${tok}` };

  const rows = await (await fetch(`${base}?due_date=gte.2026-11-03&due_date=lte.2026-11-04`, { headers })).json();
  assert.deepEqual(rows.map(r => r.po_no), ['PP1', 'PP2']);

  const write = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"id":"x"}' });
  assert.ok(write.status >= 400, `write must be rejected, got ${write.status}`);
  assert.equal((await fetch(base)).status, 401);
});

// ใบรับสินค้า RH ที่ไม่มี PP (2026-11-05): เอาเฉพาะใบไม่อ้าง PP ไม่ยกเลิก อยู่ในช่วงวัน และสินค้าหมวด 001-006
test('buildReceiptDocLines: RH without PP becomes receivable lines', () => {
  const { buildReceiptDocLines } = require('../jobs/importFromExpress');
  const apHeaders = [
    { DOCNUM: 'RH1', DOCDAT: new Date('2026-11-05T00:00:00Z'), PONUM: '', SUPCOD: '30-TGM-001', DOCSTAT: 'N' },
    { DOCNUM: 'RH2', DOCDAT: new Date('2026-11-05T00:00:00Z'), PONUM: 'PP9', SUPCOD: '30-TGM-001', DOCSTAT: 'N' },
    { DOCNUM: 'RH3', DOCDAT: new Date('2026-11-05T00:00:00Z'), PONUM: '', SUPCOD: '30-TGM-001', DOCSTAT: 'C' },
    { DOCNUM: 'RH4', DOCDAT: new Date('2026-08-01T00:00:00Z'), PONUM: '', SUPCOD: '30-TGM-001', DOCSTAT: 'N' },
  ];
  const line = (doc, seq, sku, qty) => ({ DOCNUM: doc, SEQNUM: seq, STKCOD: sku, TRNQTY: qty, TQUCOD: 'U', LOCCOD: '01', STKDES: 'x' });
  const stcrd = [line('RH1', '1', 'A', 5), line('RH1', '2', 'SUPPLY', 3), line('RH2', '1', 'A', 1), line('RH3', '1', 'A', 1), line('RH4', '1', 'A', 1)];
  const products = { A: { group_name: '002 - x', unit: 'แพค' }, SUPPLY: { group_name: 'FIX', unit: 'ชิ้น' } };
  const rows = buildReceiptDocLines(apHeaders, stcrd, {
    cutoff: '2026-10-01',
    productOf: { get: (s) => products[s] },
    unitNames: new Map([['U', 'ลัง']]),
    supplierName: new Map([['30-TGM-001', 'TGM']]),
  });
  assert.equal(rows.length, 1);
  const [id, , po, seq, poDate, due, sup, supName, sku, , unit, , ordered, cancelled, remain, status] = rows[0];
  assert.deepEqual([id, po, seq, poDate, due, sup, supName, sku, unit, ordered, cancelled, remain, status],
    ['TSS:RH1:1', 'RH1', '1', '2026-11-05', '2026-11-05', '30-TGM-001', 'TGM', 'A', 'ลัง', 5, 0, 5, 'RH']);
});

// code review 2026-11-07: XTRNQTY (หน่วยฐาน) แทน TRNQTY และหักแถวยอดติดลบออกจากบรรทัดเดียวกัน
test('buildReceiptDocLines: uses converted qty and nets correction rows', () => {
  const { buildReceiptDocLines } = require('../jobs/importFromExpress');
  const apHeaders = [{ DOCNUM: 'RH5', DOCDAT: new Date('2026-11-05T00:00:00Z'), PONUM: '', SUPCOD: 'S', DOCSTAT: 'N' }];
  const l = (seq, sku, TRNQTY, XTRNQTY, TFACTOR = 1) => ({ DOCNUM: 'RH5', SEQNUM: seq, STKCOD: sku, TRNQTY, XTRNQTY, TFACTOR, TQUCOD: 'P', LOCCOD: '01', STKDES: 'x' });
  const stcrd = [l('1', 'A', 50, 100, 2), l('2', 'B', 10, 10), l('3', 'B', -4, -4), l('4', 'C', 3, 3), l('5', 'C', -3, -3)];
  const products = { A: { group_name: '002', unit: 'ชิ้น' }, B: { group_name: '002', unit: 'กก' }, C: { group_name: '002', unit: 'กก' } };
  const rows = buildReceiptDocLines(apHeaders, stcrd, {
    cutoff: '2026-10-01', productOf: { get: (s) => products[s] }, unitNames: new Map([['P', 'แพ็ค 2']]), supplierName: new Map(),
  });
  assert.deepEqual(rows.map((r) => [r[0], r[8], r[10], r[12]]), [['TSS:RH5:1', 'A', 'ชิ้น', 100], ['TSS:RH5:2', 'B', 'แพ็ค 2', 6]]);
});
