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
