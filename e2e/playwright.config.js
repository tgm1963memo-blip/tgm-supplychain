// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Points at the already-running tgm-supplychain server (default dev port 3000, see server/.env's
// PORT and server/server.js). This does NOT start the server itself — start it separately
// (`npm start` inside server/, or it's already running as the TGMSupplyChainServer Windows service)
// before running tests, since it depends on a real SQLite DB + Express DBF sync that this test
// project has no business owning the lifecycle of.
// Use 127.0.0.1, not localhost — on this machine Chromium's resolution of "localhost" hung/aborted
// (net::ERR_ABORTED) even though the server answered fine over plain HTTP (curl/Invoke-WebRequest),
// while 127.0.0.1 worked immediately. Likely an IPv6-first resolution quirk in this environment.
const BASE_URL = process.env.TGM_BASE_URL || 'http://127.0.0.1:3000';

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
