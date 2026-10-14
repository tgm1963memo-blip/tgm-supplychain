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
