const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');

// พัฒนาสินค้าใหม่ (NPD) 2026-11-25 — flow 13 ขั้นคุมที่ server (routes/npdProjects.js)
const USERS = [['S', 'sales_officer'], ['S2', 'sales_officer'], ['H', 'sales_manager'], ['LIN', 'planning_officer'], ['O', 'manager'],
  ['RD', 'planning_officer'], ['CA', 'planning_officer'], ['FA', 'planning_officer'], ['AD', 'admin']];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup(t) {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD; delete process.env.SMTP_PASS;
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role] of USERS) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO customers(code,name,slm_id,is_active) VALUES('C1','ลูกค้า 1','101',1)").run();
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { await new Promise((r) => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/npd_projects`;
  const call = async (route, method = 'GET', body, uid = 'S') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  const act = (id, action, body = {}, uid) => call(`/${id}/act/${action}`, 'POST', body, uid);
  const attach = async (id, kind, uid) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('file', new Blob([PNG], { type: 'image/png' }), 'scan.png');
    const r = await fetch(`${base}/${id}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[uid]}` }, body: fd });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await call('/settings', 'PUT', { lin: ['LIN'], o: ['O'], rd: ['RD'], cost_acct: ['CA'], factory_acct: ['FA'] }, 'AD')).status, 200);
  return { db, call, act, attach };
}

const item = (over = {}) => ({ name: 'ไส้กรอกใหม่', qty: '2', unit: 'กก.', targetPrice: '180', forecastKg: '500', brand: 'TGM', pack1G: '500', pack1Qty: '1',
  pack1Type: 'nylon', outer: 'box', outerQty: '10', boxType: 'logo', casing: 'hog', sliceMm: '0', pcsPerKg: '20', diameterMm: '22', weightG: '50',
  lengthVal: '12', lengthUnit: 'cm', storage: 'chill', storageDays: '30', coaPhys: 'lot', coaChem: 'lot', coaMicro: 'lot', coaYear: 'none',
  draftSpec: 'yes', detail: 'รสพริก', ...over });
const req = (over = {}) => ({ cust_code: 'C1', header: { contact: 'คุณเอ', phone: '0800000000', purpose: 'ทดสอบสูตร', deliveryDate: '2026-12-10', custGroup: 'ร้านอาหาร' }, items: [item()], ...over });

async function toO(ctx) {
  const { call, act, attach } = ctx;
  const p = (await call('', 'POST', req())).data;
  assert.equal((await act(p.id, 'submit', { head_uid: 'H' })).data.status, 'pending_head');
  assert.equal((await act(p.id, 'head_approve', {}, 'H')).data.status, 'pending_paper');
  assert.equal((await attach(p.id, 'scan_paper', 'LIN')).status, 200);
  assert.equal((await act(p.id, 'paper_pass', {}, 'LIN')).data.status, 'pending_o');
  return p;
}

test('full happy path: 13 steps end at launched, only the assigned person can act', async (t) => {
  const ctx = await setup(t);
  const { call, act, attach } = ctx;
  const p = await toO(ctx);
  assert.match((await call(`/${p.id}`)).data.doc_no, /^NP\d{4}-\d{2}-001$/);
  assert.equal((await act(p.id, 'o_approve', {}, 'RD')).status, 403, 'RD อนุมัติแทนคุณโอไม่ได้');
  assert.equal((await act(p.id, 'o_approve', {}, 'O')).data.status, 'rd_queue');
  assert.equal((await act(p.id, 'rd_accept', {}, 'RD')).data.status, 'rd_dev');
  assert.equal((await act(p.id, 'rd_send', { note: 'ส่งพร้อม COA' }, 'RD')).data.status, 'sample_sent');
  assert.equal((await act(p.id, 'sales_receive', {}, 'S2')).status, 403);
  assert.equal((await act(p.id, 'sales_receive')).data.status, 'sample_received');
  assert.equal((await act(p.id, 'to_customer', { date: '2026-12-12' })).data.status, 'at_customer');
  assert.equal((await act(p.id, 'feedback', { decision: 'pass', result: 'pass' })).data.status, 'first_lot');
  assert.equal((await act(p.id, 'first_lot', { kg: 30, forecast: [{ month: '2027-01', kg: 300 }] })).status, 400, 'lot แรกต่ำกว่า 40 กก.');
  assert.equal((await act(p.id, 'first_lot', { kg: 100, forecast: [{ month: '2027-01', kg: 300 }] })).data.status, 'spec_cost');
  // ⑪ คู่ขนาน: บัญชีบันทึกก่อน RD ส่งทุนไม่ได้ · spec ต้องแนบไฟล์
  assert.equal((await act(p.id, 'acct_cost', { amount: 120 }, 'CA')).status, 400);
  assert.equal((await act(p.id, 'rd_spec', {}, 'RD')).status, 400);
  await attach(p.id, 'rd_spec', 'RD');
  assert.equal((await act(p.id, 'rd_spec', {}, 'RD')).data.status, 'spec_cost');
  assert.equal((await act(p.id, 'rd_cost', { amount: 110 }, 'RD')).data.status, 'spec_cost');
  const afterCost = await act(p.id, 'acct_cost', { amount: 118.5 }, 'CA');
  assert.equal(afterCost.data.status, 'price_quote');
  assert.equal(afterCost.data.cost.acct.amount, 118.5);
  // Sales ไม่เห็นข้อมูลทุน
  const salesView = (await call(`/${p.id}`)).data;
  assert.equal(salesView.cost, undefined);
  assert.equal((await act(p.id, 'price_propose', { price: 175 })).data.status, 'price_review');
  assert.equal((await act(p.id, 'price_decide', { decision: 'approve' }, 'O')).data.status, 'sku_setup');
  assert.equal((await act(p.id, 'sku_open', {}, 'FA')).status, 400);
  const done = (await act(p.id, 'sku_open', { sku_code: 'NEW001', sku_name: 'ไส้กรอกใหม่' }, 'FA')).data;
  assert.equal(done.status, 'launched');
  assert.equal(done.sku_code, 'NEW001');
  assert.equal((await act(p.id, 'cancel', { reason: 'x' })).status, 400, 'ปิดแล้วยกเลิกไม่ได้');
});

test('return at any approval step needs a reason and resubmit restarts at the head', async (t) => {
  const ctx = await setup(t);
  const { call, act, attach } = ctx;
  const p = (await call('', 'POST', req({ items: [item({ brand: '' })] }))).data;
  assert.equal((await act(p.id, 'submit', { head_uid: 'H' })).status, 400, 'ฟอร์มไม่ครบส่งไม่ได้');
  await call(`/${p.id}`, 'PUT', req());
  assert.equal((await act(p.id, 'submit', { head_uid: 'S' })).status, 400, 'หัวหน้าต้องเป็น role หัวหน้า');
  await act(p.id, 'submit', { head_uid: 'H' });
  await act(p.id, 'head_approve', {}, 'H');
  assert.equal((await act(p.id, 'paper_pass', {}, 'LIN')).status, 400, 'ต้องแนบสแกนก่อน');
  assert.equal((await act(p.id, 'paper_return', {}, 'LIN')).status, 400, 'ต้องมีเหตุผล');
  const ret = (await act(p.id, 'paper_return', { reason: 'คุณอ้อยให้แก้ราคา' }, 'LIN')).data;
  assert.equal(ret.status, 'returned');
  assert.equal(ret.returned_from, 'pending_paper');
  assert.equal((await call(`/${p.id}`, 'PUT', req({ items: [item({ targetPrice: '190' })] }))).status, 200);
  assert.equal((await act(p.id, 'submit', {})).data.status, 'pending_head', 'ส่งใหม่เริ่มที่หัวหน้า');
  await act(p.id, 'head_approve', {}, 'H');
  await attach(p.id, 'scan_paper', 'LIN');
  await act(p.id, 'paper_pass', {}, 'LIN');
  assert.equal((await act(p.id, 'o_return', { reason: 'ยังไม่ใช่ตอนนี้' }, 'O')).data.status, 'returned');
  assert.equal((await call(`/${p.id}`)).data.doc_no.endsWith('-001'), true, 'ส่งใหม่ใช้เลขเดิม');
});

test('feedback fail opens a linked new round; price review can loop back 4 ways', async (t) => {
  const ctx = await setup(t);
  const { call, act, attach } = ctx;
  const p = await toO(ctx);
  await act(p.id, 'o_approve', {}, 'O');
  await act(p.id, 'rd_accept', {}, 'RD');
  await act(p.id, 'rd_send', {}, 'RD');
  await act(p.id, 'sales_receive');
  await act(p.id, 'to_customer', {});
  assert.equal((await act(p.id, 'feedback', { decision: 'revise' })).status, 400, 'ไม่ผ่านต้องมีความเห็น');
  const rv = (await act(p.id, 'feedback', { decision: 'revise', feedback: 'เค็มไป' })).data;
  assert.equal(rv.status, 'revised');
  const r2 = (await call(`/${rv.new_id}`)).data;
  assert.equal(r2.status, 'draft');
  assert.equal(r2.round, 2);
  assert.equal(r2.root_id, p.id);
  assert.equal(r2.chain.length, 2);
  assert.equal(r2.items[0].name, 'ไส้กรอกใหม่');

  // รอบ 2 เดินถึงพิจารณาราคา แล้วลองทางไม่ผ่าน
  await act(r2.id, 'submit', { head_uid: 'H' });
  await act(r2.id, 'head_approve', {}, 'H');
  await attach(r2.id, 'scan_paper', 'LIN');
  await act(r2.id, 'paper_pass', {}, 'LIN');
  assert.notEqual((await call(`/${r2.id}`)).data.doc_no, (await call(`/${p.id}`)).data.doc_no, 'รอบใหม่ได้เลขใหม่');
  for (const a of ['o_approve:O', 'rd_accept:RD', 'rd_send:RD', 'sales_receive:S', 'to_customer:S']) { const [x, u] = a.split(':'); await act(r2.id, x, {}, u); }
  await act(r2.id, 'feedback', { decision: 'pass' });
  await act(r2.id, 'first_lot', { kg: 50, forecast: [{ month: '2027-02', kg: 200 }] });
  await attach(r2.id, 'rd_spec', 'RD');
  await act(r2.id, 'rd_spec', {}, 'RD');
  await act(r2.id, 'rd_cost', { amount: 100 }, 'RD');
  await act(r2.id, 'acct_cost', { amount: 105 }, 'CA');
  await act(r2.id, 'price_propose', { price: 150 });
  assert.equal((await act(r2.id, 'price_decide', { decision: 'renegotiate' }, 'O')).status, 400, 'ไม่ผ่านต้องมีเหตุผล');
  assert.equal((await act(r2.id, 'price_decide', { decision: 'renegotiate', reason: 'ต่ำไป' }, 'O')).data.status, 'price_quote');
  await act(r2.id, 'price_propose', { price: 160 });
  const rs = (await act(r2.id, 'price_decide', { decision: 'respec', reason: 'ลดทุน' }, 'O')).data;
  assert.equal(rs.status, 'spec_cost');
  assert.deepEqual(rs.flags, {}, 'ต้องทำ spec/ทุนใหม่ทั้งชุด');
  await attach(r2.id, 'rd_spec', 'RD');
  await act(r2.id, 'rd_spec', {}, 'RD');
  await act(r2.id, 'rd_cost', { amount: 95 }, 'RD');
  await act(r2.id, 'acct_cost', { amount: 98 }, 'CA');
  await act(r2.id, 'price_propose', { price: 160 });
  const nr = (await act(r2.id, 'price_decide', { decision: 'new_round', reason: 'เปลี่ยนไส้' }, 'O')).data;
  assert.equal(nr.status, 'revised');
  assert.equal((await call(`/${nr.new_id}`)).data.round, 3);
  assert.equal((await act(nr.new_id, 'cancel', { reason: 'ลูกค้าเลิก' })).data.status, 'cancelled');
});

test('visibility: other sales cannot see, admin can act on behalf (logged)', async (t) => {
  const ctx = await setup(t);
  const { call, act } = ctx;
  const p = (await call('', 'POST', req())).data;
  assert.equal((await call(`/${p.id}`, 'GET', null, 'S2')).status, 403);
  assert.equal((await call('', 'GET', null, 'S2')).data.length, 0);
  assert.equal((await call('', 'GET', null, 'LIN')).data.length, 1, 'ผู้รับผิดชอบขั้นเห็นทั้งหมด');
  await act(p.id, 'submit', { head_uid: 'H' });
  const list = (await call('', 'GET', null, 'H')).data;
  assert.equal(list[0].awaiting_me, true);
  const ad = (await act(p.id, 'head_approve', {}, 'AD')).data;
  assert.equal(ad.status, 'pending_paper');
  assert.match(ad.logs.at(-1).detail, /แอดมินทำแทน/);
  assert.equal((await call(`/${p.id}`, 'DELETE')).status, 400, 'ส่งแล้วลบไม่ได้');
});
