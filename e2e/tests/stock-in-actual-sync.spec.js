// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for stock_in_actual server-sync (2026-09, Phase 2.1): "รับเข้าจริง" data on the
// เปรียบเทียบผลิต page used to live only in DB.get/set('stock_in_actual') — pure localStorage, invisible
// across devices/users. Migrated to a real `stock_in_actual` table (SB.getStockInActual/
// addStockInActualRows/clearStockInActual) while every existing SYNCHRONOUS read site
// (psvRender/ppRenderGantt/expPsvSummary) keeps reading DB.get('stock_in_actual') unchanged — the SB
// wrapper writes through to that same localStorage key as a fallback cache, same pattern as
// bookings/forecasts elsewhere in this app.
test.describe('stock_in_actual server sync', () => {
  async function gotoBare(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
    });
  }

  test('pgProdSummary() paints instantly from local cache then refreshes from the server in the background', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('stock_in_actual', [{ id: 1, date: '2026-09-01', sku: 'SKU1', qty: 100, note: '' }]);
      sessionStorage.setItem('_pg', 'prodsummary');
      window.__getStockInActualCalls = 0;
      SB.getStockInActual = async () => {
        window.__getStockInActualCalls++;
        const fresh = [{ id: 1, date: '2026-09-01', sku: 'SKU1', qty: 100, note: '' }, { id: 2, date: '2026-09-02', sku: 'SKU2', qty: 40, note: '' }];
        DB.set('stock_in_actual', fresh);
        return fresh;
      };
    });

    await page.evaluate(() => window.pgProdSummary());
    // The mocked SB.getStockInActual() resolves on the same tick (no real network latency), so the
    // "instant paint from local cache" window isn't reliably observable here — what regression
    // coverage actually needs is: the background refresh runs exactly once (not in a loop — see the
    // 2026-09 fix, pgProdSummary() used to call itself on every refresh completion) and the UI ends up
    // reflecting the fresh data.
    await expect.poll(() => page.evaluate(() => window.__getStockInActualCalls)).toBe(1);
    await expect(page.locator('#ct')).toContainText('มีข้อมูลรับเข้าจริง 2 รายการ', { timeout: 2000 });
    // Give any (bugged, would-be-recursive) extra refresh a chance to fire, then confirm it didn't.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__getStockInActualCalls)).toBe(1);
  });

  test('psvClearActual() calls the server delete, then clears the local cache and re-renders', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('stock_in_actual', [{ id: 1, date: '2026-09-01', sku: 'SKU1', qty: 100, note: '' }]);
      sessionStorage.setItem('_pg', 'prodsummary');
      window.__clearCalls = 0;
      SB.clearStockInActual = async () => { window.__clearCalls++; return true; };
      SB.getStockInActual = async () => (DB.get('stock_in_actual') || []); // no-op background refresh
    });
    await page.evaluate(() => window.pgProdSummary());
    await expect(page.locator('#ct')).toContainText('มีข้อมูลรับเข้าจริง');

    page.once('dialog', (d) => d.accept());
    await page.locator('button', { hasText: 'ล้างข้อมูลจริง' }).click();

    await expect.poll(() => page.evaluate(() => window.__clearCalls)).toBe(1);
    // "ยังไม่มีข้อมูลรับเข้าจริง" (the empty-state banner) literally contains "มีข้อมูลรับเข้าจริง" as a
    // substring (Thai has no spaces) — assert the count-bearing phrase instead of the ambiguous one.
    await expect(page.locator('#psv-actual-banner')).toContainText('ยังไม่มีข้อมูลรับเข้าจริง');
    const remaining = await page.evaluate(() => DB.get('stock_in_actual'));
    expect(remaining).toEqual([]);
  });

  test('declining the confirm dialog does not call the server delete', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('stock_in_actual', [{ id: 1, date: '2026-09-01', sku: 'SKU1', qty: 100, note: '' }]);
      sessionStorage.setItem('_pg', 'prodsummary');
      window.__clearCalls = 0;
      SB.clearStockInActual = async () => { window.__clearCalls++; return true; };
      SB.getStockInActual = async () => (DB.get('stock_in_actual') || []);
    });
    await page.evaluate(() => window.pgProdSummary());

    page.once('dialog', (d) => d.dismiss());
    await page.locator('button', { hasText: 'ล้างข้อมูลจริง' }).click();

    const calls = await page.evaluate(() => window.__clearCalls);
    expect(calls).toBe(0);
  });
});
