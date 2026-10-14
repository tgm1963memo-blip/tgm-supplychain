// @ts-check
const { test, expect } = require('@playwright/test');

// Sales Overview (2026-10-14, ผู้ใช้แจ้ง): กด expand แล้วตารางเด้งกลับรายการแรก (sdRender วาดกล่อง scroll ใหม่)
// + Top 10 สินค้าเปลี่ยนจากกล่องแทรกในตารางเป็นปุ่ม → popup
test.describe('Sales Overview expand keeps scroll + Top 10 popup', () => {
  async function openWithData(page) {
    // ไม่ให้เรียก API จริง (ไม่มีเซสชัน → 401 → เด้งไปหน้า login)
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      ROLE = 'superadmin'; UID = 'TESTUID'; CURRENT_USER = { uid: 'TESTUID', role: 'superadmin' };
      window.sdLoad = async () => {}; // ไม่ดึงข้อมูลจริง
    });
    await page.evaluate(() => window.pgMySales());
    await page.waitForTimeout(1500); // ให้การโหลดตอนเปิดหน้า (API จำลองว่าง) จบก่อน แล้วค่อยใส่ข้อมูลทดสอบ
    await page.evaluate(() => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        cust_code: 'T-' + i, cust_name: 'สาขา ' + i, cust_group: 'กลุ่มทดสอบ ' + i, category: 'ขายจริง', srv_corp: true,
        amount: 100000 - i * 100, qty: 5, slm_id: 'S1', prod_code: 'P' + i, prod_name: 'สินค้า ' + i, prod_group: '002', ym: '2026-10',
      }));
      Object.assign(_sdApi, { loaded: true, invoiceBased: true, _rows: rows, _buildCacheKey: '', _buildCache: {}, total: 1, monthly: [] });
      _sdEnsureBuilt('cust');
      const tab = [...document.querySelectorAll('#sd-root .tab')].find((e) => e.textContent.trim() === 'รายลูกค้า');
      _sd.mgrView = true; delete _sdPv.cust;
      try { sdTab(tab, 'cust'); _sdApi.loaded = true; _sdEnsureBuilt('cust'); sdRender(); } catch (e) { window.__err = String(e); }
    });
  }

  test('expanding a row deep in the table keeps the scroll position', async ({ page }) => {
    await openWithData(page);
    expect(await page.evaluate(() => window.__err || '')).toBe('');
    const tw = page.locator('#sd-ta .tw');
    await expect(tw).toBeVisible();
    await tw.evaluate((el) => { el.scrollTop = 900; });
    const before = await tw.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(300);
    await page.locator('#sd-ta strong', { hasText: /^กลุ่มทดสอบ 30$/ }).click();
    const after = await page.locator('#sd-ta .tw').evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(5);
    await expect(page.getByText('สาขา 30', { exact: false }).first()).toBeVisible();
  });

  test('Top 10 is a button that opens a popup, not a box inside the table', async ({ page }) => {
    await openWithData(page);
    await page.locator('#sd-ta strong', { hasText: /^กลุ่มทดสอบ 3$/ }).click(); // เปิดกลุ่ม → ไม่มีกล่อง Top 10 ในตาราง
    await expect(page.locator('#sd-ta').getByText('Top 10 สินค้าขายดี')).toHaveCount(0);
    await page.locator('#sd-ta tr', { has: page.locator('strong', { hasText: /^กลุ่มทดสอบ 3$/ }) }).getByRole('button', { name: /Top 10/ }).click();
    const modal = page.locator('#sd-top10-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('กลุ่มทดสอบ 3');
    await expect(modal.getByText(/ไม่มีรายการสินค้า|กำลังโหลด/)).toBeVisible();
  });
});

