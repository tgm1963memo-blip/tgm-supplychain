// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for matchPO() (2026-09 fix): this used to be a raw prompt() asking the user to
// type an SO number by hand — no lookup, no autocomplete, easy to mistype or skip entirely. Replaced
// with a modal that searches real SO candidates (via the new SB.findSoForSkuMatch(), matched by sku +
// delivery-date proximity since po_plans rows carry no cust_code to filter on) and still allows typing
// an SO number manually as a fallback when nothing matches.
test.describe('PO to SO matching', () => {
  async function openMatchModal(page, { candidates = [] } = {}) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ candidates }) => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      DB.set('po_log', [
        { id: 'PO-TEST1', sku: 'SKU1', qty: 10, delivDate: '2026-09-15', customer: 'ลูกค้าทดสอบ', branch: 'TSS', status: 'pending', so: '', ver: 1 },
      ]);
      window.__upsertPOCalls = [];
      SB.upsertPO = async (po) => { window.__upsertPOCalls.push(po); return po; };
      window.__findSoCalls = [];
      SB.findSoForSkuMatch = async (sku, aroundDate) => { window.__findSoCalls.push({ sku, aroundDate }); return candidates; };
    }, { candidates });
    await page.evaluate(() => window.matchPO('PO-TEST1'));
  }

  test('shows real SO candidates found by sku + date proximity, not a prompt()', async ({ page }) => {
    await openMatchModal(page, {
      candidates: [
        { orderNo: 'SO1001', orderDate: '2026-09-10', dlvDate: '2026-09-14', custCode: 'C001', custName: 'ร้านเอ', qty: 10 },
        { orderNo: 'SO1002', orderDate: '2026-09-11', dlvDate: '2026-09-16', custCode: 'C002', custName: 'ร้านบี', qty: 8 },
      ],
    });

    const list = page.locator('#mpo-list');
    await expect(list).toContainText('SO1001');
    await expect(list).toContainText('ร้านเอ');
    await expect(list).toContainText('SO1002');

    const findCalls = await page.evaluate(() => window.__findSoCalls);
    expect(findCalls).toHaveLength(1);
    expect(findCalls[0].sku).toBe('SKU1');
    expect(findCalls[0].aroundDate).toBe('2026-09-15');
  });

  test('selecting a candidate matches the PO and closes the modal', async ({ page }) => {
    await openMatchModal(page, {
      candidates: [
        { orderNo: 'SO1001', orderDate: '2026-09-10', dlvDate: '2026-09-14', custCode: 'C001', custName: 'ร้านเอ', qty: 10 },
      ],
    });

    await page.locator('#mpo-list .ms-item', { hasText: 'SO1001' }).click();
    await expect(page.locator('#modal-bg')).toHaveClass(/hidden/);

    const calls = await page.evaluate(() => window.__upsertPOCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].so).toBe('SO1001');
    expect(calls[0].status).toBe('matched');

    const po = await page.evaluate(() => DB.get('po_log')[0]);
    expect(po.so).toBe('SO1001');
    expect(po.status).toBe('matched');
  });

  test('manual SO entry still works when no candidates match', async ({ page }) => {
    await openMatchModal(page, { candidates: [] });

    await expect(page.locator('#mpo-list')).toContainText('ไม่พบ SO');
    await page.locator('#mpo-manual').fill('SO-MANUAL-9');
    await page.locator('button', { hasText: 'ยืนยัน' }).click();

    const calls = await page.evaluate(() => window.__upsertPOCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].so).toBe('SO-MANUAL-9');
  });

  test('typing in the search box filters the candidate list client-side', async ({ page }) => {
    await openMatchModal(page, {
      candidates: [
        { orderNo: 'SO1001', orderDate: '2026-09-10', dlvDate: '2026-09-14', custCode: 'C001', custName: 'ร้านเอ', qty: 10 },
        { orderNo: 'SO1002', orderDate: '2026-09-11', dlvDate: '2026-09-16', custCode: 'C002', custName: 'ร้านบี', qty: 8 },
      ],
    });

    await page.locator('#mpo-q').fill('SO1002');
    await expect(page.locator('#mpo-list')).toContainText('SO1002');
    await expect(page.locator('#mpo-list')).not.toContainText('SO1001');
  });
});
