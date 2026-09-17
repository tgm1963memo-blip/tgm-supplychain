// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for the เอกสารโปรโมชัน (promo history) page's filter UI.
//
// History: typing into the old plain-text customer/product search boxes used to call the full
// promoRender() on every keystroke, replacing the entire #ct subtree (including the <input> being
// typed into) and dropping focus ("only one character typed at a time"). Those two boxes were
// replaced entirely (2026-08-26) by a multi-select checklist filter (promoMsButton/promoMsItems/
// promoMsSearch/promoMsToggle). That filter went through two behavior revisions the same day:
// v1 had typing only narrow the visible checklist (all matches still "included" until manually
// unchecked one by one) — real user feedback was that this isn't how Excel's autofilter search
// works and didn't actually narrow the table. v2 (current) has typing auto-select ONLY the matches,
// excluding everything else automatically, same as Excel. This still guards the original focus bug —
// promoMsSearch() only touches the panel's own #...-list div, the button's #...-label span, and a
// debounced table re-render, never the search <input> itself — and covers the create_date/doc_ref
// columns and ประเภท/บริษัท filters added the same day.
test.describe('promo history filters', () => {
  test('typing in a filter search box does not replace the input node (focus survives a keystroke)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.evaluate(() => {
      // #app starts with class="hidden" until a real login succeeds — remove it so the rendered
      // content (built directly via promoRender(), bypassing login) is actually visible/interactable.
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window._promoDocs = Array.from({ length: 500 }, (_, i) => ({
        company: i % 2 ? 'CONSI' : 'TSS',
        sonum: 'P1' + (10000 + i),
        cust_code: 'C' + i,
        cust_name: 'ลูกค้า ' + i,
        sku: 'SKU' + i,
        sku_name: 'สินค้า ' + i,
        unit_price: 10 + i,
        start_date: '2026-01-01',
        due_date: '2026-12-31',
        create_date: '2026-01-01',
        doc_ref: 'REF' + i,
        docstat: i % 2 ? 'N' : 'M',
      }));
      window.promoRender();
    });

    await page.locator('#promo-ms-cust > button').click();
    const input = page.locator('#promo-ms-cust-q');
    await expect(input).toBeVisible();

    // Grab a handle to the exact DOM node before typing.
    const before = await input.evaluateHandle(el => el);
    await input.type('C1', { delay: 20 });
    const after = await input.evaluateHandle(el => el);
    const sameNode = await page.evaluate(([a, b]) => a === b, [before, after]);
    expect(sameNode).toBe(true);

    // The characters actually landed in the field (this is what "types one letter at a time" broke).
    await expect(input).toHaveValue('C1');
  });

  test('typing a query auto-selects only the matches (Excel autofilter behavior), and manually unchecking narrows further', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window._promoDocs = [
        { company: 'TSS', sonum: 'P1A', cust_code: 'C001', cust_name: 'ร้านเอ', sku: 'X1', sku_name: 'สินค้าเอ', unit_price: 10, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-01', doc_ref: 'REF-A', docstat: 'M' },
        { company: 'CONSI', sonum: 'P1B', cust_code: 'C002', cust_name: 'ร้านบี', sku: 'X2', sku_name: 'สินค้าบี', unit_price: 20, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-02', doc_ref: 'REF-B', docstat: 'N' },
      ];
      window.promoRender();
    });

    await expect(page.locator('#promo-tbody tr')).toHaveCount(2);

    // Open the customer filter panel and search for one of the two customers.
    await page.locator('#promo-ms-cust > button').click();
    await page.locator('#promo-ms-cust-q').fill('C001');

    const item = page.locator('#promo-ms-cust-list .ms-item', { hasText: 'C001' });
    await expect(item).toBeVisible();
    await expect(item.locator('input[type="checkbox"]')).toBeChecked(); // the match itself stays checked

    // Typing alone (no manual click) already narrows the table to just the match — this is the
    // Excel-style behavior; the old design required an explicit uncheck of every OTHER item instead.
    await page.waitForTimeout(300); // past the 200ms debounce
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
    await expect(page.locator('#promo-tbody')).toContainText('ร้านเอ');
    await expect(page.locator('#promo-tbody')).not.toContainText('ร้านบี');

    // Manually unchecking the (only) shown match excludes it too, on top of the search — leaving
    // zero real rows (the table renders one placeholder <tr> for "ไม่พบข้อมูล", not zero <tr>s).
    await item.locator('span').click();
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
    await expect(page.locator('#promo-tbody')).toContainText('ไม่พบข้อมูล');
  });

  test('the new document creation-date and reference columns render', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window._promoDocs = [
        { company: 'TSS', sonum: 'P1A', cust_code: 'C001', cust_name: 'ร้านเอ', sku: 'X1', sku_name: 'สินค้าเอ', unit_price: 10, start_date: '2026-07-25', due_date: '2026-08-18', create_date: '2026-07-25', doc_ref: '7538  V', docstat: 'M' },
      ];
      window.promoRender();
    });
    const row = page.locator('#promo-tbody tr').first();
    await expect(row).toContainText('P1A');
    await expect(row).toContainText('7538  V');
    await expect(row).toContainText('2569'); // Buddhist-era year from promoFmtD, on the create_date cell
  });

  test('the ประเภท column and filter classify "compensate" reference text, filterable separately from the raw reference text', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window._promoDocs = [
        { company: 'TSS', sonum: 'P1A', cust_code: 'C001', cust_name: 'ร้านเอ', sku: 'X1', sku_name: 'สินค้าเอ', unit_price: 10, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-01', doc_ref: '8143  V  compensate..', docstat: 'M' },
        { company: 'TSS', sonum: 'P1B', cust_code: 'C002', cust_name: 'ร้านบี', sku: 'X2', sku_name: 'สินค้าบี', unit_price: 20, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-02', doc_ref: '7538  V', docstat: 'M' },
      ];
      window.promoRender();
    });

    await expect(page.locator('#promo-tbody tr')).toHaveCount(2);
    await expect(page.locator('#promo-tbody tr').nth(0)).toContainText('Compensate');
    await expect(page.locator('#promo-tbody tr').nth(1)).toContainText('ปกติ');

    // Filter down to compensate-only via the ประเภท checklist.
    await page.locator('#promo-ms-type > button').click();
    const normalItem = page.locator('#promo-ms-type-list .ms-item', { hasText: 'ปกติ' });
    await expect(normalItem).toBeVisible();
    await normalItem.locator('span').click(); // uncheck "ปกติ" -> only compensate rows remain

    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
    await expect(page.locator('#promo-tbody')).toContainText('ร้านเอ');
    await expect(page.locator('#promo-tbody')).not.toContainText('ร้านบี');
  });

  test('all filtered rows render (no 300-row cap), and the company filter narrows correctly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      // 400 rows -> exceeds the old PROMO_ROW_CAP of 300, split across both companies.
      window._promoDocs = Array.from({ length: 400 }, (_, i) => ({
        company: i % 4 === 0 ? 'CONSI' : 'TSS',
        sonum: 'P1' + (20000 + i),
        cust_code: 'C' + i,
        cust_name: 'ลูกค้า ' + i,
        sku: 'SKU' + i,
        sku_name: 'สินค้า ' + i,
        unit_price: 10 + i,
        start_date: '2026-01-01',
        due_date: '2026-12-31',
        create_date: '2026-01-01',
        doc_ref: 'REF' + i,
        docstat: 'M',
      }));
      window.promoRender();
    });

    await expect(page.locator('#promo-tbody tr')).toHaveCount(400);

    await page.locator('#promo-ms-company > button').click();
    const tssItem = page.locator('#promo-ms-company-list .ms-item', { hasText: 'TSS' });
    await expect(tssItem).toBeVisible();
    await tssItem.locator('span').click(); // uncheck TSS -> only CONSI rows remain (400/4 = 100)

    await expect(page.locator('#promo-tbody tr')).toHaveCount(100);
  });

  test('defaults to the current year (create_date) on load; ล้างตัวกรอง preserves that scope; an empty range warns before an unbounded reload', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      const y = new Date().getFullYear();
      window._promoDocs = [
        { company: 'TSS', sonum: 'P1THIS', cust_code: 'C001', cust_name: 'ร้านปีนี้', sku: 'X1', sku_name: 'สินค้าเอ', unit_price: 10, start_date: `${y}-01-01`, due_date: `${y}-06-01`, create_date: `${y}-03-15`, doc_ref: 'REF-A', docstat: 'M' },
        { company: 'TSS', sonum: 'P1OLD', cust_code: 'C002', cust_name: 'ร้านปีก่อน', sku: 'X2', sku_name: 'สินค้าบี', unit_price: 20, start_date: `${y - 2}-01-01`, due_date: `${y - 2}-06-01`, create_date: `${y - 2}-03-15`, doc_ref: 'REF-B', docstat: 'M' },
      ];
      // Simulate a real pgPromoHistory() load having already scoped the fetch to the current year
      // (create_date is a server-side filter now — see SB.getPromoDocs()) so this test's interactions
      // with the date fields don't try a real network fetch through promoApplyDateRange().
      window._promoLoadedRange = { from: `${y}-01-01`, to: `${y}-12-31` };
      window.promoRender();
    });

    // The date-range inputs come pre-filled with Jan 1 - Dec 31 of the current year (this is the
    // actual mechanism, not just a display default — _promo.createFrom/createTo drive filtering from
    // the moment the script loads, before pgPromoHistory() or any button click runs).
    const y = new Date().getFullYear();
    await expect(page.locator('#promo-create-from')).toHaveValue(`${y}-01-01`);
    await expect(page.locator('#promo-create-to')).toHaveValue(`${y}-12-31`);

    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
    await expect(page.locator('#promo-tbody')).toContainText('ร้านปีนี้');
    await expect(page.locator('#promo-tbody')).not.toContainText('ร้านปีก่อน');
    await expect(page.locator('#promo-notice')).toContainText('ปีปัจจุบัน');

    // "ล้างตัวกรอง" clears the checklist/validity filters but deliberately leaves the create_date
    // range untouched — that range now drives a real server fetch (SB.getPromoDocs), so a routine
    // "clear filters" click must not silently trigger a full all-years reload. Locate by the exact
    // onclick, not text, since the per-field panels also have a "ล้างตัวกรองนี้" button whose text
    // contains this same substring and would otherwise match too (strict-mode violation).
    await page.locator('button[onclick="promoClear()"]').click();
    await expect(page.locator('#promo-create-from')).toHaveValue(`${y}-01-01`);
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);

    // Manually blanking both create-date inputs and applying warns (confirm()) before an unbounded
    // reload; dismissing it must leave the currently-loaded data/range untouched.
    await page.locator('#promo-create-from').fill('');
    await page.locator('#promo-create-to').fill('');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('button[onclick="promoApplyDateRange()"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
  });

  test('pressing Enter or clicking ตกลง in a filter search box applies immediately (not waiting for the debounce) and closes the panel', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window._promoDocs = [
        { company: 'TSS', sonum: 'P1A', cust_code: 'C001', cust_name: 'ร้านเอ', sku: 'X1', sku_name: 'สินค้าเอ', unit_price: 10, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-01', doc_ref: 'REF-A', docstat: 'M' },
        { company: 'TSS', sonum: 'P1B', cust_code: 'C002', cust_name: 'ร้านบี', sku: 'X2', sku_name: 'สินค้าบี', unit_price: 20, start_date: '2026-01-01', due_date: '2026-06-01', create_date: '2026-01-02', doc_ref: 'REF-B', docstat: 'M' },
      ];
      window.promoRender();
    });

    await expect(page.locator('#promo-tbody tr')).toHaveCount(2);

    // Enter confirms immediately (before the 200ms debounce would otherwise fire) and closes the panel.
    await page.locator('#promo-ms-cust > button').click();
    await expect(page.locator('#promo-ms-cust-panel')).not.toHaveClass(/hidden/);
    await page.locator('#promo-ms-cust-q').fill('C001');
    await page.locator('#promo-ms-cust-q').press('Enter');
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1); // applied without a wait
    await expect(page.locator('#promo-ms-cust-panel')).toHaveClass(/hidden/); // panel auto-closed

    // The ตกลง button does the same thing via a click, for a different field.
    await page.locator('#promo-ms-sku > button').click();
    await page.locator('#promo-ms-sku-q').fill('X1');
    await page.locator('#promo-ms-sku-panel button[onclick="promoMsConfirm(\'sku\')"]').click();
    await expect(page.locator('#promo-tbody tr')).toHaveCount(1);
    await expect(page.locator('#promo-ms-sku-panel')).toHaveClass(/hidden/);
  });
});
