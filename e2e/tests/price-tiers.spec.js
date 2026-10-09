// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

// ราคากลาง A–G (2026-10-07, ใบเสนอราคา รอบ 1) — server/routes/priceTiers.js + หน้า pgPriceTiers ใน index.html
// บูต server/app.js จริงกับ SQLite ชั่วคราว (แบบเดียวกับ promo-draft-api-security.spec.js) ไม่แตะ DB จริงที่ BASE_URL
const serverRequire = createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));

let BASE, TEST_DB;
/** @type {import('http').Server} */
let server;
/** @type {import('node:sqlite').DatabaseSync} */
let db;
/** @type {Record<string, string>} */
const tokens = {};

const cleanup = () => { for (const ext of ['', '-shm', '-wal']) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } } };

test.beforeAll(async ({}, testInfo) => {
  const port = 3961 + testInfo.workerIndex;
  TEST_DB = path.join(__dirname, '..', `.tmp-price-tiers-w${testInfo.workerIndex}.db`);
  BASE = `http://127.0.0.1:${port}`;
  cleanup();
  process.env.DB_PATH = TEST_DB;
  delete require.cache[require.resolve('../../server/db/init.js')];
  delete require.cache[require.resolve('../../server/app.js')];
  const { openDb } = require('../../server/db/init.js');
  const { buildApp } = require('../../server/app.js');
  const { createSession } = require('../../server/middleware/auth.js');
  const bcrypt = serverRequire('bcryptjs');
  db = openDb();
  for (const [uid, role] of [['PT_MGR', 'sales_manager'], ['PT_SALES', 'sales'], ['PT_PLAN', 'planning']]) {
    db.prepare('INSERT OR REPLACE INTO sc_users (uid, name, role, pwd_hash) VALUES (?, ?, ?, ?)').run(uid, uid, role, bcrypt.hashSync('testpass123', 10));
    tokens[role] = createSession(db, uid).token;
  }
  db.prepare("INSERT OR REPLACE INTO products (code, name) VALUES ('10002', 'ค๊อกเทลซอสเซส')").run();
  await new Promise(r => { server = buildApp(db, {}).listen(port, '127.0.0.1', r); });
});
test.afterAll(async () => {
  await new Promise(r => server.close(r));
  try { db.close(); } catch { /* closed */ }
  cleanup();
});

const api = (role, url, opts = {}) => fetch(BASE + '/api/price_tiers' + url, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[role]}` },
});
const FILE = {
  tiers: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  rows: [
    { row: 2, code: 10002, name_th: 'ค๊อกเทลซอสเซส', name_en: 'Cocktail Sausage', unit: 'กิโลกรัม', prices: { A: 135, B: 145, C: 150, D: 150, E: 155, F: 160, G: 170 } },
    { row: 3, code: '10001-2', name_th: 'ค๊อกเทลซอสเซส 500 กรัม', name_en: null, unit: 'กิโลกรัม', prices: { A: 140, B: '1,150', C: 'abc', D: null, E: 160, F: 165, G: 175 } },
    { row: 4, code: '10050', name_th: 'สินค้ายกเลิก', unit: 'แพค', prices: { A: 'ยกเลิกการขาย 6/3/2568', B: null, C: null, D: null, E: null, F: null, G: null } },
  ],
};

test.describe.serial('price tiers API', () => {
  test('sales/planning cannot import; planning cannot even read', async () => {
    expect((await api('sales', '/import/preview', { method: 'POST', body: JSON.stringify(FILE) })).status).toBe(403);
    expect((await api('sales', '/10002', { method: 'PUT', body: JSON.stringify({ price_a: 1 }) })).status).toBe(403);
    expect((await api('planning', '')).status).toBe(403);
  });

  test('preview flags invalid prices, cancelled items and codes not in Express; import is idempotent', async () => {
    const pv = await (await api('sales_manager', '/import/preview', { method: 'POST', body: JSON.stringify(FILE) })).json();
    expect(pv.new_count).toBe(3);
    expect(pv.invalid).toEqual([{ row: 3, code: '10001-2', tier: 'C', value: 'abc' }]);
    expect(pv.cancelled).toEqual(['10050']);
    expect(pv.unknown.sort()).toEqual(['10001-2', '10050']);
    const res = await (await api('sales_manager', '/import', { method: 'POST', body: JSON.stringify(FILE) })).json();
    expect(res.created).toBe(3);
    const again = await (await api('sales_manager', '/import/preview', { method: 'POST', body: JSON.stringify(FILE) })).json();
    expect(again.changed_count + again.new_count).toBe(0);
    const rows = await (await api('sales', '')).json();
    const r = rows.find(x => x.code === '10001-2');
    expect([r.price_a, r.price_b, r.price_c, r.price_d]).toEqual([140, 1150, null, null]);
    expect(rows.find(x => x.code === '10050').is_active).toBe(0);
  });

  test('single-tier file only touches that tier; manual edit is logged', async () => {
    const one = { tiers: ['A'], rows: [{ row: 2, code: '10002', prices: { A: 136 } }] };
    const pv = await (await api('sales_manager', '/import/preview', { method: 'POST', body: JSON.stringify(one) })).json();
    expect(pv.changed).toEqual([{ code: '10002', row: 2, changes: [{ field: 'price_a', old: 135, new: 136 }] }]);
    const put = await api('sales_manager', '/10002', { method: 'PUT', body: JSON.stringify({ price_g: 171 }) });
    expect(put.status).toBe(200);
    expect((await api('sales_manager', '/10002', { method: 'PUT', body: JSON.stringify({ price_g: -5 }) })).status).toBe(400);
    const logs = await (await api('sales', '/logs?code=10002')).json();
    expect(logs[0]).toMatchObject({ field: 'price_g', old_value: '170', new_value: '171', source: 'manual', by_uid: 'PT_MGR' });
  });

  test('min_price_tier defaults to E and is exposed on /auth/me', async () => {
    const me = await (await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${tokens.sales}` } })).json();
    expect(me.min_price_tier).toBe('E');
  });

