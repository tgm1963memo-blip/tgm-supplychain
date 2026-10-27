const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { evaluate, dayList, consiPair } = require('../lib/promoEval');

// ผลวิเคราะห์ใบเคาะราคา (2026-10-27, เฟส 2) — baseline ตัดวันโปรอื่น, ROI/จุดคุ้มทุน, เกณฑ์, snapshot ตอนส่งอนุมัติ
function seed() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  db.prepare(`INSERT INTO promo_draft_headers (draft_no, promo_name, start_date, due_date, status, other_costs_json, created_by)
    VALUES ('D1', 'โปรทดสอบ', '2026-11-01', '2026-11-14', 'draft', '[{"item":"ป้าย","amount":1000}]', 'S')`).run();
  const line = db.prepare(`INSERT INTO promo_drafts (draft_no, cust_code, sku, sku_name, unit_price, cost_price, cost_price_promo, estimated_qty)
    VALUES ('D1', ?, ?, ?, 0, ?, ?, ?)`);
  // P1: 2 สาขา ทุนสุทธิปกติ 100 โปร 90 คาดการณ์ 500 (ค่าเดียวกันทุกแถวสาขา) · P2: ไม่มีทุนสินค้า
  for (const cc of ['01-L2-0001', '01-L2-0002']) { line.run(cc, 'P1', 'ไส้กรอก', 100, 90, 500); line.run(cc, 'P2', 'แฮม', 50, 45, 100); }
  const tx = db.prepare('INSERT INTO sales_transactions (company, tx_date, sku, cust_code, qty) VALUES (?, ?, ?, ?, ?)');
  // baseline P1: ขาย TSS 10/วัน/สาขา ตลอด 56 วันก่อนโปร (6 ก.ย.–31 ต.ค.) ยกเว้นช่วงที่มีโปรอื่น 1–14 ต.ค. ขาย 50/วัน/สาขา
  for (const d of dayList('2026-09-06', '2026-10-31')) for (const cc of ['01-L2-0001', '01-L2-0002']) tx.run('TSS', d, 'P1', cc, d >= '2026-10-01' && d <= '2026-10-14' ? 50 : 10);
  // ช่วงโปรจริง: 20/วัน/สาขา
  for (const d of dayList('2026-11-01', '2026-11-14')) for (const cc of ['01-L2-0001', '01-L2-0002']) tx.run('TSS', d, 'P1', cc, 20);
  // P2: มียอดส่ง CONSI ที่สาขาคู่ BB-L2-0001 5/วัน → ใช้ยอด CONSI (ยอด TSS ไม่นับ)
  for (const d of dayList('2026-09-06', '2026-10-31')) { tx.run('CONSI', d, 'P2', 'BB-L2-0001', 5); tx.run('TSS', d, 'P2', '01-L2-0001', 99); }
  db.prepare("INSERT INTO promo_docs (company, sonum, seqnum, cust_code, sku, unit_price, start_date, due_date) VALUES ('TSS','SO1','1','01-L2-0001','P1',85,'2026-10-01','2026-10-14')").run();
  // ทุน P1 ต.ค. 70 เนื้อหมู 50% · หมู ต.ค. 80 (จริง) → พ.ย. 88 (คาดการณ์) ⇒ ทุนช่วงโปร 70 × (1 + 0.5 × 0.1) = 73.5
  db.prepare("INSERT INTO sku_costs (sku, month, cost, pork_pct) VALUES ('P1', '2026-10', 70, 0.5)").run();
  db.prepare("INSERT INTO pig_prices (month, kind, price_per_kg) VALUES ('2026-10','actual',80), ('2026-11','forecast',88)").run();
  return db;
}

test('helpers', () => {
  assert.equal(dayList('2026-10-30', '2026-11-02').length, 4);
  assert.equal(consiPair('01-L2-0001'), 'BB-L2-0001');
  assert.equal(consiPair('XYZ'), '');
});

