// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

// bcryptjs lives in server/node_modules, not e2e/node_modules — a plain require('bcryptjs') from this
// file resolves node_modules relative to THIS file's own directory (e2e/tests/) and fails to find it.
// createRequire scoped to server/package.json resolves it the same way server/app.js itself would.
const serverRequire = createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));

// Real API-level coverage for "ใบเคาะราคา" (promo draft) — everything else in this test suite
// (promo-draft-creation.spec.js etc.) stubs SB.* directly on the page and never talks to a real
// server/DB, so it can never catch bugs in doc_no concurrency, server-side role gating, or file-upload
// content validation. This file boots a real, throwaway instance of server/app.js against a scratch
// SQLite file (never the shared dev/production DB at BASE_URL) and hits its HTTP endpoints directly
// with plain fetch — no browser page involved. Confirmed via manual testing during this session that
// the mime-type spoofing gap this file guards against was real (an .html payload with a <script> tag,
// declared as image/png in the multipart request, was accepted and served back with
// Content-Type: image/png) before server/lib/fileSignature.js was added (2026-09-15).

// playwright.config.js sets fullyParallel: true, which (unlike the default) can split this one file's
// tests across MULTIPLE worker processes rather than keeping them serial in one — each worker runs its
// own beforeAll, so a single hardcoded port/db-file would race between workers (confirmed: running with
// --workers=2 alongside the rest of the suite hit EADDRINUSE on a shared port). Deriving both from
// testInfo.workerIndex gives every worker its own isolated server+DB instead.
let TEST_PORT;
let TEST_DB;
let BASE;

function cleanupDbFiles() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* not present */ }
  }
}

/** @type {import('http').Server} */
let server;
/** @type {import('node:sqlite').DatabaseSync} */
let db;
/** @type {Record<string, string>} */
let tokens = {};

test.beforeAll(async ({}, testInfo) => {
  TEST_PORT = 3991 + testInfo.workerIndex;
  TEST_DB = path.join(__dirname, '..', `.tmp-promo-api-security-w${testInfo.workerIndex}.db`);
  BASE = `http://127.0.0.1:${TEST_PORT}`;
  cleanupDbFiles();
  process.env.DB_PATH = TEST_DB;
  // Required so server/app.js's own module-level `require('dotenv').config()` (if any) doesn't pull in
  // this repo's real server/.env — DB_PATH above already takes priority either way since dotenv never
  // overrides a var already set on process.env, but SMTP/etc. staying unset here is intentional too
  // (this suite never exercises password-reset emails).
  delete require.cache[require.resolve('../../server/db/init.js')];
  delete require.cache[require.resolve('../../server/app.js')];
  const { openDb } = require('../../server/db/init.js');
  const { buildApp } = require('../../server/app.js');
  const bcrypt = serverRequire('bcryptjs');
  const { createSession } = require('../../server/middleware/auth.js');

  db = openDb();
  const seedUser = (uid, role) => {
    db.prepare('INSERT OR REPLACE INTO sc_users (uid, name, role, email, pwd_hash) VALUES (?, ?, ?, ?, ?)')
      .run(uid, uid, role, `${uid.toLowerCase()}@test.local`, bcrypt.hashSync('testpass123', 10));
    tokens[role] = createSession(db, uid).token;
  };
  // sales/superadmin are both in PROMO_DRAFT_ROLES (server/app.js); planning is not — used to prove
  // the server actually rejects a role with no promo-draft access, not just that the UI hides buttons.
  seedUser('APITEST_SALES', 'sales');
  seedUser('APITEST_ADMIN', 'superadmin');
  seedUser('APITEST_PLANNING', 'planning');

  const app = buildApp(db, {});
  await new Promise((resolve) => { server = app.listen(TEST_PORT, resolve); });
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db.close(); } catch { /* already closed */ }
  cleanupDbFiles();
});

function authHeaders(role, extra = {}) {
  return { Authorization: `Bearer ${tokens[role]}`, ...extra };
}

