// @ts-check
const { test, expect } = require('@playwright/test');

// "จัดการกลุ่ม" (Group Admin) > กลุ่มลูกค้า tab (_renderCustGroupsTable, index.html) had no e2e coverage
// at all before this file. Added 2026-09-15 after a real user report ("โหลดช้ามาก" — loads very slowly):
// traced it to salesOptionsHtml(c.slm) being called once PER CUSTOMER ROW inside the row-rendering
// loop, and salesOptionsHtml() itself calling salesMaster() — which rebuilds and re-sorts the entire
// sales list from 5 different data sources from scratch on every call. allCustomerRows() merges in two
// static, always-present data layers baked into this file (CUST_NAMES, PROD_CUST) alongside whatever is
// seeded for a test, so a fresh page here always renders ~900+ real rows regardless of what a test
// seeds — this suite intentionally never asserts an exact total row count, only that specific
// test-seeded rows (looked up by a code unlikely to collide with real data) behave correctly. A
// synthetic benchmark at a plausible scale (3000 customers x 60 salespeople) measured ~860ms -> ~16ms
// after hoisting the salesMaster() computation out of the loop (salesOptionsHtmlFromList(slms,
// selected) — slms computed once, reused per row).
test.describe('จัดการกลุ่ม (Group Admin) — กลุ่มลูกค้า tab', () => {
  async function openCustGroupsTab(page, { customers, profiles = {} } = {}) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ customers, profiles }) => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      DB.set('remote_customers_cache', customers);
      DB.set('customer_profiles', profiles);
      // avoid real network calls from renderCustGroups()'s SB.getCustomerProfiles()/getSalesmen() etc.
      SB.getCustomerProfiles = async () => ({});
      SB.getSalesmen = async () => ([]);
      SB.getSalesmenProfiles = async () => ({});
      SB.getCustomers = async () => ([]);
      // NOTE: _grpTab and _cgExtraCodes are both declared with top-level `let` in index.html's inline
      // <script> — a top-level `let`/`const` binding is NOT a property of `window` (unlike `var`/
      // function declarations), so `window._grpTab = ...`/`window._cgExtraCodes = ...` would silently
      // create unrelated properties instead of touching the real variables pgGroupAdmin()/
      // renderCustGroups() read. Assigning the bare identifiers works because page.evaluate's code runs
      // in the same global scope chain as the page's own top-level script. Getting _cgExtraCodes wrong
      // here matters a lot: renderCustGroups() checks `_cgExtraCodes instanceof Set` to decide whether
      // to skip a real network call (ensureExtraCustCodes()) — get it wrong and that call 401s with no
      // session token, and apiFetch's 401 handler re-hides #app / re-shows #ls, which is exactly why an
      // earlier version of this test saw rows render then immediately become unreachable ("hidden").
      _cgExtraCodes = new Set(); // pretend the async "extra codes from sales history" pass is already done
      _grpTab = 'cust';
      window.pgGroupAdmin();
    }, { customers, profiles });
    // renderCustGroups() awaits a couple of promises before its first render — wait for the table.
    await page.locator('#cg-tbody tr').first().waitFor({ timeout: 5000 });
  }

  test('a seeded customer renders its own row, and the GP% column is present', async ({ page }) => {
    await openCustGroupsTab(page, {
      customers: [
        { code: 'ZZTEST001', name: 'ลูกค้าทดสอบ A', cust_group: 'ขายจริง', slm_id: '103' },
        { code: 'ZZTEST002', name: 'ลูกค้าทดสอบ B', cust_group: 'ขายจริง', slm_id: '104' },
        { code: 'ZZTEST003', name: 'ลูกค้าทดสอบ C', cust_group: 'ขายจริง', slm_id: '' },
      ],
    });
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST001"]')).toHaveCount(1);
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST002"]')).toHaveCount(1);
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST003"]')).toHaveCount(1);
    await expect(page.locator('thead th', { hasText: 'GP% (ใบเคาะราคา)' })).toBeVisible();
  });

  // FIXED (2026-09-16, real production report: "จัดการกลุ่ม โหลดไม่ขึ้น" after a fresh restart with real
  // data — 15,291 customers): the Sales cell used to be a <select> with a full copy of every
  // salesperson's <option> duplicated PER ROW (~98 options x 15,291 rows = ~1.5M option elements) —
  // measured via a realistic-scale Node benchmark against the real row/salesperson counts (queried
  // read-only from the live DB) that this alone produced a ~78MB innerHTML string (~823ms just to
  // build the string, before the browser even parses/lays out that many nodes). Switched to a single
  // shared <datalist id="slm-list"> (built once, matching the existing corp-list/cat-list pattern
  // already used for the corporate/category columns) referenced by a lightweight <input list=...> per
  // row — same benchmark afterward: ~14MB, ~68ms. This test now checks the shared datalist + each
  // row's plain input value instead of a per-row <select>'s own <option> list.
  test('a seeded row\'s Sales cell uses the shared slm-list datalist (not a per-row duplicated <select>) and shows the right value', async ({ page }) => {
    await openCustGroupsTab(page, {
      customers: [
        { code: 'ZZTEST001', name: 'ลูกค้าทดสอบ A', cust_group: 'ขายจริง', slm_id: '103' },
        { code: 'ZZTEST002', name: 'ลูกค้าทดสอบ B', cust_group: 'ขายจริง', slm_id: '104' },
      ],
    });
    // SLM_IDS is a built-in constant (13 codes) always present regardless of seeded data — the ONE
    // shared datalist must contain all of them, and no row should render its own <select>/<option> list.
    await expect(page.locator('#cg-tbody select')).toHaveCount(0);
    const datalistValues = await page.locator('#slm-list option').evaluateAll(els => els.map(e => e.getAttribute('value')));
    expect(datalistValues).toContain('103');
    expect(datalistValues).toContain('104');
    expect(datalistValues.length).toBeGreaterThanOrEqual(13); // 13 built-in SLM_IDS, no placeholder needed for a plain input

    const row1Input = page.locator('#cg-tbody tr[data-0="ZZTEST001"] input[list="slm-list"]');
    const row2Input = page.locator('#cg-tbody tr[data-0="ZZTEST002"] input[list="slm-list"]');
    await expect(row1Input).toHaveValue('103');
    await expect(row2Input).toHaveValue('104');
  });

  test('GP% input pre-fills from customer_profiles.gp_pct and saves via saveCustomerGroup on change', async ({ page }) => {
    await openCustGroupsTab(page, {
      customers: [{ code: 'ZZTEST001', name: 'ลูกค้าทดสอบ A', cust_group: 'ขายจริง', slm_id: '103' }],
      profiles: { ZZTEST001: { corporate: 'กลุ่มทดสอบ', name: 'ลูกค้าทดสอบ A', gp_pct: 18 } },
    });
    const gpInput = page.locator('#cg-tbody tr[data-0="ZZTEST001"] input[type="number"]');
    await expect(gpInput).toHaveValue('18');

    await page.evaluate(() => { window.__saveCalls = []; window.saveCustomerGroup = (code, field, val) => window.__saveCalls.push([code, field, val]); });
    await gpInput.fill('25');
    await gpInput.blur();
    const saveCalls = await page.evaluate(() => window.__saveCalls);
    expect(saveCalls).toContainEqual(['ZZTEST001', 'gp_pct', '25']);
  });

  // FIXED (2026-09-16, /code-review — confirmed real): confirmCustomerGroup() used to call
  // renderCustGroups(), which unconditionally re-awaits a full paginated SB.getCustomerProfiles()
  // fetch of the ENTIRE table just to reflect one row's confirmed status. The "🤖 ให้ AI ช่วยจัดกลุ่ม"
  // review workflow is built around confirming many rows back-to-back, so every click re-downloaded
  // the whole table. Fixed to re-render from the already-updated in-memory profs object directly,
  // matching saveCustomerGroup()'s existing no-refetch pattern right above it.
  test('confirming an AI-suggested group does not re-fetch the whole customer_profiles table', async ({ page }) => {
    await openCustGroupsTab(page, {
      customers: [{ code: 'ZZTEST001', name: 'ลูกค้าทดสอบ A', cust_group: 'ขายจริง', slm_id: '103' }],
      profiles: { ZZTEST001: { code: 'ZZTEST001', corporate: 'กลุ่มที่ AI แนะนำ', corp_confirmed: 0, corp_confidence: 0.9 } },
    });
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST001"]')).toContainText('AI แนะนำ');

    await page.evaluate(() => { window.__getProfilesCalls = 0; SB.getCustomerProfiles = async () => { window.__getProfilesCalls++; return {}; }; });
    await page.locator('#cg-tbody tr[data-0="ZZTEST001"] button', { hasText: 'ยืนยัน' }).click();

    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST001"]')).toContainText('ยืนยันแล้ว');
    expect(await page.evaluate(() => window.__getProfilesCalls)).toBe(0); // no re-fetch — re-rendered from local state
    const profs = await page.evaluate(() => DB.get('customer_profiles'));
    expect(profs.ZZTEST001.corp_confirmed).toBe(1);
  });

  test('the search filter still narrows rows after the salesOptionsHtml refactor', async ({ page }) => {
    await openCustGroupsTab(page, {
      customers: [
        { code: 'ZZTEST001', name: 'ลูกค้าทดสอบเดอะมอลล์', cust_group: 'ขายจริง', slm_id: '103' },
        { code: 'ZZTEST002', name: 'ลูกค้าทดสอบบิ๊กซี', cust_group: 'ขายจริง', slm_id: '104' },
      ],
    });
    await page.fill('#cg-q', 'ZZTEST001');
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST001"]')).toBeVisible();
    await expect(page.locator('#cg-tbody tr[data-0="ZZTEST002"]')).toBeHidden();
    await expect(page.locator('#cg-count')).toHaveText('1 ลูกค้า');
  });
});

