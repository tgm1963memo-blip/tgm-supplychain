// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for ppLinkToWMS() (2026-09 fix): this used to be a pure stub — console.log a
// fake stockEntry object, then show a toast claiming "ส่งข้อมูลการผลิตไป WMS" (sent to WMS) when
// NOTHING was actually sent anywhere. There is no write-path into tgm-wms from this repo (it only
// reads over HTTP), so the fix records the completed production lot into this app's own `stock_lots`
// table instead (via a new SB.addStockLot wrapper) and changes the toast to say that honestly —
// including that the warehouse still has to key the physical receipt into WMS separately.
test.describe('ppLinkToWMS honesty fix', () => {
  async function gotoBare(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
    });
  }

  test('successful save records a stock_lots row and shows an honest toast (not a WMS-success claim)', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      window.__addStockLotCalls = [];
      SB.addStockLot = async (row) => { window.__addStockLotCalls.push(row); return true; };
    });

    await page.evaluate(() => {
      window.ppLinkToWMS({ id: 'PRD1', sku: 'SKU1', qty: 100, line: 'Line A', note: 'ทดสอบ' });
    });

    const toast = page.locator('body > div', { hasText: 'บันทึกล็อตผลิตเสร็จ' });
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toContainText('SKU1');
    await expect(toast).toContainText('คีย์รับเข้า WMS เอง');
    await expect(toast).not.toContainText('ส่งไป WMS');
    await expect(toast).not.toContainText('ส่งข้อมูลการผลิตไป WMS');

    const calls = await page.evaluate(() => window.__addStockLotCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].sku).toBe('SKU1');
    expect(calls[0].qty).toBe(100);
    expect(calls[0].lotNo).toBe('PROD-PRD1');
  });

  test('a failed save shows a warning toast, not a false success claim', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      SB.addStockLot = async () => false;
    });

    await page.evaluate(() => {
      window.ppLinkToWMS({ id: 'PRD2', sku: 'SKU2', qty: 50, line: '', note: '' });
    });

    const toast = page.locator('body > div', { hasText: 'ไม่สำเร็จ' });
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toContainText('SKU2');
  });
});
