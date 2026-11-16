const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const { parseUnit, normUnit, canSeeCost, costContext, resolveCost, lineCost } = require('../lib/skuCost');
const { parseMoney } = require('../routes/costRounds');

// ทุน 3 ช่องจากไฟล์ Master SKU + สิทธิ์เห็นทุนรายคน + ทุนจากการแปลงรหัส (2026-11-16)
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  return db;
}

test('parseUnit reads the Master SKU unit column: per-kg, pack×grams, bare units', () => {
  assert.deepEqual(parseUnit('กิโลกรัม'), { unit: 'กก.', grams: 1000, raw: 'กิโลกรัม' });
  assert.deepEqual(parseUnit('KG.'), { unit: 'กก.', grams: 1000, raw: 'KG.' });
  assert.deepEqual(parseUnit('แพ็คx500'), { unit: 'แพ็ค', grams: 500, raw: 'แพ็คx500' });
  assert.deepEqual(parseUnit('Packx500'), { unit: 'แพ็ค', grams: 500, raw: 'Packx500' });
  assert.deepEqual(parseUnit('Boxx8000'), { unit: 'กล่อง', grams: 8000, raw: 'Boxx8000' });
  assert.deepEqual(parseUnit('กล่องx8,000'), { unit: 'กล่อง', grams: 8000, raw: 'กล่องx8,000' });
  assert.deepEqual(parseUnit('ชิ้น'), { unit: 'ชิ้น', grams: null, raw: 'ชิ้น' });
  assert.deepEqual(parseUnit('กล่องx200กรัม'), { unit: 'กล่อง', grams: 200, raw: 'กล่องx200กรัม' });
  // ตัวเลขหลัง x ที่เป็นจำนวนชิ้น ไม่ใช่กรัม → ไม่รู้น้ำหนัก
  assert.deepEqual(parseUnit('แพ็คx5ชิ้น'), { unit: 'แพ็ค', grams: null, raw: 'แพ็คx5ชิ้น' });
  assert.deepEqual(parseUnit(0), { unit: null, grams: null, raw: null });
  // หน่วยขายจาก Express (รหัสย่อ) และ Bplus (ชื่อเต็ม) ต้องลงคำเดียวกับหน่วยของทุน
  assert.equal(normUnit('แพ'), 'แพ็ค');
  assert.equal(normUnit('แพค'), 'แพ็ค');
  assert.equal(normUnit('กก'), 'กก.');
});

test('parseMoney separates cost, zero, status text and Excel errors', () => {
  assert.equal(parseMoney(104.0612345).value, 104.0612);
  assert.equal(parseMoney('1,154.08').value, 1154.08);
  assert.ok(parseMoney(0).zero);
  assert.ok(parseMoney('').empty);
  assert.ok(parseMoney(null).empty);
  assert.ok(parseMoney('สินค้าไม่เคลื่อนไหว').text);
  assert.ok(parseMoney('#N/A').error);
  assert.ok(parseMoney('#VALUE!').error);
  assert.ok(parseMoney(-5).invalid);
});

test('canSeeCost: superadmin always, everyone else only when ticked', () => {
  assert.equal(canSeeCost({ role: 'superadmin', can_see_cost: 0 }), true);
  assert.equal(canSeeCost({ role: 'admin', can_see_cost: 0 }), false);
  assert.equal(canSeeCost({ role: 'sales_manager', can_see_cost: 1 }), true);
  assert.equal(canSeeCost(null), false);
});