// (2026-10-14) ลากชิป "แสดงตาม" เรียงลำดับ + profiles โหลดเสร็จทีหลังแล้วกลุ่มไม่ค้างเป็น "ยังไม่ถูกระบุ"
test.describe('Sales Overview pivot drag + late profiles', () => {
  test('dragging a pivot chip onto another moves it to that position', async ({ page }) => {
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      document.body.insertAdjacentHTML('beforeend', '<div id="pvbar" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#fff"></div>');
      window._sdPv = {}; // ensure default
      document.getElementById('pvbar').innerHTML = _sdPivotBar('cust');
      window.sdRender = () => { document.getElementById('pvbar').innerHTML = _sdPivotBar('cust'); };
    });
    await page.waitForTimeout(800); // ให้หน้าแรกของแอป render เสร็จก่อน ไม่ให้ layout ขยับระหว่างลาก
    const chip = (label) => page.locator('#pvbar > div > span[draggable]', { hasText: label });
    await chip('Category (Sales)').dragTo(chip('บริษัท / กลุ่มลูกค้า'));
    expect(await page.evaluate(() => _sdPv.cust)).toEqual(['cat', 'corp', 'branch', 'pgrp', 'prod']);
    await chip('สินค้า').filter({ hasNotText: 'กลุ่มสินค้า' }).dragTo(chip('สาขา / ลูกค้า'));
    expect(await page.evaluate(() => _sdPv.cust)).toEqual(['cat', 'corp', 'prod', 'branch', 'pgrp']);
  });

  test('profiles arriving after Sales Overview was built clear the stale grouping', async ({ page }) => {
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const res = await page.evaluate(async () => {
      DB.set('customer_profiles', {}); // cache ว่างตอนสร้างตาราง
      _sdApi._buildCache = { custs: [{ n: 'ยังไม่ถูกระบุ' }] }; _sdApi._buildCacheKey = 'x'; _sdApi.loaded = true;
      let reloaded = false; window.pgMySales = () => { reloaded = true; };
      document.body.insertAdjacentHTML('beforeend', '<div id="sd-ta"></div>');
      SB.getCustomers = async () => []; SB.getConsiCustomerRows = async () => [];
      SB.getCustomerProfiles = async () => { const p = { 'C-1': { code: 'C-1', corporate: 'Minor Group' } }; DB.set('customer_profiles', p); return p; };
      refreshSharedMasterData({ profileDelay: 0 });
      await new Promise((r) => setTimeout(r, 300));
      return { reloaded, built: Object.keys(_sdApi._buildCache).length, loaded: _sdApi.loaded, corp: customerGroupForCode('C-1') };
    });
    expect(res).toEqual({ reloaded: true, built: 0, loaded: false, corp: 'Minor Group' });
  });
});

// (2026-10-14) ปุ่มขยาย / ย่อทั้งหมด + hover แถวหัวข้อพื้นเข้มยังอ่านออก
test.describe('Sales Overview expand/collapse all', () => {
  test('expand all opens every level, collapse all closes them', async ({ page }) => {
    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      ROLE = 'superadmin'; UID = 'TESTUID'; CURRENT_USER = { uid: 'TESTUID', role: 'superadmin' };
      window.sdLoad = async () => {};
    });
    await page.evaluate(() => window.pgMySales());
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      // มุมมองเลือกมิติ: ข้อมูลจาก /api/invoice_detail/pivot (ใส่ cache ตรงๆ) — กลุ่ม › สาขา › สินค้า
      const p = _sdInvPeriod();
      _sdPvData[[p.from, p.to, ''].join('|')] = { loading: false, rows: [
        { c: 'T-1', s: 'S1', k: 'P1', n: 'สินค้า 1', g: '002', q: 1, a: 100 },
        { c: 'T-2', s: 'S1', k: 'P2', n: 'สินค้า 2', g: '003', q: 1, a: 50 },
      ] };
      const rows = [
        { cust_code: 'T-1', cust_name: 'สาขา 1', cust_group: 'กลุ่ม A', category: 'ขายจริง', srv_corp: true, amount: 100, qty: 1, slm_id: 'S1', prod_code: 'P1', prod_name: 'สินค้า 1', prod_group: '002', ym: '2026-10' },
        { cust_code: 'T-2', cust_name: 'สาขา 2', cust_group: 'กลุ่ม B', category: 'ขายจริง', srv_corp: true, amount: 50, qty: 1, slm_id: 'S1', prod_code: 'P2', prod_name: 'สินค้า 2', prod_group: '003', ym: '2026-10' },
      ];
      Object.assign(_sdApi, { loaded: true, invoiceBased: true, _rows: rows, _buildCacheKey: '', _buildCache: {}, total: 150, monthly: [] });
      _sd.mgrView = true; _sdPv.cust = ['corp', 'branch', 'prod'];
      const tab = [...document.querySelectorAll('#sd-root .tab')].find((e) => e.textContent.trim() === 'รายลูกค้า');
      sdTab(tab, 'cust'); _sdApi.loaded = true; _sdEnsureBuilt('cust'); _sdPv.cust = ['corp', 'branch', 'prod']; sdRender();
    });
    const ta = page.locator('#sd-ta');
    await expect(ta.getByText('P1 — สินค้า 1')).toHaveCount(0);
    await page.getByRole('button', { name: /ขยายทั้งหมด/ }).click();
    await expect(ta.getByText('P1 — สินค้า 1')).toBeVisible();
    await expect(ta.getByText('P2 — สินค้า 2')).toBeVisible();
    await page.getByRole('button', { name: /ย่อทั้งหมด/ }).click();
    await expect(ta.getByText('P1 — สินค้า 1')).toHaveCount(0);
    await expect(ta.getByText('สาขา 1')).toHaveCount(0);
  });

  test('hovering a dark header row keeps a dark background', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const bg = await page.evaluate(() => {
      document.getElementById('ls').classList.add('hidden');
      document.body.insertAdjacentHTML('beforeend', '<table id="hv" style="position:fixed;top:0;left:0;z-index:99999"><tr style="cursor:pointer;background:var(--N);color:#fff"><td>หัวข้อ</td></tr></table>');
      return null;
    });
    await page.locator('#hv td').hover();
    const color = await page.locator('#hv td').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(color).toBe('rgb(43, 76, 126)');
  });
});
