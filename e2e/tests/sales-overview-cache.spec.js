// @ts-check
const { test, expect } = require('@playwright/test');

// Sales Overview (pgMySales) fetches whole-year sales data (current + prior year, for YoY) as raw
// transaction-level rows through the Cloudflare tunnel — a genuinely large, slow payload. Reported
// 2026-09-15: switching to the "Year" tab left the page stuck on a loading badge with nothing to
// show for a long time. Fixed with the same stale-while-revalidate pattern already used by
// pgProdSummary()/the Month view: paint instantly from a small locally-cached KPI snapshot (if this
// exact year+salesperson combo was ever loaded successfully before), then let the real fetch replace
// it in the background. This only speeds up a RETURN visit to a year already seen once — a genuinely
// first-ever load still has to wait for the real (slow) fetch, which these tests don't cover since
// there's nothing to instantly show yet.
test.describe('Sales Overview year-view cache (stale-while-revalidate)', () => {
  async function openPage(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      ROLE = 'superadmin'; UID = 'TESTUID'; CURRENT_USER = { uid: 'TESTUID', role: 'superadmin' };
      DB.set('users', [{ uid: 'TESTUID', name: 'Test Admin', role: 'superadmin' }]);
      // Never-resolving Supabase-shim client — proves the year KPI numbers below came from the
      // local cache snapshot, not from a fetch that (in this test) can never complete.
      window._realGetSupabaseClient = window.getSupabaseClient;
      window.getSupabaseClient = () => {
        const hang = () => new Promise(() => {});
        const chain = {
          select() { return chain; }, eq() { return chain; }, gte() { return chain; }, lte() { return chain; },
          order() { return chain; }, range() { return hang(); }, then(res) { return hang().then(res); },
        };
        return { from() { return chain; } };
      };
    });
    await page.evaluate(() => window.pgMySales());
  }

  test('switching to Year with no prior cache shows the loading badge and no KPI yet', async ({ page }) => {
    await openPage(page);
    await page.evaluate(() => window.sdSetPT('year'));
    await expect(page.getByText('Loading yearly sales...')).toBeVisible();
    await expect(page.locator('#sd-krow')).toBeEmpty();
  });

  test('switching to Year with a cached snapshot for that year paints the KPI instantly, before the (hanging) fetch could ever resolve', async ({ page }) => {
    await openPage(page);
    await page.evaluate(() => {
      // _sd.cy_y defaults to the current Buddhist year; _sdApiYear() = cy_y - 543. Cache key must match exactly.
      const gy = _sd.cy_y - 543;
      DB.set(`sd_year_cache_${gy}_ALL`, {
        total: 123456789, qty: 45678, invoices: 321, vs: 12,
        monthly: [{ ym: `${gy}-01`, total: 123456789, qty: 45678, invoices: 321 }],
        slmList: [], invoiceBased: false,
        custs: [{ c: 'C001', n: 'ลูกค้าทดสอบ', v: 123456789, q: 45678 }],
        prods: [], slms: [],
      });
    });
    await page.evaluate(() => window.sdSetPT('year'));
    // No waitForTimeout — if this only shows up after a delay, the cache-paint isn't actually synchronous.
    await expect(page.locator('#sd-krow')).toContainText('123,456,789');
    // The loading badge still shows — the real (hanging) fetch is genuinely still in flight in the
    // background, this is a stale-while-revalidate paint, not a claim that fresh data has arrived.
    await expect(page.getByText('Loading yearly sales...')).toBeVisible();
  });

  test('a cached snapshot for a DIFFERENT year is not shown — cache key is scoped per year', async ({ page }) => {
    await openPage(page);
    await page.evaluate(() => {
      const gy = _sd.cy_y - 543;
      DB.set(`sd_year_cache_${gy - 1}_ALL`, { // wrong year on purpose
        total: 999999999, qty: 1, invoices: 1, vs: 0, monthly: [], slmList: [], invoiceBased: false, custs: [], prods: [], slms: [],
      });
    });
    await page.evaluate(() => window.sdSetPT('year'));
    await expect(page.locator('#sd-krow')).toBeEmpty();
    await expect(page.locator('#sd-krow')).not.toContainText('999,999,999');
  });
});