test('resolveCost: cost in effect on the sale date, retroactive first round, three bases', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO sku_cost_rounds (sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams, suspect) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('P1', '2026-11-02', 90, 94, 104, 'กก.', 1000, 0);
  ins.run('P1', '2026-11-09', 92, 96, 108, 'กก.', 1000, 0);
  ins.run('P2', '2026-11-02', null, null, 53.1, 'แพ็ค', 500, 1);
  const ctx = costContext(db);

  assert.equal(resolveCost(ctx, 'P1', '2026-11-05').cost, 104);
  assert.equal(resolveCost(ctx, 'P1', '2026-11-09').cost, 108);
  assert.equal(resolveCost(ctx, 'P1', '2026-11-30', 'base').cost, 92);
  assert.equal(resolveCost(ctx, 'P1', '2026-11-05', 'depr').cost, 94);
  // ก่อนทุนรอบแรก = ใช้รอบแรกย้อนหลัง และบอกว่าเป็นค่าประมาณ
  const before = resolveCost(ctx, 'P1', '2026-03-15');
  assert.deepEqual([before.cost, before.estimated, before.source], [104, true, 'own']);
  assert.equal(resolveCost(ctx, 'P1', '2026-11-05').estimated, false);
  // ช่อง F/G ว่าง → ใช้ทุนรวม · ธง suspect ตามมา
  const p2 = resolveCost(ctx, 'P2', '2026-11-05', 'base');
  assert.deepEqual([p2.cost, p2.suspect, p2.unit, p2.grams], [53.1, true, 'แพ็ค', 500]);
  assert.equal(resolveCost(ctx, 'NOPE', '2026-11-05'), null);
  assert.throws(() => resolveCost(ctx, 'P1', '2026-11-05', 'bogus'));
  db.close();
});

test('resolveCost: SKU without its own cost takes the source cost from the FF conversion document', () => {
  const db = freshDb();
  db.prepare("INSERT INTO products(code,name,unit) VALUES('SRC','ต้นทาง กก.','กิโลกรัม'),('SRC2','ต้นทางแพ็ค','แพค'),('OUT','ผลลัพธ์','แพค'),('OUT2','หลายต้นทาง','กิโลกรัม'),('OUT3','หน่วยเทียบไม่ได้','แพค'),('MULTI','ผลลัพธ์ร่วม','แพค')").run();
  const cost = db.prepare('INSERT INTO sku_cost_rounds (sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams) VALUES (?,?,?,?,?,?,?)');
  cost.run('SRC', '2026-11-02', 90, 94, 100, 'กก.', 1000);
  cost.run('SRC2', '2026-11-02', 40, 45, 50, 'แพ็ค', 500);
  cost.run('PIECE', '2026-11-02', 5, 5, 5, 'ชิ้น', null); // ทุนต่อชิ้น แต่ products ไม่รู้จักรหัสนี้ → เทียบหน่วยไม่ได้
  const ff = db.prepare('INSERT INTO conversion_doc_lines (doc_num, seq_num, doc_date, sku, direction, qty) VALUES (?,?,?,?,?,?)');
  // FF1: SRC 10 กก. → OUT 20 แพ็ค  ⇒ 10 × 100 ÷ 20 = 50 ต่อแพ็ค
  ff.run('FF1', '1', '2026-10-01', 'SRC', 'out', 10); ff.run('FF1', '2', '2026-10-01', 'OUT', 'in', 20);
  // FF2: SRC 6 กก. + SRC2 4 แพ็ค → OUT2 8 กก. ⇒ (600 + 200) ÷ 8 = 100
  ff.run('FF2', '1', '2026-10-05', 'SRC', 'out', 6); ff.run('FF2', '2', '2026-10-05', 'SRC2', 'out', 4); ff.run('FF2', '3', '2026-10-05', 'OUT2', 'in', 8);
  // FF3: ต้นทางเทียบหน่วยไม่ได้ → ไม่เดา
  ff.run('FF3', '1', '2026-10-06', 'PIECE', 'out', 3); ff.run('FF3', '2', '2026-10-06', 'OUT3', 'in', 3);
  // FF4: ผลลัพธ์สองรหัส → แบ่งทุนไม่ได้
  ff.run('FF4', '1', '2026-10-07', 'SRC', 'out', 10); ff.run('FF4', '2', '2026-10-07', 'MULTI', 'in', 5); ff.run('FF4', '3', '2026-10-07', 'OUT3', 'in', 5);
  const ctx = costContext(db);

  const out = resolveCost(ctx, 'OUT', '2026-11-05');
  assert.deepEqual([out.cost, out.source, out.from, out.doc, out.unit], [50, 'converted', ['SRC'], 'FF1', 'แพ็ค']);
  assert.equal(resolveCost(ctx, 'OUT', '2026-11-05', 'base').cost, 45); // ฐานทุนตามต้นทาง: 10 × 90 ÷ 20
  assert.equal(out.estimated, false);
  const out2 = resolveCost(ctx, 'OUT2', '2026-11-05');
  assert.deepEqual([out2.cost, out2.from], [100, ['SRC', 'SRC2']]);
  assert.equal(resolveCost(ctx, 'OUT3', '2026-11-05'), null);
  assert.equal(resolveCost(ctx, 'MULTI', '2026-11-05'), null);

  // มีทุนของตัวเองเมื่อไร ใช้ทุนจริง ไม่ใช้ทุนจากการแปลง
  cost.run('OUT', '2026-11-09', 60, 62, 66, 'แพ็ค', 500);
  const ctx2 = costContext(db);
  assert.notEqual(ctx2, ctx);
  assert.deepEqual([resolveCost(ctx2, 'OUT', '2026-11-10').cost, resolveCost(ctx2, 'OUT', '2026-11-10').source], [66, 'own']);
  db.close();
});

