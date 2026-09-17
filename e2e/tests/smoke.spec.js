// @ts-check
const { test, expect } = require('@playwright/test');

// Bare smoke test to prove the Playwright setup itself works against the real running app —
// no credentials, no data mutation. Add real flow tests (login, จัดการผู้ใช้, Sales Overview, ...)
// as separate spec files alongside this one.
test('login screen loads with UID/password fields', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await expect(page.locator('#l-uid')).toBeVisible();
  await expect(page.locator('#l-pwd')).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/hidden/);
});