// จัดการกลุ่ม > กลุ่มสินค้า tab (renderProdGroups, index.html) — same root-cause bug as the กลุ่มลูกค้า
// tab above, found by a follow-up search after that fix (2026-09-16): the "เพิ่ม SKU" cell in the
// "จัดการกลุ่ม" sub-tab rendered a <select> with a full copy of getSkusMerged()'s ENTIRE product list
// (~3,870 real products) duplicated PER PRODUCT-GROUP ROW. Fixed the same way — one shared
// <datalist id="pg-sku-list"> built once, referenced by a lightweight <input list="pg-sku-list"> per row.
test.describe('จัดการกลุ่ม (Group Admin) — กลุ่มสินค้า tab', () => {
  async function openProdGroupsTab(page, { skus, groups = {} } = {}) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ skus, groups }) => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      DB.set('remote_products_cache', skus);
      DB.set('product_groups', groups);
      // ensureGroupProductsLoaded() (called fire-and-forget from renderProdGroups()) skips its real
      // network refetch only when remote_products_cache already has >100 rows — with a small seeded
      // test list it would otherwise fire a real, unstubbed SB.getProducts() call in the background
      // and 401 (same class of issue documented for _cgExtraCodes above).
      DB.set('remote_products_loaded', true);
      SB.getProducts = async () => skus;
      _grpTab = 'prod'; // bare identifier — see the note on _grpTab/_cgExtraCodes in the tests above
      _pgItemTab = 'groups';
      window.pgGroupAdmin();
    }, { skus, groups });
    await page.locator('#pg-content table').first().waitFor({ timeout: 5000 });
  }

  test('the "เพิ่ม SKU" cell uses the shared pg-sku-list datalist (not a per-row duplicated <select>), and adding a SKU still works', async ({ page }) => {
    await openProdGroupsTab(page, {
      skus: [
        { code: 'ZZSKU001', name: 'สินค้าทดสอบ A' },
        { code: 'ZZSKU002', name: 'สินค้าทดสอบ B' },
      ],
      groups: { 'กลุ่มทดสอบ': [] },
    });
    await expect(page.locator('#pg-content table select')).toHaveCount(0);
    const datalistValues = await page.locator('#pg-sku-list option').evaluateAll(els => els.map(e => e.getAttribute('value')));
    expect(datalistValues).toContain('ZZSKU001');
    expect(datalistValues).toContain('ZZSKU002');

    // productGroups() merges the seeded custom group in with this app's real baked-in base groups
    // (SKU_GROUPS), so several other "+ เพิ่ม" rows exist too — scope to the row containing this
    // specific input rather than risk clicking an unrelated group's button.
    const input = page.locator('#pg-sku-กลุ่มทดสอบ');
    await input.fill('ZZSKU001');
    await input.locator('xpath=ancestor::tr').locator('button', { hasText: '+ เพิ่ม' }).click();
    const groups = await page.evaluate(() => DB.get('product_groups'));
    expect(groups['กลุ่มทดสอบ']).toContain('ZZSKU001');
  });
});
