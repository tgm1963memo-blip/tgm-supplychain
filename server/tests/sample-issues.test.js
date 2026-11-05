const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../app');
const { createSession } = require('../middleware/auth');
const { runMigrations } = require('../db/migrations');
const si = require('../lib/sampleIssues');

const NICK = si.buildNickMap(
  [{ slm_id: '213', name: 'ห้าง-ครีม.0960875229' }, { slm_id: '207', name: 'ห้าง-เมย์.0827904060' }, { slm_id: '217', name: 'ห้าง-นก.0889919742' },
    { slm_id: '206', name: '*****' }, { slm_id: '114', name: 'คุณอุ้ม.0919414669' }],
  [{ name: 'คุณธีระพล สูงสุดปัญญา (ไกด์)', slm_id: '110', slm_codes: '110,110-1' }]);

// ประวัติเบิกตัวอย่าง (2026-11-05): อ่านเจ้าของจากหมายเหตุใบ KA/KB/PD
test('sample issues: remark parsing — strip /P, salesperson nickname, chain, office', () => {
  assert.equal(si.stripKeyerTag('บ.อัครา กรุ๊ป จำกัด/P'), 'บ.อัครา กรุ๊ป จำกัด');
  assert.equal(si.stripKeyerTag('P ออกบูธแจกชิม'), 'ออกบูธแจกชิม');
  assert.equal(NICK.get('ครีม'), '213');
  assert.equal(NICK.get('ไกด์'), '110-1', 'รหัสที่มีรหัสย่อย -1 ใช้รหัสย่อย');
  assert.ok(![...NICK.values()].includes('206'), 'รหัสเลิกใช้ไม่เป็นชื่อเล่น');

  let r = si.resolveFromRemark('The Mall/งามวงศ์วาน/สาย8', 'เซลส์ส่งเอง วันที่ 24/7/69 (เซลล์ ครีม)', NICK);
  assert.deepEqual(r, { slm: '213', cust_name: 'The Mall (จากหมายเหตุ)', src: 'remark' });
  r = si.resolveFromRemark('Makro/เซลล์ส่ง', '', NICK);
  assert.equal(r.slm, '', '"เซลล์ส่ง" ไม่ใช่ชื่อเซลส์');
  assert.equal(r.src, 'chain');
  r = si.resolveFromRemark('ออฟฟิตเบิก/P', '', NICK);
  assert.deepEqual(r, { slm: '', cust_name: 'ออฟฟิศ', src: 'office' });
  r = si.resolveFromRemark('สุกี้ตี๋น้อย/P', '', NICK);
  assert.deepEqual(r, { slm: '', cust_name: 'สุกี้ตี๋น้อย', src: 'none' });
  assert.equal(si.resolveFromRemark('งานบูธ', 'เซลคุณเมย์รับเอง', NICK).slm, '207');
});

