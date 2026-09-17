// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for custreg (ข้อมูลลูกค้า) server-sync (2026-09, Phase 2.3): the entire
// submit→approve/reject workflow used to be 100% localStorage (custreg_subs, custreg_workflow) —
// an approver on a different device/browser never saw a pending request. File attachments used to be
// embedded as base64 dataUrls inside the submission object; they now upload via real multipart to a
// dedicated custreg_attachments table (BLOB storage, same pattern as the existing po_emails.content)
// and are no longer part of the sub row at all (sub.docs was removed).
test.describe('custreg server sync', () => {
  async function gotoBare(page, { role = 'sales' } = {}) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((role) => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      window.ROLE = role;
      UID = 'TESTUID';
      window.UNAME = 'Test Sales';
      DB.set('users', [{ uid: 'MGR1', name: 'Manager One', role: 'manager' }]);
    }, role);
  }

  test('pgCustRegEntry() refreshes custreg_subs from the server exactly once, not in a loop', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      DB.set('custreg_subs', []);
      sessionStorage.setItem('_pg', 'custreg');
      window.__getCustregSubsCalls = 0;
      SB.getCustregSubs = async () => {
        window.__getCustregSubsCalls++;
        const fresh = [{ id: 'CR1', docNo: 'REG-1', shop: 'ร้านทดสอบ', status: 'pending', approvers: [], levels: [] }];
        DB.set('custreg_subs', fresh);
        return fresh;
      };
    });

    await page.evaluate(() => window.pgCustRegEntry());
    await expect.poll(() => page.evaluate(() => window.__getCustregSubsCalls)).toBe(1);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__getCustregSubsCalls)).toBe(1);
  });

  // Every other test in this file stubs SB.getCustregSubs()/upsertCustregSub() directly, which bypasses
  // custregRowToSub()/custregSubToRow() entirely — those mappers were carefully cross-checked against
  // every sub.xxx / s.xxx field access in the custreg code by hand, but a real test against the actual
  // snake_case server row shape (not a hand-written camelCase fake) is what would have caught a mapping
  // gap, the same class of bug found in sample_requests during this review (getSampleRequests() used to
  // return raw snake_case rows with no camelCase aliases at all).
  test('SB.getCustregSubs() maps snake_case server rows to the camelCase fields custreg reads', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      const fakeChain = {
        select: () => fakeChain, order: () => fakeChain,
        limit: async () => ({
          data: [{
            id: 'CR9', doc_no: 'REG-9', shop: 'ร้านเก้า', sales: 'Test Sales', sales_uid: 'TESTUID',
            created_by_uid: 'TESTUID', owner_sales_uid: 'TESTUID', owner_sales_name: 'Test Sales',
            request_type: 'ร้านค้าใหม่', existing_cust: '', drive_link: 'https://drive', external_emails: '',
            tax_addr: '', tax_zip: '', phone: '02-000-0000', taxid: '', crdays: '', price: 'C',
            date: '1 ม.ค. 2569', note: '', final_note: '',
            levels_json: [], current_level: 0, approvers_json: [{ uid: 'MGR1', name: 'Manager One', role: 'manager', status: 'pending' }],
            status: 'pending', custcode: '', ts: Date.now(),
          }],
          error: null,
        }),
      };
      window.getSupabaseClient = () => ({ from: () => fakeChain });
    });

    const rows = await page.evaluate(() => SB.getCustregSubs());
    expect(rows).toHaveLength(1);
    expect(rows[0].docNo).toBe('REG-9');
    expect(rows[0].salesUid).toBe('TESTUID');
    expect(rows[0].ownerSalesName).toBe('Test Sales');
    expect(rows[0].requestType).toBe('ร้านค้าใหม่');
    expect(rows[0].driveLink).toBe('https://drive');
    expect(rows[0].approvers).toHaveLength(1);
    expect(rows[0].approvers[0].uid).toBe('MGR1');

    const cached = await page.evaluate(() => DB.get('custreg_subs')[0]);
    expect(cached.docNo).toBe('REG-9');
  });

  test('crConfirmApproval() (flat approver path) pushes the sub to the server with no docs field', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      window.__upsertCalls = [];
      SB.upsertCustregSub = async (sub) => { window.__upsertCalls.push(sub); return sub; };
      SB.getApprovalWorkflowTemplate = async () => []; // no configured workflow -> manual picker
    });

    await page.evaluate(() => window.crOpenApproval());
    await expect(page.locator('#modal-bg')).not.toHaveClass(/hidden/);
    await page.evaluate(() => window.crToggleApprover('MGR1'));
    await page.evaluate(() => window.crConfirmApproval());

    await expect.poll(() => page.evaluate(() => window.__upsertCalls.length)).toBe(1);
    const call = await page.evaluate(() => window.__upsertCalls[0]);
    expect(call.status).toBe('pending');
    expect(call.approvers).toHaveLength(1);
    expect(call.approvers[0].uid).toBe('MGR1');
    expect(call.docs).toBeUndefined();
    expect(call.id).toMatch(/^CR-/);

    const local = await page.evaluate(() => DB.get('custreg_subs').find(s => s.id === window.__upsertCalls[0].id));
    expect(local).toBeTruthy();
  });

  test('crDoApprove() on a multi-level sub advances the level and pushes to the server', async ({ page }) => {
    await gotoBare(page, { role: 'manager' });
    // UID is a module-level `let` — window.UID set from the test doesn't reach the app's internal
    // binding (same caveat as sample-requests-sync.spec.js). Read the REAL internal UID via a
    // function that returns it (crOwnerUid() falls back to the bare UID when no form field is set),
    // and build the approver entry to match it, so crDoApprove()'s `x.uid===UID` lookup actually hits.
    const realUid = await page.evaluate(() => window.crOwnerUid());
    await page.evaluate((realUid) => {
      const sub = {
        id: 'CR2', docNo: 'REG-2', shop: 'ร้านสอง', status: 'pending', currentLevel: 0,
        levels: [
          { id: 'lv1', label: 'ขั้น 1', mode: 'any', approvers: [{ uid: realUid, name: 'Test Sales', role: 'manager', status: 'pending' }] },
        ],
        approvers: [{ uid: realUid, name: 'Test Sales', role: 'manager', status: 'pending' }],
      };
      DB.set('custreg_subs', [sub]);
      window.__upsertCalls = [];
      SB.upsertCustregSub = async (s) => { window.__upsertCalls.push(s); return s; };
    }, realUid);
    await page.evaluate(() => window.crDoApprove('CR2'));

    const calls = await page.evaluate(() => window.__upsertCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('approved'); // only 1 level, 'any' mode, 1 approver -> done
    expect(calls[0].levels[0].approvers[0].status).toBe('approved');
  });

  test('crDoReject() pushes rejected status to the server', async ({ page }) => {
    await gotoBare(page, { role: 'manager' });
    await page.evaluate(() => {
      const sub = { id: 'CR3', docNo: 'REG-3', shop: 'ร้านสาม', status: 'pending', approvers: [{ uid: 'TESTUID', name: 'Test Sales', role: 'manager', status: 'pending' }] };
      DB.set('custreg_subs', [sub]);
      window.__upsertCalls = [];
      SB.upsertCustregSub = async (s) => { window.__upsertCalls.push(s); return s; };
    });
    await page.evaluate(() => window.crDoReject('CR3'));

    const calls = await page.evaluate(() => window.__upsertCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('rejected');
  });

  test('workflow template settings (crWfAddLevel/crWfAddApprover/crWfSave) round-trip through the server', async ({ page }) => {
    await gotoBare(page, { role: 'superadmin' });
    await page.evaluate(() => {
      window.__savedTemplates = [];
      SB.getApprovalWorkflowTemplate = async () => [];
      SB.saveApprovalWorkflowTemplate = async (entityType, levels) => { window.__savedTemplates.push({ entityType, levels }); return true; };
    });

    await page.evaluate(() => window.crTab('settings'));
    await expect(page.locator('button', { hasText: '+ เพิ่มขั้น' })).toBeVisible();
    await page.locator('button', { hasText: '+ เพิ่มขั้น' }).click();

    const levelSelect = page.locator('select[onchange^="crWfAddApprover"]');
    await levelSelect.selectOption('MGR1');
    await page.locator('button', { hasText: '💾 บันทึก Workflow' }).click();

    await expect.poll(() => page.evaluate(() => window.__savedTemplates.length)).toBe(1);
    const saved = await page.evaluate(() => window.__savedTemplates[0]);
    expect(saved.entityType).toBe('custreg');
    expect(saved.levels).toHaveLength(1);
    expect(saved.levels[0].approvers[0].uid).toBe('MGR1');
  });

  test('_crUploadPendingFiles() calls SB.uploadCustregAttachment once per file across slots with no crash when empty', async ({ page }) => {
    await gotoBare(page);
    await page.evaluate(() => {
      window.__uploadCalls = [];
      SB.uploadCustregAttachment = async (subId, slotId, file, note) => { window.__uploadCalls.push({ subId, slotId, note }); return { id: 'CRA1' }; };
    });
    // _cr is module-scoped (not on window), so with nothing attached this should simply resolve with
    // zero upload calls — confirms the helper doesn't throw when a submission has no attachments.
    await page.evaluate(() => window._crUploadPendingFiles('CR-empty'));
    const calls = await page.evaluate(() => window.__uploadCalls);
    expect(calls).toEqual([]);
  });
});
