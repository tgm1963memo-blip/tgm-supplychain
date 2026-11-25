// @ts-check
const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// พัฒนาสินค้าใหม่ (NPD) 2026-11-25 — หน้าเว็บจริงกับ server ในหน่วยความจำ (ไม่แตะฐานข้อมูลจริง)
// ไล่ flow ด้วยผู้ใช้คนละบทบาท: Sales สร้าง/ส่ง → หัวหน้าอนุมัติ → พี่หลินแนบสแกน+บันทึกผล → คุณโอ → RD … → บัญชีโรงงานเปิดขาย
const USERS = [['S', 'sales_officer'], ['H', 'sales_manager'], ['LIN', 'officer'], ['O', 'manager'], ['RD', 'officer'], ['CA', 'officer'], ['FA', 'officer'], ['AD', 'admin']];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000502027f3d8c6e0000000049454e44ae426082', 'hex');
const ITEM = { name: 'ไส้กรอก E2E', qty: 2, unit: 'กก.', targetPrice: 180, forecastKg: 500, brand: 'TGM', pack1G: 500, pack1Qty: 1, pack1Type: 'nylon',
  outer: 'box', outerQty: 10, boxType: 'logo', casing: 'hog', sliceMm: 0, pcsPerKg: 20, diameterMm: 22, weightG: 50, lengthVal: 12, lengthUnit: 'cm',
  storage: 'chill', storageDays: 30, coaPhys: 'lot', coaChem: 'lot', coaMicro: 'lot', coaYear: 'none', draftSpec: 'yes', detail: 'รสพริก' };

let server, base, tokens = {}, db;
test.beforeAll(async () => {
  for (const k of ['SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PASS']) delete process.env[k];
  const { runMigrations } = require('../../server/db/migrations');
  const { buildApp } = require('../../server/app');
  const { createSession } = require('../../server/middleware/auth');
  db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../../server/db/schema.sql'), 'utf8'));
  runMigrations(db);
  for (const [uid, role] of USERS) {
    db.prepare('INSERT INTO sc_users(uid,name,role,pwd_hash) VALUES(?,?,?,?)').run(uid, 'คุณ ' + uid, role, 'x');
    tokens[uid] = createSession(db, uid).token;
  }
  db.prepare("INSERT INTO customers(code,name,slm_id,is_active) VALUES('C1','ลูกค้า E2E','101',1)").run();
  const set = db.prepare('UPDATE npd_settings SET value = ? WHERE key = ?');
  for (const [k, u] of [['lin', 'LIN'], ['o', 'O'], ['rd', 'RD'], ['cost_acct', 'CA'], ['factory_acct', 'FA']]) set.run(JSON.stringify([u]), k);
  server = buildApp(db).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(r => server.close(r)); db.close(); });