test('sample issues: buildLines — prefixes, year, cancelled, sell price, owner source', () => {
  const d = s => new Date(s + 'T00:00:00Z');
  const rows = [
    { DOCNUM: 'LB6900001', SEQNUM: '1', DOCDAT: d('2026-01-09'), STKCOD: 'A', STKDES: 'x', PEOPLE: '01-MB-0125', SLMCOD: '154', TRNQTY: 2, TQUCOD: 'แพ', TFACTOR: 1, UNITPR: 139, XTRNVAL: 164 },
    { DOCNUM: 'LA6900002', SEQNUM: '1', DOCDAT: d('2026-01-05'), STKCOD: 'A', PEOPLE: '01-IH-0096', SLMCOD: '101', TRNQTY: 1, TQUCOD: 'กก', TFACTOR: 2, UNITPR: 0, XTRNVAL: 58.6 },
    { DOCNUM: 'LA6900003', SEQNUM: '1', DOCDAT: d('2026-01-05'), STKCOD: 'A', PEOPLE: '01-IH-0096', TRNQTY: 1, XTRNVAL: 9 }, // ยกเลิก
    { DOCNUM: 'LA6800001', SEQNUM: '1', DOCDAT: d('2025-12-30'), STKCOD: 'A', PEOPLE: '01-IH-0096', TRNQTY: 1, XTRNVAL: 9 }, // ปีอื่น
    { DOCNUM: 'AB6900001', SEQNUM: '1', DOCDAT: d('2026-01-05'), STKCOD: 'A', PEOPLE: 'C', TRNQTY: 1, XTRNVAL: 9 }, // ไม่ใช่เล่มเบิก
  ];
  const lines = si.buildLines(rows, {
    company: 'TSS-NV', prefixes: new Set(['LA', 'LB', 'LD']), cancelled: new Set(['LA6900003']), headerRemarks: new Map(), lineRemarks: new Map(),
    nickMap: NICK, products: new Map([['A', { price: 120, unit: 'แพ', name: 'ไส้กรอก A' }]]),
    custNames: new Map([['01-IH-0096', 'นภัสสร ผาอุ (ฝ่ายขายร้านค้า)'], ['01-MB-0125', 'บิ๊กซี']]), normalizeSlm: s => String(s || '').trim().slice(0, 3),
  });
  assert.deepEqual(lines.map(l => l.doc_num), ['LB6900001', 'LA6900002']);
  const [lb, la] = lines;
  assert.equal(lb.sell_value, 278, 'บิล LB ใช้ราคาในบิล');
  assert.equal(lb.cost_value, 164);
  assert.equal(lb.slm_code, '154');
  assert.equal(lb.kind, 'tasting');
  assert.equal(la.sell_value, 240, 'หน่วยไม่ตรงหน่วยหลัก = ราคาหลัก × TFACTOR');
  assert.equal(la.slm_code, '', 'ใบ LA ไม่ใช้รหัส 101 ในใบ');
  assert.equal(la.cust_name, '(ผู้เบิก) นภัสสร ผาอุ');
  assert.equal(la.sku_name, 'ไส้กรอก A');
});

