// @ts-check
const { test, expect } = require('@playwright/test');

// Password reset via email (2026-09-15, requested to mirror the sibling E-Memo system): a "ลืมรหัสผ่าน?"
// link on the login screen opens a forgot-password form (SB.forgotPassword(uidOrEmail)), and a
// ?resetToken=... deep link (from the emailed link) opens a set-new-password form directly
// (SB.resetPassword(token, newPassword)) instead of the normal login screen. SB.* is stubbed directly
// on the real SB object, same technique promo-draft-creation.spec.js uses — no real server/session
// needed for these UI-level flows.
test.describe('password reset (ลืมรหัสผ่าน)', () => {
  test('ลืมรหัสผ่าน? link opens the forgot-password screen; back link returns to login', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#ls')).toBeVisible();
    await expect(page.locator('#ls-forgot')).toHaveClass(/hidden/);

    await page.getByRole('button', { name: 'ลืมรหัสผ่าน?' }).click();
    await expect(page.locator('#ls')).toHaveClass(/hidden/);
    await expect(page.locator('#ls-forgot')).toBeVisible();

    await page.getByRole('button', { name: 'กลับหน้าเข้าสู่ระบบ' }).click();
    await expect(page.locator('#ls')).toBeVisible();
    await expect(page.locator('#ls-forgot')).toHaveClass(/hidden/);
  });

  test('submitting an empty field shows an inline error without calling the server', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    let called = false;
    await page.evaluate(() => { SB.forgotPassword = async () => { window.__called = true; return { message: 'ok' }; }; });
    await page.getByRole('button', { name: 'ลืมรหัสผ่าน?' }).click();
    await page.click('#ls-forgot .btn-p');
    await expect(page.locator('#fp-msg')).toBeVisible();
    await expect(page.locator('#fp-msg')).toHaveText('กรุณากรอกรหัสพนักงานหรืออีเมล');
    called = await page.evaluate(() => window.__called === true);
    expect(called).toBe(false);
  });

  test('submitting a uid/email calls SB.forgotPassword and shows the generic success message (no account-enumeration hint)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__fpArgs = null;
      SB.forgotPassword = async (uidOrEmail) => { window.__fpArgs = uidOrEmail; return { message: 'หากบัญชีนี้มีอยู่ในระบบ เราได้ส่งอีเมลลิงก์รีเซ็ตรหัสผ่านไปให้แล้ว' }; };
    });
    await page.getByRole('button', { name: 'ลืมรหัสผ่าน?' }).click();
    await page.fill('#fp-uid', 'someone@tgm.co.th');
    await page.click('#ls-forgot .btn-p');

    await expect(page.locator('#fp-msg')).toContainText('หากบัญชีนี้มีอยู่ในระบบ');
    const args = await page.evaluate(() => window.__fpArgs);
    expect(args).toBe('someone@tgm.co.th');
  });

  test('a server error while requesting reset shows the error text instead of a silent success', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      SB.forgotPassword = async () => { throw new Error('too many requests, try again later'); };
    });
    await page.getByRole('button', { name: 'ลืมรหัสผ่าน?' }).click();
    await page.fill('#fp-uid', 'someone@tgm.co.th');
    await page.click('#ls-forgot .btn-p');
    await expect(page.locator('#fp-msg')).toContainText('too many requests');
  });

  test('visiting a ?resetToken= link shows the set-new-password screen directly, not the login screen', async ({ page }) => {
    await page.goto('/?resetToken=abc123', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#ls-reset')).toBeVisible();
    await expect(page.locator('#ls')).toHaveClass(/hidden/);
    await expect(page.locator('#ls-forgot')).toHaveClass(/hidden/);
  });

  test('reset form rejects a too-short password or a mismatched confirmation before calling the server', async ({ page }) => {
    await page.goto('/?resetToken=abc123', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__called = false; SB.resetPassword = async () => { window.__called = true; }; });

    await page.fill('#rp-pwd1', 'short');
    await page.fill('#rp-pwd2', 'short');
    await page.click('#ls-reset .btn-p');
    await expect(page.locator('#rp-msg')).toContainText('อย่างน้อย 8 ตัวอักษร');
    expect(await page.evaluate(() => window.__called)).toBe(false);

    await page.fill('#rp-pwd1', 'longenough1');
    await page.fill('#rp-pwd2', 'longenough2');
    await page.click('#ls-reset .btn-p');
    await expect(page.locator('#rp-msg')).toContainText('ไม่ตรงกัน');
    expect(await page.evaluate(() => window.__called)).toBe(false);
  });

  test('a valid matching password calls SB.resetPassword(token, password) and shows success, disabling the form', async ({ page }) => {
    await page.goto('/?resetToken=abc123', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.__rpArgs = null;
      SB.resetPassword = async (token, newPassword) => { window.__rpArgs = { token, newPassword }; return { message: 'ok' }; };
    });
    await page.fill('#rp-pwd1', 'newpassword123');
    await page.fill('#rp-pwd2', 'newpassword123');
    await page.click('#ls-reset .btn-p');

    await expect(page.locator('#rp-msg')).toContainText('สำเร็จแล้ว');
    await expect(page.locator('#rp-pwd1')).toBeDisabled();
    await expect(page.locator('#rp-pwd2')).toBeDisabled();
    const args = await page.evaluate(() => window.__rpArgs);
    expect(args).toEqual({ token: 'abc123', newPassword: 'newpassword123' });
  });

  test('an expired/used token error from the server is shown and the form stays usable to retry', async ({ page }) => {
    await page.goto('/?resetToken=abc123', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      SB.resetPassword = async () => { throw new Error('ลิงก์หมดอายุแล้ว กรุณาขอลิงก์ใหม่'); };
    });
    await page.fill('#rp-pwd1', 'newpassword123');
    await page.fill('#rp-pwd2', 'newpassword123');
    await page.click('#ls-reset .btn-p');

    await expect(page.locator('#rp-msg')).toContainText('ลิงก์หมดอายุแล้ว');
    await expect(page.locator('#rp-pwd1')).toBeEnabled();
    await expect(page.locator('#ls-reset .btn-p')).toBeEnabled();
  });
});