async function as(page, uid) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const role = USERS.find(u => u[0] === uid)[1];
  await page.evaluate(([t, uid, role]) => {
    localStorage.setItem('tgm_session_token', t);
    localStorage.setItem('tgm_session', JSON.stringify({ uid, role, name: 'คุณ ' + uid }));
    sessionStorage.setItem('_pg', 'npd');
  }, [tokens[uid], uid, role]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#ni-npd')).toBeVisible({ timeout: 15000 });
}
const api = async (uid, p, method = 'GET', body) => {
  const r = await fetch(base + '/api/npd_projects' + p, { method, headers: { Authorization: 'Bearer ' + tokens[uid], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const act = (uid, id, a, body = {}) => api(uid, `/${id}/act/${a}`, 'POST', body);
async function attach(uid, id, kind) {
  const fd = new FormData(); fd.append('kind', kind); fd.append('file', new Blob([PNG], { type: 'image/png' }), 'x.png');
  await fetch(`${base}/api/npd_projects/${id}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens[uid] }, body: fd });
}

test('NPD menu: sales creates and submits, approvers act from the page, each actor sees their panel', async ({ page }) => {
  page.on('dialog', d => d.accept(''));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // ① Sales สร้างจากหน้าเว็บ
  await as(page, 'S');
  await page.locator('#ni-npd').click();
  await page.getByRole('button', { name: /ขอตัวอย่างสินค้าใหม่/ }).click();
  await expect(page.locator('#ct')).toContainText('FM-RDC-RDD-12');
  await page.evaluate((item) => { _npd.form.items[0] = { ..._srBlankItem('new'), ...item }; npdRenderForm(); }, ITEM);
  await page.evaluate(() => { const s = document.getElementById('npd-cust'); if (![...s.options].some(o => o.value === 'C1')) s.add(new Option('C1', 'C1')); s.value = 'C1'; });
  await page.fill('#npd-cg', 'ร้านอาหาร');
  await page.fill('#npd-contact', 'คุณเอ');
  await page.fill('#npd-phone', '0800000000');
  await page.fill('#npd-delivery', '2026-12-10');
  await page.fill('#npd-purpose', 'ทดสอบสูตรใหม่');
  await page.selectOption('#npd-head', 'H');
  await page.getByRole('button', { name: /บันทึกและส่งขออนุมัติ/ }).click();
  await expect(page.locator('#ct')).toContainText('รอหัวหน้าอนุมัติ');
  const id = await page.evaluate(() => _npd.p.id);
  expect((await api('S', '/' + id)).doc_no).toMatch(/^NP\d{4}-\d{2}-001$/);

  // ② หัวหน้าอนุมัติจากรายการ (ตัวกรอง "รอฉัน")
  await as(page, 'H');
  await expect(page.locator('#ct')).toContainText('มีงาน NPD รอคุณ 1 รายการ');
  await page.locator('#ct tbody tr').first().click();
  await page.getByRole('button', { name: /อนุมัติ/ }).click();
  await expect(page.locator('#ct')).toContainText('รอผลอนุมัติคุณอ้อย');

  // ③ พี่หลิน: ต้องแนบสแกนก่อน
  await as(page, 'LIN');
  await page.locator('#ct tbody tr').first().click();
  await expect(page.locator('#ct')).toContainText('พิมพ์ให้คุณอ้อยเซ็น');
  await page.locator('input[type=file][onchange*="scan_paper"]').first().setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('#ct')).toContainText('scan.png');
  await page.getByRole('button', { name: /คุณอ้อยอนุมัติ/ }).click();
  await expect(page.locator('#ct')).toContainText('รอคุณโออนุมัติ');

  // ④ คุณโอ
  await as(page, 'O');
  await page.locator('#ct tbody tr').first().click();
  await page.getByRole('button', { name: /อนุมัติ/ }).click();
  await expect(page.locator('#ct')).toContainText('รอ RD รับเรื่อง');

  // ขั้นที่เหลือเดินผ่าน API แล้วตรวจว่าแต่ละคนเห็นกล่องงานของตัวเองบนหน้าเว็บ
  const openAs = async (uid, text) => { await as(page, uid); await page.evaluate((id) => npdOpen(id), id); await expect(page.locator('#ct')).toContainText(text); };
  await openAs('RD', 'RD รับเรื่อง');
  await act('RD', id, 'rd_accept'); await act('RD', id, 'rd_send');
  await openAs('S', 'ได้รับสินค้าตัวอย่างจาก RD');
  await act('S', id, 'sales_receive'); await act('S', id, 'to_customer');
  await openAs('S', 'กรอก Feedback จากลูกค้า');
  await page.getByRole('button', { name: 'ผ่าน', exact: true }).click();
  await expect(page.locator('#ct')).toContainText('lot แรก + forecast');
  await page.fill('#npd-fl-kg', '100');
  await page.locator('[data-npd-m]').first().fill('300');
  await page.getByRole('button', { name: /ส่งให้ RD ทำ spec/ }).click();
  await expect(page.locator('#ct')).toContainText('RD ทำ spec + ทุน');
  await openAs('RD', 'RD ทำ Spec + ทุนเบื้องต้น');
  await attach('RD', id, 'rd_spec'); await act('RD', id, 'rd_spec'); await act('RD', id, 'rd_cost', { amount: 110 });
  await openAs('CA', 'บัญชีต้นทุนโรงงานคำนวณทุน');
  await act('CA', id, 'acct_cost', { amount: 118 });
  await openAs('S', 'เสนอราคาขายให้คุณโอ');
  expect(await page.evaluate(() => _npd.p.cost)).toBeUndefined();
  await act('S', id, 'price_propose', { price: 175 });
  await openAs('O', 'กำไรขั้นต้นประมาณ');
  await act('O', id, 'price_decide', { decision: 'approve' });
  await openAs('FA', 'เปิดรหัสสินค้าในระบบ');
  await page.fill('#npd-sku', 'NEW001');
  await page.getByRole('button', { name: /เปิดขายแล้ว/ }).click();
  await expect(page.locator('#ct')).toContainText('เปิดขายแล้ว รหัส NEW001');

  // แอดมินเห็นหน้าตั้งค่าผู้รับผิดชอบ
  await as(page, 'AD');
  await page.getByRole('button', { name: /ตั้งค่าผู้รับผิดชอบ/ }).click();
  await expect(page.locator('#ct')).toContainText('บัญชีโรงงาน (เปิดรหัสสินค้า)');
  expect(errors).toEqual([]);
});