test('resolveCost: 1แถม1 / แพ็คคู่ without own cost = single pack of the same weight × 2, flagged promo2x', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO products(code,name,unit) VALUES
    ('20284-107','ไส้กรอกอาราบิกิ 100 กรัม แช่แข็ง','แพค'),('20284-11','ไส้กรอกอาราบิกิ 300 กรัม','แพค'),('20284-A','ไส้กรอกอาราบิกิ 100กรัม (1แถม1)','แพค'),
    ('10270-1','แฮมหมูผสมไก่ 1000 ก. TSS','กิโลกรัม'),('10270-B','แฮมหมูผสมไก่300กรัม (1แถม1)','แพค'),
    ('10140','คอทเทจเบค่อน(แผ่น)','กิโลกรัม'),('10140-B1','สโมคเบคอนเพลส130ก. 1แถม1','แพค'),('10140-A1','คอทเทจเบค่อน 1แถม1 TGM','แพค'),
    ('20258-232','ไส้กรอกจัมโบ้ชีส150ก.x2 แพ็คคู่','กล่อง')`).run();
  const cost = db.prepare('INSERT INTO sku_cost_rounds (sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams) VALUES (?,?,?,?,?,?,?)');
  cost.run('20284-107', '2026-11-02', 15, 16, 18.24, 'แพ็ค', 100);
  cost.run('20284-11', '2026-11-02', 40, 41, 42.4, 'แพ็ค', 300);
  cost.run('10270-1', '2026-11-02', 100, 105, 110, 'กก.', 1000);
  cost.run('10140', '2026-11-02', 140, 142, 145.8, 'กก.', 1000);
  cost.run('20258', '2026-11-02', 100, 100, 100, 'กก.', 1000);
  const ctx = costContext(db);
  const a = resolveCost(ctx, '20284-A', '2026-11-05');
  assert.deepEqual([a.cost, a.source, a.from, a.unit], [36.48, 'promo2x', ['20284-107'], 'แพ็ค']);
  assert.equal(resolveCost(ctx, '20284-A', '2026-11-05', 'base').cost, 30);
  const b = resolveCost(ctx, '10270-B', '2026-11-05'); // ไม่มีแพ็ค 300 ก. → ทุนต่อกก. ของชื่อเดียวกัน × 0.3 × 2
  assert.deepEqual([b.cost, b.from], [66, ['10270-1']]);
  assert.equal(resolveCost(ctx, '10140-B1', '2026-11-05'), null, 'ชื่อไม่ตรงกับทุนต่อกก. ของรหัสขึ้นต้นเดียวกัน = ไม่เดา');
  assert.equal(resolveCost(ctx, '10140-A1', '2026-11-05'), null, 'ชื่อไม่บอกน้ำหนัก = ไม่เดา');
  assert.equal(resolveCost(ctx, '20258-232', '2026-11-05'), null, 'หน่วยกล่อง = ไม่เดา');
  assert.equal(resolveCost(ctx, '20284-107', '2026-11-05').source, 'own');
});

test('lineCost multiplies by quantity in the cost unit and refuses when units cannot be matched', () => {
  const perPack = { cost: 53.1, unit: 'แพ็ค', grams: 500 }, perKg = { cost: 104, unit: 'กก.', grams: 1000 }, perPiece = { cost: 5, unit: 'ชิ้น', grams: null };
  // หน่วยฐานตรงกับหน่วยทุน → ใช้ qty_base (ชุดโปร TFACTOR 2: ขาย 3 ชุด = 6 แพ็ค)
  assert.equal(lineCost(perPack, { qty: 3, qty_base: 6, unit_code: 'แพ', base_unit: 'แพค' }), 53.1 * 6);
  // หน่วยฐานเป็นกก. แต่ขายเป็นแพ็ค ตรงกับหน่วยทุน → ใช้ qty
  assert.equal(lineCost(perPack, { qty: 10, qty_base: 5, unit_code: 'แพ', base_unit: 'กิโลกรัม' }), 531);
  // ทุนต่อกก. ขายเป็นแพ็ค รู้น้ำหนักรวม → ทุน × กก.
  assert.equal(lineCost(perKg, { qty: 10, qty_base: 10, unit_code: 'แพ', base_unit: 'แพค', kg: 5 }), 520);
  // ทุนต่อแพ็ค 500 ก. ขายเป็นลัง รู้น้ำหนักรวม 10 กก. → 20 แพ็ค
  assert.equal(lineCost(perPack, { qty: 1, qty_base: 1, unit_code: 'ลง', base_unit: 'ลัง', kg: 10 }), 53.1 * 20);
  assert.equal(lineCost(perPiece, { qty: 4, qty_base: 4, unit_code: 'แพ', base_unit: 'แพค', kg: 2 }), null);
  assert.equal(lineCost(perKg, { qty: 4, qty_base: 4, unit_code: 'แพ', base_unit: 'แพค' }), null);
  assert.equal(lineCost(null, { qty: 1, qty_base: 1, unit_code: 'กก', base_unit: 'กิโลกรัม' }), null);
});

test('cost_rounds routes: Master SKU import filters junk rows, holds suspect costs, keeps history by effective date', async t => {
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  const db = freshDb();
  const tokens = {};
  for (const [uid, role] of [['SA', 'superadmin'], ['A', 'admin'], ['SM', 'sales_manager']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'User ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO products(code,name,unit) VALUES('10002','ค็อกเทล','กิโลกรัม'),('10002-62','ค็อกเทล 500','แพค'),('10165-78','แฮม','กิโลกรัม')").run();
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const root = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, method = 'GET', body, uid = 'A') => {
    const r = await fetch(root + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: r.status === 204 ? null : await r.json() };
  };

  // แถวแบบเดียวกับไฟล์จริง: รหัสเป็นตัวเลข, แถวคั่น, ไม่เคลื่อนไหว, #N/A, รหัสซ้ำ, ทุนต่ำผิดปกติ, รหัสที่ระบบไม่รู้จัก
  const rows = [
    { row: 4, code: 10002, name: 'ค็อกเทล', unit: 'กิโลกรัม', old: 113.77, base: 90.301349, depr: 94.16, total: 104.06, group: 'Sausage', std_group: 'กลุ่มที่ 8', status: 'สินค้าดี' },
    { row: 7, code: '10002-62', unit: 'แพ็คx500', old: 60.78, base: 46.22, depr: 48.15, total: 53.1 },
    { row: 2952, code: 0, unit: 0, old: 0, base: 0, depr: 0, total: 0 },
    { row: 2959, code: '0', name: 'สินค้ามีการเคลื่อนไหวแล้ว', total: null },
    { row: 4000, code: '20183-11', unit: 'กิโลกรัม', old: 'สินค้าไม่เคลื่อนไหว', base: 0, depr: 0, total: 0 },
    { row: 2156, code: 'SET-1', unit: 'เซ็ตx700', base: '#N/A', depr: '#N/A', total: '#N/A' },
    { row: 3514, code: '10165-78', unit: 'KG.', old: 150, base: 21.51, depr: 36.83, total: 46.73 },
    { row: 3971, code: '10002-62', unit: 'แพ็คx500', old: 60, base: 1, depr: 1, total: 1 },
    { row: 3972, code: 'ZZ-NEW', unit: 'ชิ้น', old: '#N/A', base: 12, depr: 12, total: 12 },
    { row: 1059, code: '(หมู Free Range)', unit: 'กิโลกรัม', base: 200, depr: 204, total: 214 },
  ];
  assert.equal((await call('/cost_rounds/import/preview', 'POST', { eff_date: '2026-11-02', rows }, 'SM')).status, 403);
  assert.equal((await call('/cost_rounds/import/preview', 'POST', { eff_date: '2026-13-02', rows })).status, 400);

  const pv = (await call('/cost_rounds/import/preview', 'POST', { eff_date: '2026-11-02', rows })).data;
  assert.deepEqual([pv.new_count, pv.changed_count, pv.suspect_count, pv.error_count, pv.dup_count], [3, 0, 1, 1, 1]);
  assert.deepEqual(pv.skipped, { separator: 2, inactive: 1 });
  assert.deepEqual(pv.unknown, ['ZZ-NEW']);
  assert.deepEqual(pv.invalid.map(x => x.code), ['(หมู Free Range)']);
  assert.deepEqual(pv.suspects.map(s => [s.code, s.total, s.old_cost]), [['10165-78', 46.73, 150]]);
  assert.deepEqual(pv.dup, [{ code: '10002-62', row: 3971, kept_row: 7 }]);

  const imp = (await call('/cost_rounds/import', 'POST', { eff_date: '2026-11-02', rows, file: 'Master SKU.xlsx', rm_label: 'RM 2-7.11.69' })).data;
  assert.deepEqual([imp.created, imp.updated, imp.held], [3, 0, 1]);
  const cur = (await call('/cost_rounds')).data;
  assert.deepEqual(cur.map(r => [r.sku, r.cost_base, r.cost_total, r.unit, r.unit_grams]), [
    ['10002', 90.3013, 104.06, 'กก.', 1000], ['10002-62', 46.22, 53.1, 'แพ็ค', 500], ['ZZ-NEW', 12, 12, 'ชิ้น', null]]);

  // นำเข้าไฟล์เดิมซ้ำ = ไม่มีอะไรเปลี่ยน
  const again = (await call('/cost_rounds/import', 'POST', { eff_date: '2026-11-02', rows })).data;
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 3]);

  // รอบถัดไป: ทุนเปลี่ยนตัวเดียว → เก็บเฉพาะแถวที่เปลี่ยน · รอบเดิมยังอยู่ · ยอมนำเข้าทุนต่ำผิดปกติพร้อมธง
  const next = rows.map(r => (r.row === 4 ? { ...r, total: 108 } : r));
  const pv2 = (await call('/cost_rounds/import/preview', 'POST', { eff_date: '2026-11-09', rows: next, suspect: 'import' })).data;
  assert.deepEqual([pv2.new_count, pv2.changed_count, pv2.unchanged_count, pv2.suspect_mode], [1, 1, 2, 'import']);
  assert.deepEqual(pv2.changed.map(c => [c.code, c.prev_total, c.total]), [['10002', 104.06, 108]]);
  await call('/cost_rounds/import', 'POST', { eff_date: '2026-11-09', rows: next, suspect: 'import' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sku_cost_rounds').get().n, 5);
  assert.equal(db.prepare("SELECT suspect FROM sku_cost_rounds WHERE sku = '10165-78'").get().suspect, 1);
  assert.deepEqual((await call('/cost_rounds?date=2026-11-05')).data.find(r => r.sku === '10002').cost_total, 104.06);
  const ctx = costContext(db);
  assert.equal(resolveCost(ctx, '10002', '2026-11-05').cost, 104.06);
  assert.equal(resolveCost(ctx, '10002', '2026-11-12').cost, 108);
  const logs = (await call('/cost_rounds/logs?sku=10002')).data;
  assert.ok(logs.some(l => l.field === 'cost_total' && l.old_value === '104.06' && l.new_value === '108'));
  assert.equal((await call('/cost_rounds/uploads')).data.uploads.length, 3);

  // งานพิจารณาโปรใช้ sku_costs รายเดือนตามเดิม ไม่ถูกแตะ
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sku_costs').get().n, 0);

  // สิทธิ์เห็นทุน: superadmin เท่านั้นที่ติ๊กให้ได้ · /auth/me ส่งธงกลับ
  assert.equal((await call('/sc_users?uid=eq.SM', 'PATCH', { can_see_cost: 1 }, 'A')).status, 403);
  assert.equal((await call('/sc_users?uid=eq.SM', 'PATCH', { name: 'เปลี่ยนชื่อ' }, 'A')).status, 200);
  assert.equal((await call('/sc_users?uid=eq.SM', 'PATCH', { can_see_cost: 1 }, 'SA')).data.can_see_cost, 1);
  assert.equal((await call('/auth/me', 'GET', null, 'SM')).data.can_see_cost, 1);
  assert.equal((await call('/auth/me', 'GET', null, 'A')).data.can_see_cost, 0);
});

test('dashboard exec: gross margin block only for users allowed to see cost, cost by sale date, gaps reported', async t => {
  const db = freshDb();
  const tokens = {};
  for (const [uid, role, see] of [['SA', 'superadmin', 0], ['A', 'admin', 0], ['A2', 'admin', 1]]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash,can_see_cost) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, 'x', see);
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO products(code,name,unit,group_name) VALUES('P1','ไส้กรอก กก.','กิโลกรัม','003'),('P2','ไส้กรอก 500 กรัม','แพค','003'),('P3','ไม่มีทุน','แพค','002'),('SRC','ต้นทาง','กิโลกรัม','003'),('CV','แปลงมา','แพค','003')").run();
  const cost = db.prepare('INSERT INTO sku_cost_rounds (sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams) VALUES (?,?,?,?,?,?,?)');
  cost.run('P1', '2026-11-02', 80, 90, 100, 'กก.', 1000);
  cost.run('P1', '2026-11-09', 90, 100, 110, 'กก.', 1000);
  cost.run('P2', '2026-11-02', 40, 45, 50, 'แพ็ค', 500);
  cost.run('SRC', '2026-11-02', 60, 70, 80, 'กก.', 1000);
  const ff = db.prepare('INSERT INTO conversion_doc_lines (doc_num, seq_num, doc_date, sku, direction, qty) VALUES (?,?,?,?,?,?)');
  ff.run('FF1', '1', '2026-10-01', 'SRC', 'out', 10); ff.run('FF1', '2', '2026-10-01', 'CV', 'in', 20); // 40 ต่อแพ็ค
  const line = db.prepare("INSERT INTO sales_lines_daily (company, d, cust_code, slm_code, sku, unit_code, qty, qty_base, amount) VALUES ('TSS', ?, 'C1', '101', ?, ?, ?, ?, ?)");
  line.run('2026-11-05', 'P1', 'กก', 10, 10, 1500);   // ทุน 100 → 1,000
  line.run('2026-11-10', 'P1', 'กก', 10, 10, 1500);   // ทุนรอบใหม่ 110 → 1,100
  line.run('2026-11-05', 'P2', 'แพ', 20, 20, 1200);   // 50 × 20 = 1,000
  line.run('2026-11-05', 'P3', 'แพ', 5, 5, 300);      // ไม่มีทุน
  line.run('2026-11-05', 'CV', 'แพ', 10, 10, 600);    // ทุนจากการแปลง 40 × 10 = 400
  line.run('2026-10-15', 'P1', 'กก', 10, 10, 1500);   // นอกช่วง แต่อยู่ในกราฟรายเดือน (ทุนรอบแรกย้อนหลัง)
  // Top สินค้าของหน้า Dashboard อ่านจากตารางรายเดือน — ระบบจริง sync เขียนสองตารางนี้พร้อมกัน
  db.exec("INSERT INTO sales_lines_monthly (company, ym, cust_code, slm_code, sku, unit_code, qty, qty_base, amount) SELECT company, substr(d,1,7), cust_code, slm_code, sku, unit_code, SUM(qty), SUM(qty_base), SUM(amount) FROM sales_lines_daily GROUP BY 1,2,3,4,5,6");
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const get = async uid => (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/exec?from=2026-11&to=2026-11`, { headers: { Authorization: `Bearer ${tokens[uid]}` } })).json();

  assert.equal('margin' in await get('A'), false);
  assert.ok((await get('A2')).margin.has_cost);
  const m = (await get('SA')).margin;
  assert.deepEqual([m.totals.lines, m.totals.covered], [5100, 4800]);
  assert.deepEqual(m.totals.cogs, { total: 3500, depr: 3150, base: 2800 });
  assert.deepEqual([m.monthly['2026-10'].covered, m.monthly['2026-10'].cogs.total], [1500, 1000]);
  assert.deepEqual([m.gaps.no_cost.count, m.gaps.no_cost.amount, m.gaps.no_cost.top[0].sku], [1, 300, 'P3']);
  assert.deepEqual(m.gaps.converted, { count: 1, amount: 600 });
  assert.deepEqual([m.products.CV.source, m.products.CV.from, m.products.CV.cogs.total], ['converted', ['SRC'], 400]);
  assert.equal(m.products.P1.cogs.total, 2100);
  assert.deepEqual([m.first_date, m.last_date], ['2026-11-02', '2026-11-09']);

  // /margin: เจาะลึก — เฉพาะผู้มีสิทธิ์ · ลูกค้า×สินค้าที่ขายต่ำกว่าทุน · ทุนเปลี่ยนระหว่างสองรอบ
  const mg = async (uid, q) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/margin?${q}`, { headers: { Authorization: `Bearer ${tokens[uid]}` } }); return { status: r.status, data: await r.json() }; };
  assert.equal((await mg('A', 'from=2026-11&to=2026-11')).status, 403);
  db.prepare("INSERT INTO sales_lines_daily (company, d, cust_code, slm_code, sku, unit_code, qty, qty_base, amount) VALUES ('TSS', '2026-11-12', 'C2', '102', 'P2', 'แพ', 10, 10, 400)").run(); // ขาย 40 ทุน 50
  const det = (await mg('SA', 'from=2026-11-01&to=2026-11-30')).data;
  assert.deepEqual([det.totals.lines, det.totals.covered, det.totals.cogs.total], [5500, 5200, 4000]);
  assert.deepEqual(det.by_customer.map(c => [c.code, c.lines]), [['C1', 5100], ['C2', 400]]);
  assert.deepEqual(det.by_slm.map(c => [c.code, c.covered]), [['101', 4800], ['102', 400]]);
  assert.deepEqual(det.below_cost.map(x => [x.cust, x.sku, x.slm, x.covered - x.cogs.total]), [['C2', 'P2', '102', -100]]);
  assert.deepEqual(det.cost_changes.map(x => [x.sku, x.prev, x.cur, x.avg_price]), [['P1', 100, 110, 150]]);
  assert.equal(det.by_sku.find(x => x.sku === 'CV').source, 'converted');
  // กลุ่มสินค้า = รหัสกลุ่ม Express · ลูกค้าต่อสินค้า · รายการที่ไม่ใช่สินค้า (ค่าเช่า) ไม่นับ
  assert.deepEqual(det.by_group.map(g => [g.name, g.lines]), [['003', 5200], ['002', 300]]);
  assert.deepEqual(det.sku_custs.P2.map(c => [c.code, c.lines, c.covered - c.cogs.total]), [['C1', 1200, 200], ['C2', 400, -100]]);
  db.prepare("INSERT INTO products(code,name,unit,group_name) VALUES('99-7','รายได้เบ็ดเตล็ด - ให้เช่าที่ดิน','ครั้ง','')").run();
  db.prepare("INSERT INTO sales_lines_daily (company, d, cust_code, slm_code, sku, unit_code, qty, qty_base, amount) VALUES ('TSS', '2026-11-13', 'C1', '101', '99-7', 'ครั้ง', 1, 1, 9999)").run();
  assert.equal((await mg('SA', 'from=2026-11-01&to=2026-11-29')).data.totals.lines, 5500);
  assert.equal((await mg('SA', 'from=2026-11&to=2027-01')).status, 400);

  // รายงาน LINE (user = null, scopeAll) ต้องไม่มีกำไร
  const payload = require('../routes/dashboardExec')(db).execPayload({ from: '2026-11', to: '2026-11' }, null, { scopeAll: true });
  assert.equal('margin' in payload, false);
});

test('invoice_detail pivot: cost columns per row by sale date, only for users allowed to see cost', async t => {
  const db = freshDb();
  const tokens = {};
  for (const [uid, role, see] of [['A', 'admin', 0], ['A2', 'admin', 1]]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash,can_see_cost) VALUES(?,?,?,?,?)').run(uid, 'User ' + uid, role, 'x', see);
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO products(code,name,unit,group_name) VALUES('P1','ไส้กรอก กก.','กิโลกรัม','003'),('P2','ไส้กรอก 500 กรัม','แพค','003'),('P3','ไม่มีทุน','แพค','003'),('CV','แปลงมา','แพค','002')").run();
  const cost = db.prepare('INSERT INTO sku_cost_rounds (sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams) VALUES (?,?,?,?,?,?,?)');
  cost.run('P1', '2026-11-02', 80, 90, 100, 'กก.', 1000);
  cost.run('P1', '2026-11-09', 90, 100, 110, 'กก.', 1000);
  cost.run('P2', '2026-11-02', 40, 45, 50, 'แพ็ค', 500);
  cost.run('SRC', '2026-11-02', 60, 70, 80, 'กก.', 1000);
  db.prepare("INSERT INTO products(code,name,unit) VALUES('SRC','ต้นทาง','กิโลกรัม')").run();
  const ff = db.prepare('INSERT INTO conversion_doc_lines (doc_num, seq_num, doc_date, sku, direction, qty) VALUES (?,?,?,?,?,?)');
  ff.run('FF1', '1', '2026-10-01', 'SRC', 'out', 10); ff.run('FF1', '2', '2026-10-01', 'CV', 'in', 20); // 40 ต่อแพ็ค
  const head = db.prepare("INSERT INTO invoices(doc_num,doc_date,cust_code,slm_code,rectyp) VALUES(?,?,'C1','101','0')");
  const line = db.prepare("INSERT INTO invoice_lines(company,doc_num,seq_num,doc_date,sku,sku_name,qty,unit_code,unit_factor,line_value) VALUES('TSS',?,?,?,?,?,?,?,?,?)");
  head.run('IA1', '2026-11-05'); head.run('IA2', '2026-11-10');
  line.run('IA1', '1', '2026-11-05', 'P1', 'ไส้กรอก กก.', 10, 'กก', 1, 1500);   // ทุน 100 → 1,000
  line.run('IA2', '1', '2026-11-10', 'P1', 'ไส้กรอก กก.', 10, 'กก', 1, 1500);   // ทุนรอบใหม่ 110 → 1,100
  line.run('IA1', '2', '2026-11-05', 'P2', 'ไส้กรอก 500 กรัม', 10, 'แพ', 2, 1200); // 10 × 2 = 20 แพ็ค × 50 = 1,000
  line.run('IA1', '3', '2026-11-05', 'P3', 'ไม่มีทุน', 5, 'แพ', 1, 300);
  line.run('IA1', '4', '2026-11-05', 'CV', 'แปลงมา', 10, 'แพ', 1, 600);           // 40 × 10 = 400
  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const pivot = async uid => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/invoice_detail/pivot`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens[uid]}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: '2026-11-01', to: '2026-11-30' }) })).json());

  const plain = await pivot('A');
  assert.equal('cost' in plain, false);
  assert.ok(plain.rows.every(r => !('ct' in r) && !('cc' in r) && !('bk' in r)));
  const withCost = await pivot('A2');
  const by = Object.fromEntries(withCost.rows.map(r => [r.k, r]));
  // P1 สองช่วงทุนรวมกลับเป็นแถวเดียว
  assert.equal(withCost.rows.filter(r => r.k === 'P1').length, 1);
  assert.deepEqual([by.P1.q, by.P1.a, by.P1.cc, by.P1.ct, by.P1.cd, by.P1.cb, by.P1.cq], [20, 3000, 3000, 2100, 1900, 1700, 20]);
  assert.deepEqual([by.P2.cc, by.P2.ct, by.P2.cq], [1200, 1000, 20]);
  assert.equal('cc' in by.P3, false);
  assert.deepEqual([by.CV.ct, withCost.cost.skus.CV.src, withCost.cost.skus.CV.fr], [400, 'converted', ['SRC']]);
  assert.equal(withCost.cost.skus.P1.u, 'กก.');
  assert.deepEqual(plain.rows.map(r => [r.k, r.a]).sort(), withCost.rows.map(r => [r.k, r.a]).sort());
});
