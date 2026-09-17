// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for the "Top 10 ลูกค้า" Dashboard card reported showing one row
// "ยังไม่ถูกระบุ" (UNASSIGNED_CORP_LABEL) holding 100% of revenue (2026-09-16). Root cause was two
// separate bugs, not the customer_profiles-cache-staleness bug fixed earlier the same day:
//   1) dashTopTables() built the customer table from window._dashSalesRows — the same rollup
//      ("Top 10 สินค้า" uses too) sourced from v_sc_dashboard_sales_monthly, which has NO cust_code
//      column at all (company+product+month grain only) — every row fell into the fallback bucket
//      regardless of customer_profiles data. Fixed by giving the customer table its own source,
//      window._dashCustRows (loadDashboardCustRows(), from v_sales_overview_sales_monthly via the
//      existing _sbSalesOverviewAggRows()), which does carry real cust_code.
//   2) _sdBuildCusts()/_sdBuildSlms()/_sdBuildProds() re-derived the corp group from the client's own
//      local customer_profiles cache via customerGroupForCode() even for rows that already carry a
//      real, SQL-joined group (_sbSalesOverviewAggRows() rows, flagged srv_corp:true) — ignoring work
//      the server already did, and fragile (depends on that client cache being fresh). Fixed by
//      trusting r.cust_group when r.srv_corp is set.
test.describe('Dashboard "Top 10 ลูกค้า" customer-grouping fix', () => {
  async function gotoBare(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window.ROLE = 'superadmin';
      window.UID = 'TESTUID';
      window.UNAME = 'Test User';
      DB.set('customer_profiles', {}); // deliberately empty — proves the fix doesn't need this cache
    });
  }

  test('_sdBuildCusts() trusts a server-joined cust_group (srv_corp:true) instead of falling back to UNASSIGNED_CORP_LABEL', async ({ page }) => {
    await gotoBare(page);
    const rows = [{
      cust_code: 'C001', cust_name: 'ลูกค้าทดสอบ A', cust_group: 'Group A', category: 'ขายจริง',
      srv_corp: true, amount: 1000, qty: 10, slm_id: 'S1', prod_code: 'P1', prod_name: 'สินค้า P1', prod_group: '001',
    }];
    const grp = await page.evaluate((r) => window._sdBuildCusts(r)[0]?.grp, rows);
    expect(grp).toBe('Group A');
  });

  test('_sdBuildCusts() still falls back to UNASSIGNED_CORP_LABEL for rows without srv_corp (regression guard for other call sites)', async ({ page }) => {
    await gotoBare(page);
    const rows = [{
      cust_code: 'C002', cust_name: 'ลูกค้าทดสอบ B', cust_group: 'ขายจริง', // _sbSalesRows()-style sale-type flag, not a real group
      amount: 1000, qty: 10, slm_id: 'S1', prod_code: 'P1', prod_name: 'สินค้า P1', prod_group: '001',
    }];
    const grp = await page.evaluate((r) => window._sdBuildCusts(r)[0]?.grp, rows);
    // UNASSIGNED_CORP_LABEL is declared `const` at top level — not attached to `window`, hardcode
    // its known value (index.html: const UNASSIGNED_CORP_LABEL='ยังไม่ถูกระบุ';) rather than reference it.
    expect(grp).toBe('ยังไม่ถูกระบุ');
  });

  test('dashTopTables() reads the customer table from window._dashCustRows, not the product-only window._dashSalesRows', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      document.getElementById('ct').innerHTML = '<div id="dash-top-prod"></div><div id="dash-top-cust"></div>';
      // Mirrors _sbDashboardSalesAggRows()'s real shape: no cust_code at all.
      window._dashSalesRows = [
        { cust_code: '', cust_name: '', slm_id: '', amount: 500, qty: 5, prod_code: 'P1', prod_name: 'สินค้า P1', prod_group: '001' },
      ];
      // Mirrors _sbSalesOverviewAggRows()'s real shape: real cust_code + srv_corp.
      window._dashCustRows = [
        { cust_code: 'C001', cust_name: 'ลูกค้าทดสอบ A', cust_group: 'Group A', category: 'ขายจริง', srv_corp: true, amount: 900, qty: 9, slm_id: 'S1', prod_code: 'P1', prod_name: 'สินค้า P1', prod_group: '001' },
        { cust_code: 'C002', cust_name: 'ลูกค้าทดสอบ B', cust_group: 'Group B', category: 'ขายจริง', srv_corp: true, amount: 100, qty: 1, slm_id: 'S1', prod_code: 'P2', prod_name: 'สินค้า P2', prod_group: '001' },
      ];
      window.dashTopTables();
    });
    // Customer card: real corp-group buckets, not the 100% "ยังไม่ถูกระบุ" bucket this bug produced
    // (_sdBuildCusts()'s top level is the corp-group, not the individual customer — same hierarchy
    // Sales Overview's "รายลูกค้า" tab shows).
    await expect(page.locator('#dash-top-cust')).not.toContainText('ยังไม่ถูกระบุ');
    await expect(page.locator('#dash-top-cust')).toContainText('Group A');
    await expect(page.locator('#dash-top-cust')).toContainText('Group B');
    await expect(page.locator('#dash-top-cust')).toContainText('90%'); // 900 / (900+100)
    // Product card: unaffected, still reads window._dashSalesRows as before.
    await expect(page.locator('#dash-top-prod')).toContainText('สินค้า P1');
  });
});