test('evaluate: baseline excludes other-promo days, ROI / breakeven / criteria per SKU', () => {
  const db = seed();
  const r = evaluate(db, 'D1', { today: '2026-12-01' });
  assert.equal(r.period.days, 14);
  assert.equal(r.period.status, 'ended');
  const p1 = r.skus.find(s => s.sku === 'P1');
  assert.equal(p1.source, 'sales');
  assert.equal(p1.baseline.clean_days, 42);          // 56 − 14 วันที่มีโปรอื่น
  assert.equal(p1.baseline.avg_daily, 20);           // 2 สาขา × 10 (ไม่ปนยอดช่วงโปร 50)
  assert.equal(p1.qty.baseline, 280);                // 20 × 14 วัน
  assert.equal(p1.qty.forecast, 500);                // ต่อ SKU ทั้งเอกสาร ไม่คูณจำนวนสาขา
  assert.equal(p1.qty.actual, 560);
  assert.equal(p1.unit.c_f, 73.5);
  // m_n = 26.5, m_p = 16.5, ส่วนลด 10 · K กระจายตามมูลค่า F × p_p (P2 ไม่มีทุนแต่มี F, p_p): P1 = 1000 × 45000 / 49500
  const K1 = 1000 * 45000 / 49500;
  assert.equal(p1.other_cost, Math.round(K1 * 100) / 100);
  const I = 10 * 500 + K1, dGP = 16.5 * 500 - 26.5 * 280 - K1;
  assert.equal(p1.pre.investment, Math.round(I * 100) / 100);
  assert.equal(p1.pre.roi, Math.round(dGP / I * 10000) / 10000);
  assert.equal(p1.breakeven_qty, Math.round((26.5 * 280 + K1) / 16.5 * 10) / 10);
  const st = Object.fromEntries(p1.criteria.map(c => [c.key, c.status]));
  assert.deepEqual(st, { G1: 'ok', G2: 'warn', G3: 'fail', G4: 'na', G5: 'na', G6: 'ok' });
  assert.equal(p1.suggestion, 'loss');               // forecast ไม่ถึงจุดคุ้มทุน
  assert.ok(p1.post.roi > 0);                         // ยอดจริง 560 เกินจุดคุ้มทุน

  const p2 = r.skus.find(s => s.sku === 'P2');
  assert.equal(p2.source, 'consi');
  assert.equal(p2.qty.baseline, 70);                 // 5 × 14 ไม่ใช่ยอด TSS 99
  assert.equal(p2.criteria.find(c => c.key === 'G1').status, 'na');
  assert.equal(p2.suggestion, null);                 // ไม่มีทุน = ไม่แนะนำ
  assert.equal(p2.pre, null);
  assert.equal(r.totals.pre, null);                   // มี SKU ที่คำนวณไม่ได้ = ไม่รวมยอดเอกสาร
  assert.equal(r.totals.status, 'fail');
});

test('evaluate: not started / running / insufficient baseline / compensate', () => {
  const db = seed();
  assert.equal(evaluate(db, 'D1', { today: '2026-10-27' }).skus[0].qty.actual, null);
  const run = evaluate(db, 'D1', { today: '2026-11-06' }).skus.find(s => s.sku === 'P1');
  assert.equal(run.qty.actual_days, 5);              // 1–5 พ.ย. (วันนี้ยังไม่นับ)
  assert.equal(run.qty.actual, 200);
  assert.equal(run.qty.baseline_elapsed, 100);
  db.prepare("INSERT INTO promo_eval_settings (key, value_json) VALUES ('baseline_min_clean_days', '50')").run();
  const thin = evaluate(db, 'D1', { today: '2026-12-01' }).skus.find(s => s.sku === 'P1');
  assert.equal(thin.qty.baseline, null);
  assert.equal(thin.criteria.find(c => c.key === 'G3').status, 'na');
  // ใบ Compensate: ไม่มีทุนสุทธิโปร → p_p = p_n − compensate ÷ 1.07
  db.prepare("UPDATE promo_drafts SET cost_price_promo = NULL, compensate = 10.7 WHERE sku = 'P1'").run();
  const comp = evaluate(db, 'D1', { today: '2026-12-01' }).skus.find(s => s.sku === 'P1');
  assert.equal(comp.unit.p_p, 90);
  assert.ok(comp.flags.includes('p_p_from_compensate'));
});

test('promo_eval route: admin only + snapshot when submitted', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = seed();
  const tokens = {};
  for (const [uid, role] of [['A', 'admin'], ['S', 'sales'], ['M', 'sales_manager']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare('INSERT INTO approval_workflow_templates(entity_type,levels_json) VALUES(?,?)').run('promo_draft', JSON.stringify([
    { id: 'l1', label: 'ผู้จัดการ', mode: 'any', approvers: [{ uid: 'M', name: 'User M' }] },
  ]));
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'A') => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await call('/promo_eval/D1', 'GET', null, 'S')).status, 403);
  assert.equal((await call('/promo_eval/D1', 'GET', null, 'M')).status, 403);
  assert.equal((await call('/promo_eval/NOPE')).status, 404);
  const before = (await call('/promo_eval/D1')).data;
  assert.equal(before.snapshot, null);
  assert.equal(before.live.skus.length, 2);

  const sent = await call('/promo_draft_headers?draft_no=eq.D1', 'PATCH', { status: 'pending_approval' }, 'S');
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const snap = (await call('/promo_eval/D1')).data.snapshot;
  assert.ok(snap?.payload);
  assert.equal(snap.payload.skus.find(s => s.sku === 'P1').unit.c_f, 73.5);
  // ทุนเปลี่ยนทีหลัง → live เปลี่ยน แต่ snapshot คงเดิม
  db.prepare("UPDATE sku_costs SET cost = 80 WHERE sku = 'P1'").run();
  const after = (await call('/promo_eval/D1')).data;
  assert.equal(after.live.skus.find(s => s.sku === 'P1').unit.c_now, 80);
  assert.equal(after.snapshot.payload.skus.find(s => s.sku === 'P1').unit.c_now, 70);
  // อนุมัติขั้นถัดไป ไม่เขียน snapshot ซ้ำ
  await call('/promo_draft_headers?draft_no=eq.D1', 'PATCH', { status: 'pending_approval' }, 'M');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM promo_eval_snapshots WHERE draft_no = 'D1'").get().n, 1);
});