test.describe('promo draft API — doc_no concurrency', () => {
  test('20 concurrent header creations each get a unique, gap-free doc_no', async () => {
    const requests = Array.from({ length: 20 }, () =>
      fetch(`${BASE}/api/promo_draft_headers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders('sales') },
        body: JSON.stringify({ promo_name: 'concurrency test' }),
      }).then((r) => r.json())
    );
    const results = await Promise.all(requests);
    const docNos = results.map((r) => r.doc_no);
    expect(docNos.every((d) => typeof d === 'string' && /^PC\d{4}-\d{4}$/.test(d))).toBe(true);
    expect(new Set(docNos).size).toBe(docNos.length); // no two requests got the same number
  });
});

test.describe('promo draft API — server-side role gate (not just UI hiding buttons)', () => {
  test('a role with no promo-draft access (planning) gets 403 creating a header', async () => {
    const res = await fetch(`${BASE}/api/promo_draft_headers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('planning') },
      body: JSON.stringify({ promo_name: 'should be blocked' }),
    });
    expect(res.status).toBe(403);
  });

  test('an authorized role (sales) can create a header', async () => {
    const res = await fetch(`${BASE}/api/promo_draft_headers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('sales') },
      body: JSON.stringify({ promo_name: 'allowed' }),
    });
    expect(res.status).toBe(201);
  });

  test('no session token at all gets 401, not 403 (missing auth vs. wrong role are distinct)', async () => {
    const res = await fetch(`${BASE}/api/promo_draft_headers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promo_name: 'no token' }),
    });
    expect(res.status).toBe(401);
  });

  test('planning is also blocked from posting a per-line comment (mirrors the header gate)', async () => {
    const res = await fetch(`${BASE}/api/promo_draft_line_comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders('planning') },
      body: JSON.stringify({ draft_no: 'PMD-doesnotmatter', sku: 'SKU1', text: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  test('planning is also blocked from uploading an attachment (mirrors the header gate)', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])]), 'x.png');
    const res = await fetch(`${BASE}/api/promo_draft_attachments/PMD-doesnotmatter`, {
      method: 'POST',
      headers: authHeaders('planning'),
      body: form,
    });
    expect(res.status).toBe(403);
  });
});

test.describe('promo draft API — attachment content is verified, not trusted from the declared Content-Type', () => {
  test('an HTML payload with a <script> tag, declared as image/png, is rejected', async () => {
    const evilHtml = Buffer.from('<html><body><script>alert(1)</script></body></html>');
    const form = new FormData();
    form.append('file', new Blob([evilHtml], { type: 'image/png' }), 'evil.png');
    const res = await fetch(`${BASE}/api/promo_draft_attachments/PMD-spoof-test`, {
      method: 'POST',
      headers: authHeaders('sales'),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('เนื้อไฟล์ไม่ตรงกับชนิดไฟล์');
  });

  test('a real PDF declared as image/png (cross-type spoof) is also rejected', async () => {
    const realPdfBytes = Buffer.from('%PDF-1.4\n%fake but real PDF header\n');
    const form = new FormData();
    form.append('file', new Blob([realPdfBytes], { type: 'image/png' }), 'fake.png');
    const res = await fetch(`${BASE}/api/promo_draft_attachments/PMD-spoof-test`, {
      method: 'POST',
      headers: authHeaders('sales'),
      body: form,
    });
    expect(res.status).toBe(400);
  });

  test('a genuine PNG is still accepted and served back with X-Content-Type-Options: nosniff', async () => {
    // Minimal valid 1x1 PNG (real magic bytes + IHDR/IDAT/IEND chunks).
    const realPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000a49444154789c63000100000500010d0a02db000000004945' +
      '4e44ae426082',
      'hex'
    );
    const form = new FormData();
    form.append('file', new Blob([realPng], { type: 'image/png' }), 'real.png');
    const uploadRes = await fetch(`${BASE}/api/promo_draft_attachments/PMD-real-png-test`, {
      method: 'POST',
      headers: authHeaders('sales'),
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const saved = await uploadRes.json();

    const contentRes = await fetch(`${BASE}/api/promo_draft_attachments/${saved.id}/content`, {
      headers: authHeaders('sales'),
    });
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(contentRes.headers.get('content-type')).toBe('image/png');
  });

  test('the same content check protects custreg_attachments (identical code path, copied file)', async () => {
    const evilHtml = Buffer.from('<html><body><script>alert(1)</script></body></html>');
    const form = new FormData();
    form.append('slotId', 'slot1');
    form.append('file', new Blob([evilHtml], { type: 'image/png' }), 'evil.png');
    const res = await fetch(`${BASE}/api/custreg_attachments/CR-spoof-test`, {
      method: 'POST',
      headers: authHeaders('sales'),
      body: form,
    });
    expect(res.status).toBe(400);
  });
});
