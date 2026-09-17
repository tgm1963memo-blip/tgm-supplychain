// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for sample_requests server-sync (2026-09, Phase 2.2): "ของตัวอย่าง" used to be
// 100% localStorage (DB.get/set('sample_requests')) — a sales rep's request on one device was
// invisible to a manager approving from another. getSR()/saveSR() (the local-cache read/write pair)
// stay unchanged; every mutation site (srApprove/srReject/srSetStatus/srSubmitById/srDelete/
// srSaveTestResult/_srSave) now ALSO calls the matching SB.* wrapper to push the change to the server,
// and entering the page via nav() (pgSampleEntry, not pgSample directly) triggers exactly one
// background refresh — not a loop (the exact bug caught and fixed in the stock_in_actual migration
// earlier this session: calling the outer entry function again on refresh completion, instead of just
// the inner render, would re-trigger another fetch forever).
test.describe('sample_requests server sync', () => {
  async function gotoBare(page, { role = 'superadmin' } = {}) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((role) => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window.ROLE = role;
      window.UID = 'TESTUID';
      window.UNAME = 'Test User';
    }, role);
  }

  test('pgSampleEntry() refreshes from the server exactly once, not in a loop', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('sample_requests', []);
      sessionStorage.setItem('_pg', 'sample');
      window.__getSampleRequestsCalls = 0;
      SB.getSampleRequests = async () => {
        window.__getSampleRequestsCalls++;
        const fresh = [{ id: 'SR1', custCode: 'C001', custName: 'ลูกค้าเอ', status: 'pending', items: [], ts: Date.now() }];
        DB.set('sample_requests', fresh);
        return fresh;
      };
    });

    await page.evaluate(() => window.pgSampleEntry());
    await expect.poll(() => page.evaluate(() => window.__getSampleRequestsCalls)).toBe(1);
    await expect(page.locator('#ct')).toContainText('ลูกค้าเอ', { timeout: 2000 });
    // Give a would-be recursive extra refresh a chance to fire, then confirm it didn't.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__getSampleRequestsCalls)).toBe(1);
  });

  // Regression test for a real bug caught in review: the first version of SB.getSampleRequests()
  // wrote the RAW server rows (snake_case: cust_name, cust_code, delivery_date, by_name, test_result)
  // straight into DB.set('sample_requests', rows) with no conversion — but pgSample()'s own rendering
  // code reads a MIX of camelCase (custName/custCode/deliveryDate/byName/testResult, inherited from
  // the original local-only object shape) and snake_case (approved_by, submitted_at, etc.) fields. Every
  // OTHER test in this file stubs SB.getSampleRequests() directly (bypassing the real mapping code
  // entirely), so this test instead stubs getSupabaseClient() one level down and calls the REAL
  // SB.getSampleRequests() to prove the camelCase aliases actually get added.
  test('SB.getSampleRequests() maps snake_case server rows to the camelCase fields pgSample() reads', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      const fakeChain = {
        select: () => fakeChain, order: () => fakeChain, eq: () => fakeChain,
        limit: async () => ({
          data: [{ id: 'SR9', cust_code: 'C009', cust_name: 'ลูกค้าเก้า', delivery_date: '2026-09-20', by_name: 'Sales Nine', status: 'pending', items: [], ts: Date.now() }],
          error: null,
        }),
      };
      window.getSupabaseClient = () => ({ from: () => fakeChain });
    });

    const rows = await page.evaluate(() => SB.getSampleRequests());
    expect(rows).toHaveLength(1);
    expect(rows[0].custCode).toBe('C009');
    expect(rows[0].custName).toBe('ลูกค้าเก้า');
    expect(rows[0].deliveryDate).toBe('2026-09-20');
    expect(rows[0].byName).toBe('Sales Nine');
    // snake_case fields must still be reachable too (some read sites use them directly)
    expect(rows[0].cust_code).toBe('C009');

    const cached = await page.evaluate(() => DB.get('sample_requests')[0]);
    expect(cached.custName).toBe('ลูกค้าเก้า');
  });

  test('srApprove() pushes the approved record to the server', async ({ page }) => {
    await gotoBare(page, { role: 'manager' });
    await page.evaluate(() => {
      DB.set('sample_requests', [{ id: 'SR1', custCode: 'C001', custName: 'ลูกค้าเอ', status: 'pending', items: [] }]);
      window.__upsertCalls = [];
      SB.upsertSampleRequest = async (rec) => { window.__upsertCalls.push(rec); return rec; };
      window.srApprove('SR1');
    });

    // Note: UID is a module-level `let` (not attached to window), so window.UID set from the test
    // doesn't reach the app's internal binding — asserting its exact stamped value isn't reachable
    // from this harness; what matters for this regression is the id/status reaching the server.
    const calls = await page.evaluate(() => window.__upsertCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('SR1');
    expect(calls[0].status).toBe('approved');
    expect(calls[0]).toHaveProperty('approved_at');

    const local = await page.evaluate(() => DB.get('sample_requests')[0]);
    expect(local.status).toBe('approved');
  });

  test('srDelete() calls the server delete after confirmation', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('sample_requests', [{ id: 'SR1', custCode: 'C001', status: 'draft', items: [] }]);
      window.__deleteCalls = [];
      SB.deleteSampleRequest = async (id) => { window.__deleteCalls.push(id); return true; };
    });

    page.once('dialog', (d) => d.accept());
    await page.evaluate(() => window.srDelete('SR1'));

    const calls = await page.evaluate(() => window.__deleteCalls);
    expect(calls).toEqual(['SR1']);
    const remaining = await page.evaluate(() => DB.get('sample_requests'));
    expect(remaining).toEqual([]);
  });

  test('_srSave() (draft/submit path) pushes the record to the server', async ({ page }) => {
    await gotoBare(page, { role: 'sales' });
    await page.evaluate(() => {
      DB.set('sample_requests', []);
      window.__upsertCalls = [];
      SB.upsertSampleRequest = async (rec) => { window.__upsertCalls.push(rec); return rec; };
      // _sr itself is a module-level `let` (not attached to window), so _srSave(rec) is called
      // directly with a fully-built record rather than reaching into _sr.form/_srBuild() from outside.
      window._srSave({ id: 'SR2', custCode: 'C001', custName: 'ลูกค้าบี', purpose: 'ทดสอบ', status: 'pending', items: [{ sku: 'SKU1', qty: 1 }] });
    });

    const calls = await page.evaluate(() => window.__upsertCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].custCode).toBe('C001');
    expect(calls[0].status).toBe('pending');
    const local = await page.evaluate(() => DB.get('sample_requests').find(r => r.id === 'SR2'));
    expect(local).toBeTruthy();
  });

  // FIXED (2026-09-16, same root-cause bug as จัดการกลุ่ม's "โหลดไม่ขึ้น" report): the SKU picker in each
  // sample-request item row (_srItemRow()) used to render a <select> with a full copy of
  // getSkusMerged()'s ENTIRE product list (~3,870 real products) duplicated PER ITEM ROW — a request
  // with even a modest number of line items could produce tens of thousands of duplicate <option>
  // elements. Fixed the same way as the other two spots found this session: one shared
  // <datalist id="sr-sku-list"> built once, referenced by a lightweight <input list="sr-sku-list"> per
  // row. srItemSku() also had to change — it used to read the chosen <option>'s own data-name
  // attribute (sel.options[sel.selectedIndex]), which an <input> has no equivalent for; it now looks
  // the product name up from getSkusMerged() by the typed code instead.
  test('the item-row SKU field uses the shared sr-sku-list datalist (not a per-row duplicated <select>), and still records the product name', async ({ page }) => {
    await gotoBare(page, { role: 'sales' });
    await page.evaluate(() => {
      DB.set('remote_products_cache', [
        { code: 'ZZSKU001', name: 'สินค้าทดสอบ A' },
        { code: 'ZZSKU002', name: 'สินค้าทดสอบ B' },
      ]);
      window._srNewForm();
    });
    await page.locator('#sr-items-wrap').waitFor({ timeout: 5000 });
    // #sr-items-wrap still has one small, fixed-size <select> per row (หน่วย/unit — กก./ถุง/etc, not
    // the SKU picker this bug was about) — assert specifically that no <select> holds the SKU options.
    await expect(page.locator('#sr-items-wrap select option', { hasText: 'ZZSKU001' })).toHaveCount(0);
    const datalistValues = await page.locator('#sr-sku-list option').evaluateAll(els => els.map(e => e.getAttribute('value')));
    expect(datalistValues).toContain('ZZSKU001');
    expect(datalistValues).toContain('ZZSKU002');

    const input = page.locator('#sr-items-wrap input[list="sr-sku-list"]').first();
    await input.fill('ZZSKU001');
    await input.blur();
    // _sr is a module-level `let`, not attached to window (see the note on window._srSave above) —
    // read it as a bare identifier, which resolves via the same global scope chain page.evaluate runs in.
    const item = await page.evaluate(() => _sr.form.items[0]);
    expect(item.sku).toBe('ZZSKU001');
    expect(item.skuName).toBe('สินค้าทดสอบ A');
  });
});
