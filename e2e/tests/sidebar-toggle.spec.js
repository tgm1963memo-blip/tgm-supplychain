// @ts-check
const { test, expect } = require('@playwright/test');

// The sidebar sits behind the login screen (#app starts hidden until auth succeeds), so this drives
// the toggle logic directly via page.evaluate() rather than requiring real login credentials —
// still exercises the real DOM/CSS/localStorage-persistence path, just without needing a session.
test.describe('hamburger sidebar toggle', () => {
  test('starts open, toggles closed and back open, persists across reload', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // default: open (unchanged from before this feature)
    await expect(page.locator('#app')).not.toHaveClass(/sb-collapsed/);
    await expect(page.locator('#sb')).toHaveCSS('width', '224px');

    // toggle closed
    await page.evaluate(() => window.toggleSidebar());
    await expect(page.locator('#app')).toHaveClass(/sb-collapsed/);
    await expect(page.locator('#sb')).toHaveCSS('width', '0px');

    // persists across reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toHaveClass(/sb-collapsed/);

    // toggle back open
    await page.evaluate(() => window.toggleSidebar());
    await expect(page.locator('#app')).not.toHaveClass(/sb-collapsed/);
    await expect(page.locator('#sb')).toHaveCSS('width', '224px');
  });

  test('hamburger button exists in the topbar', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#hb-toggle')).toHaveCount(1);
    await expect(page.locator('#hb-toggle')).toHaveAttribute('onclick', 'toggleSidebar()');
  });
});