test('sample issues API: sales see own rows without cost, manager sees all + cost, owner override & person map', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  runMigrations(db);
  const tokens = {};
  for (const [uid, role, codes] of [['S', 'sales_officer', '213'], ['S2', 'sales_officer', '207'], ['M', 'sales_manager', ''], ['A', 'admin', '']]) {
    db.prepare('INSERT INTO sc_users(uid,name,role,department,slm_codes,pwd_hash) VALUES(?,?,?,?,?,?)').run(uid, uid, role, 'แผนกขายธุรกิจค้าปลีก', codes || null, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  for (const c of ['213', '207', '113']) db.prepare('INSERT INTO salesmen(slm_id,name) VALUES(?,?)').run(c, 'ห้าง-' + c);
  const ins = db.prepare(`INSERT INTO sample_issue_lines (company,doc_num,seq,doc_date,prefix,kind,sku,sku_name,qty,unit,cost_value,sell_value,cust_code,cust_name,slm_code,remark,owner_src)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('TSS', 'KA6907001', '1', '2026-07-01', 'KA', 'tasting', 'A', 'A', 2, 'แพ', 100, 150, '', 'The Mall (จากหมายเหตุ)', '213', 'x (เซลล์ ครีม)', 'remark');
  ins.run('TSS', 'KB6907002', '1', '2026-07-02', 'KB', 'sample', 'B', 'B', 1, 'แพ', 50, 80, '', 'Makro (จากหมายเหตุ)', '', 'Makro/เซลล์ส่ง', 'chain');
  ins.run('TSS-NV', 'LA6900002', '1', '2026-01-05', 'LA', 'sample', 'A', 'A', 1, 'กก', 30, 40, '01-IH-0096', '(ผู้เบิก) นภัสสร', '', '', 'person');
  db.prepare(`INSERT INTO sample_issue_lines (company,doc_num,seq,doc_date,prefix,kind,sku,loc_code,qty,cost_value,cust_code,cust_name,slm_code,owner_src)
    VALUES ('TSS','KA6907001','1','2026-07-01','KA','tasting','A','02',1,40,'','The Mall (จากหมายเหตุ)','213','remark')`).run();
  ins.run('TSS-NV', 'LA6900009', '1', '2026-02-05', 'LA', 'sample', 'A', 'A', 1, 'กก', 7, 9, '01-IH-0999', '(ผู้เบิก) ใครสักคน', '', '', 'person');

  const server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/sample_issues`;
  const call = async (route, uid, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${tokens[uid]}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };

  // เซลส์ 213: เห็นแค่ใบของตัวเอง ไม่มีทุน
  let r = await call('/lines?from=2026-01-01&to=2026-12-31', 'S');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rows.map(x => x[1]), ['KA6907001', 'KA6907001'], 'สองคลัง = สองแถว');
  assert.equal(r.data.rows[0][9], null, 'เซลส์ไม่ได้รับมูลค่าทุน');
  assert.equal(r.data.rows[0][8], 150);
  assert.equal(r.data.can_cost, false);
  assert.equal((await call('/unresolved', 'S')).status, 403);
  assert.equal((await call('/owner/KB6907002', 'S', 'PUT', { slm_code: '213' })).status, 403);

  // admin: เห็นทั้งหมด + ทุน · LA ที่จับคู่ผู้เบิกไว้ (01-IH-0096 → 113 จาก migration) มีเจ้าของ
  r = await call('/lines', 'A');
  assert.equal(r.data.rows.length, 5);
  assert.equal(r.data.can_cost, true);
  const la = r.data.rows.find(x => x[1] === 'LA6900002');
  assert.deepEqual([la[9], la[10], la[13]], [30, '113', 'person']);
  // ช่วงวันที่
  assert.deepEqual((await call('/lines?from=2026-07-02&to=2026-07-31', 'A')).data.rows.map(x => x[1]), ['KB6907002']);

  // รอระบุ: KB (ใบ) + ผู้เบิก 01-IH-0999 ยังไม่จับคู่
  // sales_manager ที่ดูแลแค่ทีม: ระบุเจ้าของไม่ได้ (ใบรอระบุยังไม่มีเจ้าของ กรองตามทีมไม่ได้)
  assert.equal((await call('/unresolved', 'M')).status, 403);
  assert.equal((await call('/owner/KB6907002', 'M', 'PUT', { slm_code: '207' })).status, 403);
  assert.equal((await call('/lines', 'M')).data.can_manage, false);
  r = await call('/unresolved', 'A');
  assert.deepEqual(r.data.docs.map(d => d.doc_num), ['KB6907002']);
  assert.equal(r.data.people[0].people_code, '01-IH-0999');
  assert.equal(r.data.people[0].slm_code, null);

  // ระบุเจ้าของ → เซลส์ 207 เห็น · ลบแล้วกลับเป็นรอระบุ
  assert.equal((await call('/owner/KB6907002', 'A', 'PUT', { slm_code: 'XXX' })).status, 400);
  for (const bad of ['%', '1_', '2%']) assert.equal((await call('/owner/KB6907002', 'A', 'PUT', { slm_code: bad })).status, 400, `wildcard ${bad}`);
  assert.equal((await call('/person/01-IH-0999', 'A', 'PUT', { slm_code: '%' })).status, 400);
  assert.equal((await call('/owner/NOPE', 'A', 'PUT', { slm_code: '207' })).status, 404);
  assert.equal((await call('/owner/KB6907002', 'A', 'PUT', { slm_code: '207', cust_name: 'Makro มหาชัย' })).status, 200);
  r = await call('/lines', 'S2');
  assert.deepEqual(r.data.rows.map(x => [x[1], x[12], x[13]]), [['KB6907002', 'Makro มหาชัย', 'manual']]);
  await call('/owner/KB6907002', 'A', 'PUT', { slm_code: '' });
  assert.deepEqual((await call('/lines', 'S2')).data.rows, []);

  // จับคู่ผู้เบิก LA
  assert.equal((await call('/person/01-IH-0999', 'A', 'PUT', { slm_code: '207' })).status, 200);
  assert.deepEqual((await call('/lines', 'S2')).data.rows.map(x => x[1]), ['LA6900009']);
});
