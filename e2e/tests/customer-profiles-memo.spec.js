// @ts-check
const { test, expect } = require('@playwright/test');

// FIXED 2026-09-15: customerProfiles()/getCustomerProfile() are called once PER ROW in several hot
// loops (allCustomerRows(), Sales Overview's _sdBuildCusts/_sdBuildProds/_sdBuildSlms, ...). Before
// this fix, customerProfiles() called DB.get('customer_profiles') — a fresh JSON.parse of localStorage
// — on every single call, so a loop over thousands of sales rows did thousands of redundant full
// re-parses of the same (potentially 15,000+ customer) blob, confirmed live to freeze the tab with
// Chrome's "page unresponsive" dialog. Fixed by memoizing the parsed object in memory, invalidated
// only when DB.set('customer_profiles', ...) actually writes new data.
test.describe('customerProfiles() in-memory memoization', () => {
  async function setup(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  test('repeated calls return the exact same object reference (no re-parse) until the data is actually written again', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      DB.set('customer_profiles', { C001: { corporate: 'Group A', name: 'Cust A' } });
      const first = customerProfiles();
      const second = customerProfiles();
      const third = customerProfiles();
      return { sameRef: first === second && second === third, value: first.C001.corporate };
    });
    expect(result.sameRef).toBe(true);
    expect(result.value).toBe('Group A');
  });

  test('writing new data via DB.set invalidates the memo — the next call sees the fresh data, not the stale cached object', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      DB.set('customer_profiles', { C001: { corporate: 'Old Group' } });
      const before = customerProfiles();
      DB.set('customer_profiles', { C001: { corporate: 'New Group' } });
      const after = customerProfiles();
      return { differentRef: before !== after, beforeValue: before.C001.corporate, afterValue: after.C001.corporate };
    });
    expect(result.differentRef).toBe(true);
    expect(result.beforeValue).toBe('Old Group');
    expect(result.afterValue).toBe('New Group');
  });

  test('a mutate-then-DB.set pattern (used by saveCustomerGroup/confirmCustomerGroup) still persists and is visible afterward', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      DB.set('customer_profiles', { C001: { corporate: 'Group A' } });
      const profs = customerProfiles();
      profs.C001.category = 'ตู้สด'; // mutate the shared cached object directly, as real code does
      DB.set('customer_profiles', profs); // then persist + invalidate, as real code does
      return customerProfiles().C001.category;
    });
    expect(result).toBe('ตู้สด');
  });

  test('getCustomerProfile() (the actual per-row hot-loop caller) reflects the memoized data correctly', async ({ page }) => {
    await setup(page);
    const result = await page.evaluate(() => {
      DB.set('customer_profiles', { C001: { corporate: 'เดอะมอลล์ กรุ๊ป', category: 'ตู้สด', name: 'เดอะมอลล์ บางนา' } });
      return getCustomerProfile({ c: 'C001', n: 'fallback name', ty: 'ขายจริง', grp: 'อื่นๆ' });
    });
    expect(result.corp).toBe('เดอะมอลล์ กรุ๊ป');
    expect(result.category).toBe('ตู้สด');
    expect(result.n).toBe('เดอะมอลล์ บางนา');
  });
});
