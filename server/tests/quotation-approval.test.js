const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// ใบเสนอราคา รอบ 3 (2026-10-09): ขออนุมัติราคาต่ำกว่าสิทธิ์ → อนุมัติ = ออกเอกสาร + ราคาพิเศษประจำลูกค้า
async function setup(t) {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD; delete process.env.SMTP_PASS;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of [['S', 'sales_officer'], ['S2', 'sales_officer'], ['M', 'sales_manager'], ['M2', 'sales_manager']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  // ลูกค้า C1 ต้องมีใน master และอยู่ในสิทธิ์ผู้สร้าง (2026-10-12, security review — ราคาพิเศษผูกกับรหัส)
  db.prepare("UPDATE sc_users SET slm_codes = '101' WHERE uid IN ('S', 'S2')").run();
  db.prepare("INSERT INTO customers(code,name,slm_id,is_active) VALUES('C1','ลูกค้า 1','101',1),('C9','ลูกค้าคนอื่น','999',1)").run();
  db.prepare(`INSERT INTO price_tiers (code, name_th, unit, price_a, price_b, price_c, price_d, price_e, price_f, price_g)
    VALUES ('P1', 'สินค้า 1', 'กก.', 100, 110, 120, 130, 140, 150, 160)`).run();
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { await new Promise((r) => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/quotation_headers`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  const doc = (price, tier = 'E') => ({ customer_code: 'C1', customer_name: 'ลูกค้า 1', price_tier: tier, lines: [{ product_code: 'P1', quoted_price: price }] });
  return { db, call, doc };
}

test('below-tier price: cannot self-issue, submit → approve issues it and saves a customer special price', async (t) => {
  const { db, call, doc } = await setup(t);
  const q = (await call('', 'POST', doc(125))).data; // ต่ำกว่าฐาน E (140)
  assert.equal(q.lines[0].needs_approval, 1);
  assert.equal((await call(`/${q.id}/issue`, 'POST', {})).status, 400);
  assert.equal((await call(`/${q.id}/submit`, 'POST', { approver_uid: 'S' })).status, 400, 'ผู้สร้างเป็นผู้อนุมัติเองไม่ได้');
  assert.equal((await call(`/${q.id}/submit`, 'POST', { approver_uid: 'M' }, 'S2')).status, 403, 'คนอื่นส่งแทนไม่ได้');
  const sub = await call(`/${q.id}/submit`, 'POST', { approver_uid: 'M' });
  assert.equal(sub.data.status, 'pending_approval');
  assert.equal((await call(`/${q.id}`, 'PUT', doc(120))).status, 400, 'รออนุมัติแก้ไม่ได้');
  assert.equal((await call(`/${q.id}/approve`, 'POST', {}, 'M2')).status, 403, 'อนุมัติได้เฉพาะผู้อนุมัติที่เลือก');
  const ok = await call(`/${q.id}/approve`, 'POST', {}, 'M');
  assert.equal(ok.data.status, 'issued');
  const sp = db.prepare("SELECT price, cust_key FROM customer_special_prices WHERE product_code = 'P1'").get();
  assert.deepEqual({ ...sp }, { price: 125, cust_key: 'C:C1' });

  // ใบใหม่ลูกค้าเดิม: ราคาตั้งต้น = ราคาพิเศษ และออกเองได้โดยไม่ต้องขออนุมัติซ้ำ
  const q2 = (await call('', 'POST', { ...doc(null), lines: [{ product_code: 'P1' }] })).data;
  assert.equal(q2.lines[0].quoted_price, 125);
  assert.equal(q2.lines[0].needs_approval, 0);
  assert.equal((await call(`/${q2.id}/issue`, 'POST', {})).data.status, 'issued');
  // ต่ำกว่าราคาพิเศษ → ต้องขออีกครั้ง
  assert.equal((await call('', 'POST', doc(120))).data.lines[0].needs_approval, 1);
});

test('reject needs a reason, owner can edit and resubmit; recall returns to draft', async (t) => {
  const { call, doc } = await setup(t);
  const q = (await call('', 'POST', doc(125))).data;
  await call(`/${q.id}/submit`, 'POST', { approver_uid: 'M' });
  assert.equal((await call(`/${q.id}/reject`, 'POST', {}, 'M')).status, 400);
  const rj = await call(`/${q.id}/reject`, 'POST', { reason: 'ต่ำเกินไป' }, 'M');
  assert.equal(rj.data.status, 'rejected');
  const ed = await call(`/${q.id}`, 'PUT', doc(135));
  assert.equal(ed.data.status, 'draft');
  await call(`/${q.id}/submit`, 'POST', { approver_uid: 'M' });
  assert.equal((await call(`/${q.id}/recall`, 'POST', {}, 'S2')).status, 403);
  assert.equal((await call(`/${q.id}/recall`, 'POST', {})).data.status, 'draft');
  // อยู่ในสิทธิ์ทั้งหมด → ส่งขออนุมัติไม่ได้ ให้ออกเองได้เลย
  const q3 = (await call('', 'POST', doc(150))).data;
  assert.equal((await call(`/${q3.id}/submit`, 'POST', { approver_uid: 'M' })).status, 400);
});

// security review 2026-10-12: รหัสลูกค้าต้องมีจริง/อยู่ในสิทธิ์ และชื่อต้องเป็นลูกค้ารายเดียวกับรหัส
test('quotation customer code must exist, be in scope, and match the name', async t => {
  const { call } = await setup(t);
  const body = (code, name) => ({ customer_code: code, customer_name: name, price_tier: 'E', lines: [{ product_code: 'P1', quoted_price: 140 }] });
  assert.equal((await call('', 'POST', body('ZZ-NOPE', 'ใครก็ได้'))).status, 400);
  assert.equal((await call('', 'POST', body('C9', 'ลูกค้าคนอื่น'))).status, 403);
  const ok = await call('', 'POST', body('C1', 'บริษัทอื่นที่ไม่เกี่ยว'));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.customer_name, 'ลูกค้า 1');
  // ราคาพิเศษของลูกค้านอกสิทธิ์ = ว่าง
  assert.deepEqual((await call('/special-prices?customer_code=C9')).data, []);
});