// อยู่ใน serial เดียวกัน — ใช้ข้อมูลที่นำเข้าในเทสต์ก่อนหน้า (10002 ฐาน A = 135)
test('price tiers page: import an Excel file, then edit a price inline', async ({ page }) => {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.fill('#l-uid', 'PT_MGR');
  await page.fill('#l-pwd', 'testpass123');
  await page.click('button:has-text("เข้าสู่ระบบ")');
  await page.waitForFunction(() => typeof ROLE !== 'undefined' && ROLE === 'sales_manager');
  await page.evaluate(() => nav('pricetiers'));
  await expect(page.locator('#pt-body')).toBeVisible();
  // สร้างไฟล์แบบ "ฐานราคาร้านค้า A–G" ในหน้าเว็บ (มีคอลัมน์ "A(2) เดิม" ที่ต้องไม่ถูกนับเป็นฐาน A)
  await page.evaluate(async () => {
    await ensureXLSX();
    const aoa = [[null, 'รหัส', 'รายการสินค้า', 'English Name', 'หน่วย', 'A(2) เดิม', 'A ปรับ 1/7/65', 'B ปรับ 1/7/65', 'C ปรับ 1/7/65', 'D ปรับ 1/7/65', 'E ปรับ 1/7/65', 'F ปรับ 1/7/65', 'G ปรับ1/7/65 '],
      [1, 10002, 'ค๊อกเทลซอสเซส', 'Cocktail Sausage', 'กิโลกรัม', 1, 137, 145, 150, 150, 155, 160, 170],
      [2, '20024', 'สโมคเบค่อน', 'Bacon', 'กิโลกรัม', 1, 300, 305, 310, 315, 320, 325, 330]];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'พี่หลิน');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    ptImport({ files: [new File([buf], 'ฐานราคา.xlsx')], value: '' });
  });
  await expect(page.locator('#pt-draft')).toContainText('ใหม่ 1');
  await expect(page.locator('#pt-draft')).toContainText('135 → 137');
  await page.click('button:has-text("บันทึกราคากลาง")');
  const cell = page.locator('#pt-body td[data-code="20024"][data-t="A"]');
  await expect(cell).toHaveText('300');
  await cell.click();
  await cell.locator('input').fill('299');
  await cell.locator('input').press('Enter');
  await expect(cell).toHaveText('299');
  const row = db.prepare("SELECT price_a FROM price_tiers WHERE code = '20024'").get();
  expect(row.price_a).toBe(299);
});
});
