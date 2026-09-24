// @ts-check
const { test, expect } = require('@playwright/test');

// Regression coverage for the "ใบเคาะราคา" feature (renamed from "ใบโปรร่าง"/promo draft, v2 redesign
// 2026-09-11): the create/edit form is a full-page overlay (#draft-fp, not the shared #modal-bg
// dialog), the branch picker is a 3-step cascade (กลุ่มลูกค้า -> ประเภทลูกค้า -> สาขา, each multi-select
// with select-all/clear), line items compute cost price from an editable GP%, documents track a
// status lifecycle (draft/pending_approval/pending_exec_approval/approved/rejected/keyed_to_express)
// gated by a configurable multi-level approval route (reusing approval_workflow_templates), header
// checkboxes (NPD/off-contract cost/marketing cost) escalate to an executive route, each product line
// has a comment thread, documents carry file attachments and a free-form other-costs table, and a
// server-issued running document number (doc_no, e.g. PC2569-0001) is shown throughout. The v2
// redesign also split the data model: promo_draft_headers (one row per document) + promo_drafts
// (one row per branch×SKU line) — SB.getPromoDrafts()/addPromoDraftLines() etc. from the v1 feature
// were replaced by SB.getPromoDraftHeader(s)/getPromoDraftLines/createPromoDraftHeader/
// updatePromoDraftHeader/deletePromoDraftHeader/deletePromoDraftLines. Everything still saves to our
// own tables only — never written into Express.
//
// SB.* is stubbed directly on the real SB object (same technique promo-history-search.spec.js uses
// for window._promoDocs) so these tests don't depend on a real authenticated session or server data.
test.describe('promo draft creation (ใบเคาะราคา)', () => {
  async function openDraftModal(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      SB.getApprovalWorkflowTemplate = async () => [];
      // Two branches under the same ห้าง (corp), one branch under a different ห้าง.
      DB.set('remote_customers_cache', [
        { code: 'C001', name: 'เดอะมอลล์ บางนา', cust_group: 'ขายจริง', slm_id: 'S1' },
        { code: 'C002', name: 'เดอะมอลล์ รามอินทรา', cust_group: 'ขายจริง', slm_id: 'S1' },
        { code: 'C003', name: 'บิ๊กซี ลาดพร้าว', cust_group: 'ขายจริง', slm_id: 'S2' },
      ]);
      DB.set('customer_profiles', {
        C001: { corporate: 'เดอะมอลล์ กรุ๊ป', name: 'เดอะมอลล์ บางนา', category: 'ตู้สด' },
        C002: { corporate: 'เดอะมอลล์ กรุ๊ป', name: 'เดอะมอลล์ รามอินทรา', category: 'ฝากขาย' },
        C003: { corporate: 'บิ๊กซี', name: 'บิ๊กซี ลาดพร้าว', category: 'ตู้สด' },
      });
    });
    await page.evaluate(() => window.showPromoDraftModal());
  }

  // เอกสารที่มีอยู่แล้ว (แก้ไข/ดู) ต้อง stub ทั้ง header (getPromoDraftHeader) และบรรทัดสินค้า
  // (getPromoDraftLines) เพราะ v2 แยก 2 ตารางแล้ว — ต่างจาก v1 ที่ทุกอย่างมาจาก getPromoDrafts() ตัวเดียว
  async function stubExistingDoc(page, header, lines) {
    await page.evaluate(({ header, lines }) => {
      SB.getPromoDraftHeader = async () => header;
      SB.getPromoDraftLines = async () => lines;
      SB.getPromoDraftAttachments = async () => [];
      SB.getAuditLog = async () => ([]);
      SB.getPromoDocsForOverlap = async () => ([]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
      // draftRenderLines() fires draftRefreshCommentCounts() (fire-and-forget) whenever _draftEditNo is
      // set, which calls this per line — left unstubbed, it hits the real live server, 401s (no real
      // session here), and the app's global 401-handler bounces to the login screen mid-test.
      SB.getPromoDraftLineComments = async () => ([]);
    }, { header, lines });
  }

  test('opening the create-draft form shows a full-page overlay (not the shared modal) with one empty product line and a doc-number placeholder', async ({ page }) => {
    await openDraftModal(page);
    await expect(page.locator('#draft-fp')).not.toHaveClass(/hidden/);
    await expect(page.locator('#modal-bg')).toHaveClass(/hidden/);
    await expect(page.locator('.cr-fullpage-header')).toContainText('สร้างใบเคาะราคา');
    await expect(page.locator('.cr-fullpage-header')).toContainText('ร่าง'); // สถานะเริ่มต้น
    await expect(page.locator('.cr-fullpage-header')).toContainText('ยังไม่บันทึก'); // ยังไม่มี doc_no จนกว่าจะบันทึก

    await page.locator('#draft-ms > button').click();
    const list = page.locator('#draft-ms-list');
    await expect(list).toContainText('เดอะมอลล์ กรุ๊ป');
    await expect(list).toContainText('บิ๊กซี');
    await expect(list).toContainText('C001');
    await expect(list).toContainText('C002');
    await expect(list).toContainText('C003');

    // One empty product-input row exists by default.
    await expect(page.locator('#draft-lines-tbody tr')).toHaveCount(1);
  });

  test('branch selection is a 3-step cascade (กลุ่ม -> ประเภท -> สาขา), each with select-all/clear', async ({ page }) => {
    await openDraftModal(page);
    await expect(page.locator('#draft-group-ms > button')).toBeVisible();
    await expect(page.locator('#draft-cat-ms > button')).toBeVisible();
    await expect(page.locator('#draft-ms > button')).toBeVisible();

    await page.locator('#draft-group-ms > button').click();
    await expect(page.locator('#draft-group-list')).toContainText('เดอะมอลล์ กรุ๊ป');
    await expect(page.locator('#draft-group-list')).toContainText('บิ๊กซี');
    await expect(page.locator('#draft-group-ms-panel button', { hasText: 'เลือกทั้งหมด' })).toBeVisible();
    await expect(page.locator('#draft-group-ms-panel button', { hasText: 'ล้างตัวกรอง' })).toBeVisible();

    // เลือกกลุ่ม "เดอะมอลล์ กรุ๊ป" -> ขั้นประเภทต้องเหลือแค่ ตู้สด/ฝากขาย (ของกลุ่มนี้เท่านั้น ไม่มีของบิ๊กซี)
    await page.locator('#draft-group-list .ms-item', { hasText: 'เดอะมอลล์ กรุ๊ป' }).click();
    await expect(page.locator('#draft-group-label')).toHaveText('เลือกแล้ว 1 กลุ่ม');
    await page.locator('#draft-group-ms-panel button', { hasText: 'ปิด' }).click(); // ปิดก่อน กันทับซ้อนกับปุ่มขั้นถัดไป
    await page.locator('#draft-cat-ms > button').click();
    await expect(page.locator('#draft-cat-list')).toContainText('ตู้สด');
    await expect(page.locator('#draft-cat-list')).toContainText('ฝากขาย');

    // เลือกประเภท "ตู้สด" -> ขั้นสาขาต้องเหลือแค่ C001 (เดอะมอลล์ บางนา คือตู้สด, รามอินทราคือฝากขาย)
    await page.locator('#draft-cat-list .ms-item', { hasText: 'ตู้สด' }).click();
    await page.locator('#draft-cat-ms-panel button', { hasText: 'ปิด' }).click(); // ปิดก่อน กันทับซ้อนกับปุ่มขั้นถัดไป
    await page.locator('#draft-ms > button').click();
    const branchList = page.locator('#draft-ms-list');
    await expect(branchList).toContainText('C001');
    await expect(branchList).not.toContainText('C002');
    await expect(branchList).not.toContainText('C003');
  });

  // สูตรยืนยันแล้ว (2026-09-16): ราคาทุนสุทธิ = (ราคาขาย ÷ 1.07) × (1 − GP%/100) — ถอด VAT 7% ออกก่อน
  // แล้วค่อยหัก GP% — ราคาปกติ(normalPrice)->costPrice และราคาโปร(unitPrice)->costPricePromo แยกกัน
  // ใช้ 107 เป็นราคาขายในเทสต์เพราะ 107/1.07=100 พอดี ตรวจสอบด้วยมือได้ง่าย
  test('entering GP% auto-calculates the net cost price (VAT-adjusted) for both ราคาปกติ and ราคาโปร, editable afterwards', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      window.draftLineField(0, 'normalPrice', '107');
      window.draftLineField(0, 'gpPct', '20');
    });
    await expect(page.locator('#draft-line-cost-0')).toHaveText('80.00'); // 107/1.07=100 * (1-0.20)
    await page.evaluate(() => window.draftLineField(0, 'gpPct', '25'));
    await expect(page.locator('#draft-line-cost-0')).toHaveText('75.00'); // 100 * (1-0.25)

    // ฝั่งราคาโปร (unitPrice/gpPctPromo/costPricePromo) คำนวณแยกจากฝั่งราคาปกติโดยสิ้นเชิง
    await page.evaluate(() => {
      window.draftLineField(0, 'unitPrice', '214'); // 214/1.07=200 พอดี
      window.draftLineField(0, 'gpPctPromo', '10');
    });
    await expect(page.locator('#draft-line-cost-promo-0')).toHaveText('180.00'); // 200 * (1-0.10)
    // ฝั่งราคาปกติต้องไม่เปลี่ยนตามฝั่งราคาโปร
    await expect(page.locator('#draft-line-cost-0')).toHaveText('75.00');
  });

  // "ราคาปกติ" auto-fill (2026-09-15, ยืนยันแล้วว่าใช้ "ราคาขายล่าสุดที่เจอใน promo_docs" เป็นค่าตั้งต้น) —
  // promo_docs มาจากเอกสารใบเสนอราคา Express P1/P2 (OESO.DBF/OESOIT.DBF) ซึ่ง draftRefreshLineRefData()
  // ดึงมาอยู่แล้วสำหรับคอลัมน์ "ราคาโปรก่อนหน้า" — ใช้ค่าเดียวกันนั้นเติมช่อง "ราคาปกติ" อัตโนมัติ
  test('"ราคาปกติ" auto-fills from the latest promo_docs price when a line\'s SKU is set, but never overwrites a value already typed in', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO111', unit_price: 123.45, start_date: '2025-06-01', due_date: '2025-06-30' },
      ]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
    });
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();

    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window.draftRefreshLineRefData();
    });
    await expect(page.locator('#draft-line-normalprice-0')).toHaveValue('123.45', { timeout: 2000 });
    // recalculates the net cost too, using the auto-filled normalPrice (needs a GP% to produce a number)
    await page.evaluate(() => window.draftLineField(0, 'gpPct', '20'));
    await expect(page.locator('#draft-line-cost-0')).toHaveText('92.30'); // 123.45/1.07=115.3738... * 0.80

    // a second line where the user already typed a normalPrice must NOT be overwritten by the same refresh
    await page.evaluate(() => {
      window._draftLines.push({ ...window._draftLines[0], sku: 'SKU1', normalPrice: '999' });
      window.draftRenderLines();
      window.draftRefreshLineRefData();
    });
    await expect(page.locator('#draft-line-normalprice-1')).toHaveValue('999', { timeout: 2000 });
  });

  // FIXED (2026-09-16, /code-review — confirmed real): the auto-fill used to key off
  // `normalPrice === ''`, which can't distinguish "never touched" from "user deliberately cleared it"
  // — any later trigger of draftRefreshLineRefData() (editing another line, changing branches/dates)
  // silently refilled a value the user had just erased on purpose. Fixed with a `normalPriceEdited`
  // flag set the moment the user touches the field at all (typing OR clearing).
  test('"ราคาปกติ" does not get silently refilled after the user deliberately clears it', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO111', unit_price: 123.45, start_date: '2025-06-01', due_date: '2025-06-30' },
      ]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
    });
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();

    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window.draftRefreshLineRefData();
    });
    await expect(page.locator('#draft-line-normalprice-0')).toHaveValue('123.45', { timeout: 2000 });

    // user deliberately clears the auto-filled value
    await page.locator('#draft-line-normalprice-0').fill('');
    await page.locator('#draft-line-normalprice-0').blur();
    expect(await page.evaluate(() => window._draftLines[0].normalPrice)).toBe('');

    // any later trigger of draftRefreshLineRefData() (e.g. adding another line, changing branches)
    // must NOT bring the value back
    await page.evaluate(() => window.draftRefreshLineRefData());
    await expect(page.locator('#draft-line-normalprice-0')).toHaveValue('', { timeout: 1000 });
  });

  test('adding a product line that overlaps an existing promo_docs document shows a non-blocking, clickable warning', async ({ page }) => {
    await openDraftModal(page);

    // Stub the overlap-check queries: C001/SKU1 has a real document running 2026-01-01..2026-01-31.
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO999', start_date: '2026-01-01', due_date: '2026-01-31' },
      ]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
    });

    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();

    // Set the document-level period (ข้อ 1: 1 ใบ = 1 ช่วงเวลา — no more per-line dates) via the header
    // date inputs, and the line's sku directly on the app's own state — draftLineField()/draftSyncLineDates()
    // trigger the same overlap check the real onchange handlers call, this just exercises it deterministically.
    await page.fill('#draft-start', '2026-01-15');
    await page.fill('#draft-due', '2026-02-15');
    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window.draftCheckOverlap();
    });

    await expect(page.locator('#draft-overlap-warning')).toContainText('ซ้อนทับ', { timeout: 2000 });
    await expect(page.locator('#draft-overlap-warning')).toContainText('SO999'); // เอกสารจริงจาก Express — แสดงตัวหนา ไม่ใช่ลิงก์ (ยังไม่มีหน้า detail ให้เปิด)

    // Save button must remain present/enabled — overlap is a warning, not a block.
    await expect(page.locator('button', { hasText: 'บันทึกร่าง' })).toBeEnabled();
  });

  test('overlapping with another draft shows a clickable link that reopens that draft', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([]);
      SB.getPromoDraftsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', draft_no: 'PMD_OTHER', start_date: '2026-01-01', due_date: '2026-01-31' },
      ]);
      SB.getSalesQtyForPairs = async () => ([]);
      SB.getPromoDraftHeader = async (no) => (no === 'PMD_OTHER' ? { draft_no: 'PMD_OTHER', doc_no: 'PC2569-0007', status: 'draft', promo_name: 'อีกใบ' } : null);
      SB.getPromoDraftLines = async () => ([]);
      SB.getPromoDraftAttachments = async () => [];
      SB.getAuditLog = async () => ([]);
    });
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
    await page.fill('#draft-start', '2026-01-15');
    await page.fill('#draft-due', '2026-02-15');
    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window.draftCheckOverlap();
    });
    const link = page.locator('#draft-overlap-warning .doc-link');
    await expect(link).toContainText('PMD_OTHER', { timeout: 2000 });
    await link.click();
    await expect(page.locator('.cr-fullpage-header')).toContainText('PC2569-0007');
  });

  test('a non-overlapping date range shows no warning', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO999', start_date: '2026-01-01', due_date: '2026-01-31' },
      ]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
    });
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
    await page.fill('#draft-start', '2026-06-01');
    await page.fill('#draft-due', '2026-06-30');
    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window.draftCheckOverlap();
    });
    await page.waitForTimeout(400); // clear the 300ms debounce
    await expect(page.locator('#draft-overlap-warning')).toBeEmpty();
  });

  test('checking an escalation checkbox shows the executive-approval warning; unchecking clears it', async ({ page }) => {
    await openDraftModal(page);
    await expect(page.locator('#draft-esc-warn')).toBeEmpty();
    await page.locator('#draft-npd').check();
    await expect(page.locator('#draft-esc-warn')).toContainText('ผู้บริหาร');
    await expect(page.locator('#draft-esc-warn')).toContainText('อย่างน้อย 1 ข้อ');
    await page.locator('#draft-npd').uncheck();
    await expect(page.locator('#draft-esc-warn')).toBeEmpty();
  });

  test('other-costs table: add a row, fill it in, and see the running total update without losing focus', async ({ page }) => {
    await openDraftModal(page);
    await page.getByRole('button', { name: '+ เพิ่มรายการ', exact: true }).click();
    const rows = page.locator('.oc-row');
    await expect(rows).toHaveCount(1);
    await rows.nth(0).locator('input').nth(0).fill('ค่าเช่าบูธ');
    const amountInput = rows.nth(0).locator('input').nth(1);
    await amountInput.fill('8500');
    await expect(page.locator('#draft-oc-total')).toContainText('8,500');
    await expect(amountInput).toBeFocused(); // การอัปเดตยอดรวมต้องไม่ทำให้ input เสีย focus (บั๊กจริงที่เจอระหว่างพัฒนา)
  });

  test('saving a new document creates the header first (server issues draft_no/doc_no) then the lines, and closes the overlay', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.createPromoDraftHeader = async (fields) => { window.__savedHeader = fields; return { ...fields, draft_no: 'PMD_NEW', doc_no: 'PC2569-0042' }; };
      SB.addPromoDraftLines = async (rows) => { window.__savedRows = rows; return rows; };
      SB.audit = async () => {};
      SB.getPromoDocsForOverlap = async () => ([]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
      UID = 'TESTUID'; // bare assignment (UID is a top-level `let`) — needed so updated_by round-trips
    });

    await page.locator('#draft-name').fill('โปรทดสอบ');
    await page.fill('#draft-start', '2026-06-01');
    await page.fill('#draft-due', '2026-06-30');
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C002' }).click();
    await page.evaluate(() => {
      window._draftLines[0].sku = 'SKU1';
      window._draftLines[0].unitPrice = '10';
    });
    await page.evaluate(() => window.draftAddLine());
    await page.evaluate(() => {
      window._draftLines[1].sku = 'SKU2';
      window._draftLines[1].unitPrice = '20';
    });

    await page.locator('button', { hasText: 'บันทึกร่าง' }).click();
    await expect(page.locator('#draft-fp')).toHaveClass(/hidden/);

    const savedHeader = await page.evaluate(() => window.__savedHeader);
    expect(savedHeader.promo_name).toBe('โปรทดสอบ');
    expect(savedHeader.updated_by).toBe('TESTUID');
    expect(savedHeader.created_by).toBeUndefined(); // client ไม่ส่ง created_by — server เป็นคน derive จาก session เอง
    expect(savedHeader.start_date).toBe('2026-06-01');
    expect(savedHeader.due_date).toBe('2026-06-30');

    const savedRows = await page.evaluate(() => window.__savedRows);
    expect(savedRows).toHaveLength(4); // 2 branches x 2 product lines
    const draftNos = new Set(savedRows.map((r) => r.draft_no));
    expect(draftNos.size).toBe(1);
    expect([...draftNos][0]).toBe('PMD_NEW'); // ใช้ draft_no ที่ server ออกให้ ไม่ใช่ genId ฝั่ง client เอง
    expect(new Set(savedRows.map((r) => r.cust_code))).toEqual(new Set(['C001', 'C002']));
    expect(new Set(savedRows.map((r) => r.sku))).toEqual(new Set(['SKU1', 'SKU2']));
    expect(savedRows.every((r) => r.promo_name === undefined)).toBe(true); // ฟิลด์หัวเอกสารไม่ปนมาในบรรทัดอีกต่อไป (แยกตารางแล้ว)
    // ข้อ 1 (1 ใบ = 1 ช่วงเวลา): ทุกบรรทัดต้องได้ช่วงเวลาเดียวกับหัวเอกสารเป๊ะๆ ไม่มีทางกรอกต่างกันได้อีกแล้ว
    expect(savedRows.every((r) => r.start_date === '2026-06-01' && r.due_date === '2026-06-30')).toBe(true);
  });

  test('the header date fields are the only place to set the promo period — the line-items table has no per-line date columns, and saving is blocked until they are filled in', async ({ page }) => {
    await openDraftModal(page);
    await expect(page.locator('#draft-lines-tbody')).not.toContainText('วันที่เริ่ม');
    await expect(page.locator('thead')).not.toContainText('วันที่เริ่ม');
    await expect(page.locator('thead')).not.toContainText('วันครบกำหนด');

    // บันทึกโดยไม่กรอกวันที่หัวเอกสาร — ต้องถูกบล็อก
    await page.locator('#draft-name').fill('โปรไม่มีวันที่');
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
    await page.evaluate(() => { window._draftLines[0].sku = 'SKU1'; });
    let alertMsg = '';
    page.once('dialog', (d) => { alertMsg = d.message(); d.accept(); });
    await page.locator('button', { hasText: 'บันทึกร่าง' }).click();
    expect(alertMsg).toContain('ช่วงเวลาเดียว');
    await expect(page.locator('#draft-fp')).not.toHaveClass(/hidden/); // ยังไม่ปิดฟอร์ม เพราะบันทึกไม่สำเร็จ
  });

  test('changing the header period after adding lines re-syncs every line and re-checks overlap', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO500', start_date: '2026-03-01', due_date: '2026-03-31' },
      ]);
      SB.getPromoDraftsForOverlap = async () => ([]);
      SB.getSalesQtyForPairs = async () => ([]);
    });
    await page.locator('#draft-ms > button').click();
    await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
    await page.fill('#draft-start', '2026-01-01');
    await page.fill('#draft-due', '2026-01-31'); // ไม่ซ้อนกับ SO500 ตอนนี้
    await page.evaluate(() => { window._draftLines[0].sku = 'SKU1'; window.draftCheckOverlap(); });
    await page.waitForTimeout(400);
    await expect(page.locator('#draft-overlap-warning')).toBeEmpty();

    // เปลี่ยนช่วงเวลาที่หัวเอกสารทีหลัง (หลังจากมีบรรทัดสินค้าอยู่แล้ว) ให้ไปซ้อนกับ SO500 แทน
    await page.fill('#draft-due', '2026-03-15');
    await expect(page.locator('#draft-overlap-warning')).toContainText('SO500', { timeout: 2000 });
    // และ label เหนือตารางต้องอัปเดตตามช่วงเวลาใหม่ด้วย (promoFmtD แสดงเป็น พ.ศ. — 2026 มี.ค. = 2569)
    await expect(page.locator('#draft-lines-period')).toContainText('มี.ค. 2569');
  });

  test('editing an existing document updates the header (server keeps created_by) and replaces the lines', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      { draft_no: 'PMD_EXIST', doc_no: 'PC2569-0001', promo_name: 'โปรเดิม', status: 'draft', created_by: 'ORIGINAL_CREATOR', other_costs_json: [], start_date: '2026-06-01', due_date: '2026-06-30' },
      [{ draft_no: 'PMD_EXIST', cust_code: 'C001', cust_name: 'เดอะมอลล์ บางนา', sku: 'SKU1', sku_name: 'สินค้า 1', unit_price: 90, normal_price: 100, start_date: '2026-06-01', due_date: '2026-06-30' }],
    );
    await page.evaluate(() => {
      SB.updatePromoDraftHeader = async (draftNo, patch) => { window.__patchedHeader = { draftNo, ...patch }; return {}; };
      SB.deletePromoDraftLines = async () => ({});
      SB.addPromoDraftLines = async (rows) => { window.__savedRows = rows; return rows; };
      SB.audit = async () => {};
      UID = 'EDITOR_USER'; // bare assignment — UID is a top-level `let`, not a window property,
      // so window.UID=... here would silently miss the binding isManager()/saveDraftPromo() actually read.
    });
    await page.evaluate(() => window.showPromoDraftModal('PMD_EXIST'));
    await page.locator('button', { hasText: 'บันทึกร่าง' }).click();
    await expect(page.locator('#draft-fp')).toHaveClass(/hidden/);
    const patched = await page.evaluate(() => window.__patchedHeader);
    expect(patched.draftNo).toBe('PMD_EXIST');
    expect(patched.updated_by).toBe('EDITOR_USER');
    expect(patched.created_by).toBeUndefined(); // ไม่ส่ง created_by ตอน PATCH เลย — server/DB คงค่าเดิมไว้เองเพราะ UPDATE ไม่แตะคอลัมน์ที่ไม่ได้ส่งมา
    const savedRows = await page.evaluate(() => window.__savedRows);
    expect(savedRows[0].draft_no).toBe('PMD_EXIST');
  });

  // FIXED (2026-09-16, /code-review — confirmed N+1): draftRefreshCommentCounts() used to fire one
  // SB.getPromoDraftLineComments(draftNo, sku) call PER SKU LINE (Promise.all(_draftLines.map(...))) —
  // a document with N lines fired N concurrent queries just to populate a 💬 count badge.
  // getPromoDraftLineComments() now takes an optional sku, and the counts function fetches once for
  // the whole draft_no and groups client-side, matching draftRefreshLineRefData()'s existing pattern.
  test('draftRefreshCommentCounts() fetches all comments in one call, not one per SKU line', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      { draft_no: 'PMD_MULTILINE', doc_no: 'PC2569-0002', promo_name: 'หลายบรรทัด', status: 'draft', created_by: 'U1', other_costs_json: [], start_date: '2026-06-01', due_date: '2026-06-30' },
      [
        { draft_no: 'PMD_MULTILINE', cust_code: 'C001', sku: 'SKU1', unit_price: 90, start_date: '2026-06-01', due_date: '2026-06-30' },
        { draft_no: 'PMD_MULTILINE', cust_code: 'C001', sku: 'SKU2', unit_price: 90, start_date: '2026-06-01', due_date: '2026-06-30' },
        { draft_no: 'PMD_MULTILINE', cust_code: 'C001', sku: 'SKU3', unit_price: 90, start_date: '2026-06-01', due_date: '2026-06-30' },
      ],
    );
    await page.evaluate(() => {
      window.__commentCalls = [];
      SB.getPromoDraftLineComments = async (draftNo, sku) => {
        window.__commentCalls.push({ draftNo, sku });
        return sku
          ? []
          : [{ draft_no: 'PMD_MULTILINE', sku: 'SKU1', uid: 'U1', text: 'ok' }, { draft_no: 'PMD_MULTILINE', sku: 'SKU1', uid: 'U2', text: 'ok2' }];
      };
    });
    await page.evaluate(() => window.showPromoDraftModal('PMD_MULTILINE'));
    await page.waitForTimeout(100);
    const calls = await page.evaluate(() => window.__commentCalls);
    expect(calls).toEqual([{ draftNo: 'PMD_MULTILINE', sku: undefined }]); // exactly one call, no sku filter — not three
    await expect(page.locator('#draft-cmt-btn-0')).toContainText('2'); // grouped client-side from the one batched response
  });

  test('an approved document cannot be edited — fields disabled and no save/submit buttons, doc_no shown in header', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      { draft_no: 'PMD_APPROVED', doc_no: 'PC2569-0002', promo_name: 'โปรอนุมัติแล้ว', status: 'approved', created_by: 'U1', other_costs_json: [] },
      [{ draft_no: 'PMD_APPROVED', cust_code: 'C001', cust_name: 'เดอะมอลล์ บางนา', sku: 'SKU1', sku_name: 'สินค้า 1', unit_price: 90, normal_price: 100, start_date: '2026-06-01', due_date: '2026-06-30' }],
    );
    await page.evaluate(() => window.showPromoDraftModal('PMD_APPROVED'));
    await expect(page.locator('.cr-fullpage-header')).toContainText('อนุมัติแล้ว');
    await expect(page.locator('.cr-fullpage-header')).toContainText('PC2569-0002');
    await expect(page.locator('#draft-name')).toBeDisabled();
    await expect(page.locator('button', { hasText: 'บันทึกร่าง' })).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'ส่งอนุมัติ' })).toHaveCount(0);
  });

  test('a pending-approval document shows อนุมัติ/ไม่อนุมัติ actions for a manager', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      { draft_no: 'PMD_PENDING', doc_no: 'PC2569-0003', promo_name: 'โปรรออนุมัติ', status: 'pending_approval', created_by: 'U1', levels_json: [], current_level: 0, other_costs_json: [] },
      [{ draft_no: 'PMD_PENDING', cust_code: 'C001', cust_name: 'เดอะมอลล์ บางนา', sku: 'SKU1', sku_name: 'สินค้า 1', unit_price: 90, normal_price: 100, start_date: '2026-06-01', due_date: '2026-06-30' }],
    );
    await page.evaluate(() => { ROLE = 'sales_manager'; }); // bare assignment — ROLE is a top-level `let`, not a window property
    await page.evaluate(() => window.showPromoDraftModal('PMD_PENDING'));
    await expect(page.getByRole('button', { name: 'อนุมัติ', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ไม่อนุมัติ', exact: true })).toBeVisible();
  });

  test('approving the last level of a configured route escalates to the executive route when NPD is checked', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      {
        draft_no: 'PMD_LASTLEVEL', doc_no: 'PC2569-0004', promo_name: 'โปร NPD', status: 'pending_approval', created_by: 'U1',
        is_npd: 1, has_off_contract_cost: 0, has_marketing_cost: 0, other_costs_json: [],
        levels_json: [{ id: 'lv1', label: 'ขั้น 1', mode: 'any', approvers: [{ uid: 'MGR1', name: 'ผจก.', role: 'sales_manager', status: 'pending' }] }],
        current_level: 0,
      },
      [{ draft_no: 'PMD_LASTLEVEL', cust_code: 'C001', sku: 'SKU1', unit_price: 90, start_date: '2026-06-01', due_date: '2026-06-30' }],
    );
    await page.evaluate(() => {
      ROLE = 'sales_manager'; UID = 'MGR1';
      SB.getApprovalWorkflowTemplate = async (entity) => (entity === 'promo_draft_exec' ? [{ id: 'ex1', label: 'ผู้บริหาร', mode: 'any', approvers: [{ uid: 'EXEC1', name: 'MD', role: 'superadmin' }] }] : []);
      SB.updatePromoDraftHeader = async (draftNo, patch) => { window.__patch = { draftNo, ...patch }; return {}; };
      SB.audit = async () => {};
    });
    await page.evaluate(() => window.showPromoDraftModal('PMD_LASTLEVEL'));
    await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
    await page.waitForTimeout(50);
    const patch = await page.evaluate(() => window.__patch);
    expect(patch.status).toBe('pending_exec_approval'); // escalate แทนที่จะปิดเป็น approved ตรงๆ เพราะติ๊ก NPD ไว้
    expect(patch.levels_json[0].approvers[0].uid).toBe('EXEC1');
  });

  // FIXED (2026-09-16, /code-review — confirmed exploitable real bug): a document sitting in
  // pending_exec_approval with an EMPTY levels_json (the exec workflow was never configured — a real
  // state, since promo_draft_exec is a brand-new entity type with no seeded rows) used to let ANY
  // manager click "ผู้บริหาร: อนุมัติ" and finalize the document as 'approved' with zero real executive
  // sign-off, because `lvDone = !lv || (...)` treated "no level exists" as "already satisfied". This
  // defeated the entire point of the NPD/off-contract-cost/marketing-cost escalation checkboxes.
  test('clicking "ผู้บริหาร: อนุมัติ" is blocked (not silently approved) when no executive route is configured', async ({ page }) => {
    await openDraftModal(page);
    await stubExistingDoc(
      page,
      {
        draft_no: 'PMD_EXECEMPTY', doc_no: 'PC2569-0006', promo_name: 'โปร NPD ไม่มี route ผู้บริหาร', status: 'pending_exec_approval', created_by: 'U1',
        is_npd: 1, has_off_contract_cost: 0, has_marketing_cost: 0, other_costs_json: [],
        levels_json: [], current_level: 0,
      },
      [{ draft_no: 'PMD_EXECEMPTY', cust_code: 'C001', sku: 'SKU1', unit_price: 90, start_date: '2026-06-01', due_date: '2026-06-30' }],
    );
    await page.evaluate(() => {
      ROLE = 'sales_manager'; UID = 'MGR1';
      window.__updateCalls = [];
      SB.updatePromoDraftHeader = async (draftNo, patch) => { window.__updateCalls.push({ draftNo, ...patch }); return {}; };
      SB.audit = async () => {};
    });
    await page.evaluate(() => window.showPromoDraftModal('PMD_EXECEMPTY'));
    await page.getByRole('button', { name: 'ผู้บริหาร: อนุมัติ' }).click();
    await page.waitForTimeout(50);
    const updateCalls = await page.evaluate(() => window.__updateCalls);
    expect(updateCalls).toEqual([]); // ต้องไม่มีการเรียก updatePromoDraftHeader เลย — ไม่ปิดเป็น approved เด็ดขาด
  });

  test('the workflow-settings view lets you add a level with an approver, separate from the executive route', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      DB.set('users', [{ uid: 'MGR1', name: 'สมชาย จัดการ', role: 'sales_manager' }]);
      SB.getApprovalWorkflowTemplate = async () => [];
      SB.saveApprovalWorkflowTemplate = async () => true;
    });
    await page.evaluate(() => window.pgPromoDraftWorkflowSettings());
    await expect(page.locator('.ct2', { hasText: 'เส้นทางอนุมัติปกติ' })).toBeVisible();
    await expect(page.locator('.ct2', { hasText: 'ขั้นผู้บริหาร' })).toBeVisible();
    await page.locator('button', { hasText: '+ เพิ่มขั้น' }).first().click();
    await expect(page.locator('#pdwf-normal-lvls .card')).toHaveCount(1);
    await expect(page.locator('#pdwf-normal-lvls')).toContainText('สมชาย จัดการ (Sales Manager)'); // มีอยู่ใน dropdown ให้เลือก
  });

  test('copying from an existing document pre-fills the form as a brand-new draft (no doc_no yet)', async ({ page }) => {
    await openDraftModal(page);
    await page.evaluate(() => {
      SB.getPromoDraftHeaders = async () => ([
        { draft_no: 'PMD_SOURCE', doc_no: 'PC2569-0005', promo_name: 'โปรต้นฉบับ', status: 'approved', created_by: 'U1', keyed_by: 'U1', keyed_at: '2026-06-02T00:00:00Z' },
      ]);
      SB.getPromoDraftHeader = async () => ({ draft_no: 'PMD_SOURCE', doc_no: 'PC2569-0005', promo_name: 'โปรต้นฉบับ', status: 'approved', created_by: 'U1', other_costs_json: [] });
      SB.getPromoDraftLines = async () => ([
        { draft_no: 'PMD_SOURCE', cust_code: 'C001', cust_name: 'เดอะมอลล์ บางนา', sku: 'SKU1', sku_name: 'สินค้า 1', unit_price: 90, normal_price: 100, start_date: '2026-06-01', due_date: '2026-06-30' },
      ]);
    });
    await page.locator('button', { hasText: 'คัดลอกจากเอกสารเดิม' }).click();
    await expect(page.locator('.mt2', { hasText: 'คัดลอกจากเอกสารเดิม' })).toBeVisible();
    await page.locator('.mbox .cr-apv-item', { hasText: 'โปรต้นฉบับ' }).click();

    await expect(page.locator('#modal-bg')).toHaveClass(/hidden/); // mini picker closes
    await expect(page.locator('#draft-fp')).not.toHaveClass(/hidden/); // full-page stays open
    await expect(page.locator('#draft-name')).toHaveValue('โปรต้นฉบับ (คัดลอก)');
    await expect(page.locator('.cr-fullpage-header')).toContainText('สร้างใบเคาะราคา'); // ไม่ใช่ "แก้ไข" อีกต่อไป
    await expect(page.locator('.cr-fullpage-header')).toContainText('ร่าง'); // สถานะกลับเป็นร่างใหม่ ไม่ใช่ approved เดิม
  });

  test('the document list page is titled เอกสารใบเคาะราคา and each card has a คัดลอก button', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      SB.getApprovalWorkflowTemplate = async () => [];
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      SB.getPromoDraftHeaders = async () => ([
        { draft_no: 'PMD_L1', doc_no: 'PC2569-0006', promo_name: 'โปรลิสต์', status: 'draft', created_by: 'U1' },
      ]);
      SB.getPromoDraftLines = async () => ([
        { draft_no: 'PMD_L1', cust_code: 'C001', cust_name: 'เดอะมอลล์ บางนา', sku: 'SKU1', sku_name: 'สินค้า 1', unit_price: 90 },
      ]);
    });
    await page.evaluate(() => window.pgPromoDrafts());
    await expect(page.locator('.ct2', { hasText: 'เอกสารใบเคาะราคา' })).toBeVisible();
    await expect(page.locator('#promo-drafts-list')).toContainText('PC2569-0006');
    await expect(page.locator('#promo-drafts-list button', { hasText: '📋 คัดลอก' })).toBeVisible();
  });

  // ข้อ 2 (2026-09-14): ก่อนปิดสถานะ "คีย์เข้า Express แล้ว" ต้องเทียบทุกบรรทัดกับ promo_docs (มิเรอร์จาก
  // Express) ทั้ง 4 อย่าง — ลูกค้า/สินค้า/ราคา/ช่วงเวลา — ไม่บล็อกถ้าไม่ตรง แค่เตือนแล้วให้ผู้ใช้ยืนยันเอง
  test('marking as keyed-to-Express when everything matches shows all-green and confirms in one click', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      SB.getPromoDraftHeader = async () => ({ draft_no: 'PMD_KEY1', doc_no: 'PC2569-0010', status: 'approved', start_date: '2026-07-01', due_date: '2026-07-31' });
      SB.getPromoDraftLines = async () => ([
        { draft_no: 'PMD_KEY1', cust_code: 'C001', sku: 'SKU1', unit_price: 88.5 },
      ]);
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO777', unit_price: 88.5, start_date: '2026-07-01', due_date: '2026-07-31' },
      ]);
    });
    await page.evaluate(() => window.draftMarkKeyed('PMD_KEY1'));
    await expect(page.locator('.mt2', { hasText: 'ตรวจสอบก่อนปิดสถานะ' })).toBeVisible();
    await expect(page.locator('.mbox')).toContainText('✅');
    await expect(page.locator('.mbox')).toContainText('SO777');
    await expect(page.locator('.mbox')).toContainText('ตรงกับ Express ครบทุกรายการ');
    await expect(page.locator('.mbox')).not.toContainText('❌');

    await page.evaluate(() => {
      SB.updatePromoDraftHeader = async (draftNo, patch) => { window.__keyedPatch = { draftNo, ...patch }; return {}; };
    });
    await page.locator('.mbox button', { hasText: 'ยืนยัน คีย์เข้า Express แล้ว' }).click();
    const patch = await page.evaluate(() => window.__keyedPatch);
    expect(patch.draftNo).toBe('PMD_KEY1');
    expect(patch.status).toBe('keyed_to_express');
    await expect(page.locator('#modal-bg')).toHaveClass(/hidden/);
  });

  test('marking as keyed-to-Express when a line does not match Express warns with the diff but still allows confirming', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      document.getElementById('app').classList.remove('hidden');
      document.getElementById('ls').classList.add('hidden');
      SB.getPromoDraftHeader = async () => ({ draft_no: 'PMD_KEY2', doc_no: 'PC2569-0011', status: 'approved', start_date: '2026-07-01', due_date: '2026-07-31' });
      SB.getPromoDraftLines = async () => ([
        { draft_no: 'PMD_KEY2', cust_code: 'C001', sku: 'SKU1', unit_price: 100 }, // ใบเคาะราคาราคา 100
      ]);
      SB.getPromoDocsForOverlap = async () => ([
        { cust_code: 'C001', sku: 'SKU1', sonum: 'SO888', unit_price: 95, start_date: '2026-07-01', due_date: '2026-07-31' }, // Express คีย์ 95 (ต่างจาก 100)
      ]);
    });
    await page.evaluate(() => window.draftMarkKeyed('PMD_KEY2'));
    await expect(page.locator('.mbox')).toContainText('❌');
    await expect(page.locator('.mbox')).toContainText('SO888');
    await expect(page.locator('.mbox')).toContainText('ราคาต่างกัน');
    await expect(page.locator('.mbox')).toContainText('พบ 1 จาก 1 รายการที่ไม่ตรงกับ Express');

    // ปุ่มยืนยันต้องเปลี่ยนข้อความเตือนแต่ยังกดยืนยันต่อได้ (ไม่บล็อก)
    const confirmBtn = page.locator('.mbox button', { hasText: 'ยืนยันคีย์แล้ว (ทั้งที่ไม่ตรง)' });
    await expect(confirmBtn).toBeVisible();
    await page.evaluate(() => {
      SB.updatePromoDraftHeader = async (draftNo, patch) => { window.__keyedPatch = { draftNo, ...patch }; return {}; };
    });
    await confirmBtn.click();
    const patch = await page.evaluate(() => window.__keyedPatch);
    expect(patch.status).toBe('keyed_to_express'); // เตือนแต่ไม่บล็อก — ยืนยันได้ตามที่ยืนยันกับผู้ใช้ไว้
  });

  // ปรับหน้าตาเป็น letterhead (2026-09-16) — เอาชื่อเอกสาร/ชื่อรายการออกมาเป็น .doctitle/.docsub
  // แทน <h1> เดี่ยว, มีหัวจดหมายไทยซอสเซส (โลโก้+ชื่อบริษัท) เพิ่มด้วย
  test('PDF preview opens a printable window titled ใบเคาะราคา with the draft content', async ({ page, context }) => {
    await openDraftModal(page);
    await page.locator('#draft-name').fill('โปร PDF ทดสอบ');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('button', { hasText: 'PDF แนวนอน' }).click(),
    ]);
    await expect(popup.locator('.doctitle')).toContainText('ใบเคาะราคา');
    await expect(popup.locator('.docsub')).toContainText('โปร PDF ทดสอบ');
    await expect(popup.locator('.letterhead')).toContainText('ไทยซอสเซส');
  });

  // รหัสสินค้าขึ้นต้นด้วย "9" → รายการย่อย 1.1/1.2 (ข้อ 4.4, 2026-09-16, ยืนยันแล้ว: แต่ละรายการย่อยเป็น
  // สินค้าจริงมีราคา/ปริมาณของตัวเอง ไม่ใช่แค่ป้ายชื่อ) — ปุ่ม "+ ย่อย" โผล่เฉพาะบรรทัดหลักที่ sku ขึ้นต้น
  // ด้วย 9 เท่านั้น เลขลำดับคำนวณจากตำแหน่งในอาร์เรย์ล้วนๆ ไม่มี group id แยกในฐานข้อมูล
  test.describe('รหัสสินค้าขึ้นต้นด้วย 9 → รายการย่อย 1.1/1.2', () => {
    test('the "+ ย่อย" button only appears for a line whose SKU starts with 9, and toggles live while typing', async ({ page }) => {
      await openDraftModal(page);
      const skuInput = page.locator('#draft-lines-tbody tr').nth(0).locator('input[list="draft-sku-opts"]');
      await expect(page.locator('#draft-subitem-btn-0')).toBeHidden();
      await skuInput.fill('SKU1');
      await expect(page.locator('#draft-subitem-btn-0')).toBeHidden();
      await skuInput.fill('9001');
      await expect(page.locator('#draft-subitem-btn-0')).toBeVisible();
      await skuInput.fill('SKU1'); // ลบกลับเป็นรหัสธรรมดา ปุ่มต้องหายไปอีกครั้ง
      await expect(page.locator('#draft-subitem-btn-0')).toBeHidden();
    });

    test('clicking "+ ย่อย" inserts real product sub-lines numbered 1.1, 1.2 under the parent "1", and a later main line becomes "2"', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => { window._draftLines[0].sku = '9001'; window.draftRenderLines(); });
      await page.locator('#draft-subitem-btn-0').click();
      await page.locator('#draft-subitem-btn-0').click(); // เพิ่มรายการย่อยที่ 2 ต่อจากตัวแรก ไม่ใช่แทรกกลาง
      await page.evaluate(() => window.draftAddLine()); // บรรทัดหลักถัดไป (ไม่ใช่รายการย่อย)

      const nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1', '1.2', '2']);

      // รายการย่อยแต่ละอันเป็นสินค้าจริง กรอก SKU/ราคา/ปริมาณของตัวเองได้อิสระจากบรรทัดหลัก
      await page.evaluate(() => {
        window.draftLineField(1, 'sku', 'SKU-SUB-A');
        window.draftLineField(1, 'normalPrice', '50');
        window.draftLineField(2, 'sku', 'SKU-SUB-B');
        window.draftLineField(2, 'normalPrice', '60');
      });
      expect(await page.evaluate(() => window._draftLines[1].normalPrice)).toBe('50');
      expect(await page.evaluate(() => window._draftLines[2].normalPrice)).toBe('60');
    });

    test('removing the parent 9-code line cascades to remove its sub-items too', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => {
        window._draftLines[0].sku = '9001';
        window.draftRenderLines();
      });
      await page.locator('#draft-subitem-btn-0').click();
      await page.locator('#draft-subitem-btn-0').click();
      await page.evaluate(() => window.draftAddLine());
      expect(await page.evaluate(() => window._draftLines.length)).toBe(4);

      await page.locator('#draft-lines-tbody tr').nth(0).locator('button', { hasText: 'ลบ' }).click();
      const remaining = await page.evaluate(() => window._draftLines.map(l => l.isSubItem));
      expect(remaining).toEqual([false]); // เหลือแค่บรรทัดหลักตัวที่ 4 เดิม (ไม่ใช่รายการย่อย)
    });

    test('saving includes is_sub_item on each posted line, matching each line\'s isSubItem flag', async ({ page }) => {
      await openDraftModal(page);
      // เลือกสาขา + กรอกวันที่ trigger draftCheckOverlap()/draftRefreshLineRefData() จริง — ต้อง stub
      // ทั้ง 3 ตัวนี้ไม่งั้นยิง SB.* จริงไป server แล้ว 401 (ไม่มี session จริงในเทสต์) ซึ่ง apiFetch's
      // 401-handler จะเด้งกลับหน้า login (#app ซ่อน/#ls โผล่) กลางเทสต์ทันที
      await page.evaluate(() => {
        SB.getPromoDocsForOverlap = async () => ([]);
        SB.getPromoDraftsForOverlap = async () => ([]);
        SB.getSalesQtyForPairs = async () => ([]);
      });
      await page.fill('#draft-name', 'ทดสอบรายการย่อย');
      await page.fill('#draft-start', '2026-01-01');
      await page.fill('#draft-due', '2026-01-31');
      await page.locator('#draft-ms > button').click();
      await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
      await page.locator('#draft-ms-panel button', { hasText: 'ปิด' }).click(); // ปิด panel ก่อน กันบัง #draft-subitem-btn-0 ที่ตารางด้านล่าง

      await page.evaluate(() => {
        window._draftLines[0].sku = '9001';
        window.draftRenderLines();
      });
      await page.locator('#draft-subitem-btn-0').click();
      await page.evaluate(() => window.draftLineField(1, 'sku', 'SKU-SUB-A'));

      let posted = null;
      await page.evaluate(() => {
        SB.createPromoDraftHeader = async (fields) => ({ draft_no: 'PMD_NEW', doc_no: 'PC2569-0099', ...fields });
        SB.addPromoDraftLines = async (rows) => { window.__postedLines = rows; return rows; };
      });
      await page.locator('button', { hasText: 'บันทึกร่าง' }).click();
      await expect(page.locator('#draft-fp')).toBeHidden({ timeout: 3000 });
      posted = await page.evaluate(() => window.__postedLines);
      expect(posted.find(r => r.sku === '9001').is_sub_item).toBe(0);
      expect(posted.find(r => r.sku === 'SKU-SUB-A').is_sub_item).toBe(1);
    });

    test('loading an existing document reconstructs sub-item lines and their 1.1/1.2 numbering from is_sub_item', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => {
        SB.getPromoDraftHeader = async () => ({ draft_no: 'PMD_EXIST', doc_no: 'PC2569-0005', status: 'draft', promo_name: 'มีรายการย่อยอยู่แล้ว' });
        SB.getPromoDraftLines = async () => ([
          { cust_code: 'C001', sku: '9001', sku_name: 'ชุดราคาพิเศษ', is_sub_item: 0 },
          { cust_code: 'C001', sku: 'SKU-SUB-A', sku_name: 'สินค้าย่อย A', is_sub_item: 1 },
          { cust_code: 'C001', sku: 'SKU-SUB-B', sku_name: 'สินค้าย่อย B', is_sub_item: 1 },
        ]);
        SB.getPromoDraftAttachments = async () => [];
        SB.getAuditLog = async () => ([]);
      });
      await page.evaluate(() => window.showPromoDraftModal('PMD_EXIST'));
      await expect(page.locator('#draft-lines-tbody tr')).toHaveCount(3);
      const nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1', '1.2']);
    });
  });

  // ขยายเพิ่ม (2026-09-16): รายการย่อยระดับ 2 (1.1.1) เมื่อ SKU ของรายการย่อยชั้น 1 (1.1) เองก็ขึ้นต้นด้วย
  // "9" (จับสินค้าจริงหลายรายการรวมกันเช่นเดียวกับบรรทัดหลัก) — is_sub_item เก็บเป็นความลึก (0/1/2) แทน
  // boolean เดิม จำกัดไว้ที่ 2 ชั้นกันการซ้อนไม่รู้จบ
  test.describe('รายการย่อยของรายการย่อย (1.1.1) เมื่อ SKU ระดับ 1.1 ก็ขึ้นต้นด้วย 9', () => {
    test('the "+ ย่อย" button appears on a 1.1 line whose SKU starts with 9, but not on the 1.1.1 line it creates', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => { window._draftLines[0].sku = '9001'; window.draftRenderLines(); });
      await page.locator('#draft-subitem-btn-0').click(); // สร้างบรรทัด 1.1

      // 1.1 ยังไม่มี SKU ขึ้นต้นด้วย 9 -> ปุ่มซ่อนอยู่ก่อน
      await expect(page.locator('#draft-subitem-btn-1')).toBeHidden();
      await page.evaluate(() => window.draftLineField(1, 'sku', '9002'));
      const skuInput1 = page.locator('#draft-lines-tbody tr').nth(1).locator('input[list="draft-sku-opts"]');
      await skuInput1.fill('9002');
      await expect(page.locator('#draft-subitem-btn-1')).toBeVisible();

      await page.locator('#draft-subitem-btn-1').click(); // สร้างบรรทัด 1.1.1
      const nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1', '1.1.1']);

      // บรรทัด 1.1.1 (ชั้นลึกสุด) ต้องไม่มีปุ่ม "+ ย่อย" อีก แม้จะตั้ง SKU ขึ้นต้นด้วย 9 ก็ตาม (กันซ้อนไม่รู้จบ)
      await page.evaluate(() => window.draftLineField(2, 'sku', '9003'));
      const skuInput2 = page.locator('#draft-lines-tbody tr').nth(2).locator('input[list="draft-sku-opts"]');
      await skuInput2.fill('9003');
      await expect(page.locator('#draft-subitem-btn-2')).toBeHidden();
    });

    test('removing a 1.1 line cascades to remove its own 1.1.1 children, without touching sibling 1.2', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => { window._draftLines[0].sku = '9001'; window.draftRenderLines(); });
      await page.locator('#draft-subitem-btn-0').click(); // 1.1
      await page.locator('#draft-subitem-btn-0').click(); // 1.2
      await page.evaluate(() => {
        window.draftLineField(1, 'sku', '9002'); // 1.1 เองก็เป็นรหัสราคาพิเศษ
        window.draftLineField(2, 'sku', 'SKU-1.2');
      });
      await page.locator('#draft-lines-tbody tr').nth(1).locator('input[list="draft-sku-opts"]').fill('9002');
      await page.locator('#draft-subitem-btn-1').click(); // 1.1.1 ใต้ 1.1

      let nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1', '1.1.1', '1.2']);

      await page.locator('#draft-lines-tbody tr').nth(1).locator('button', { hasText: 'ลบ' }).click(); // ลบ 1.1
      const remainingSkus = await page.evaluate(() => window._draftLines.map(l => l.sku));
      expect(remainingSkus).toEqual(['9001', 'SKU-1.2']); // 1.1 กับ 1.1.1 หายไปด้วยกัน เหลือ 1 กับ 1.2 (เปลี่ยนเป็น 1.1)
      nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1']);
    });

    test('saving posts is_sub_item=2 for a 1.1.1 line', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => {
        SB.getPromoDocsForOverlap = async () => ([]);
        SB.getPromoDraftsForOverlap = async () => ([]);
        SB.getSalesQtyForPairs = async () => ([]);
      });
      await page.fill('#draft-name', 'ทดสอบรายการย่อยระดับ 2');
      await page.fill('#draft-start', '2026-01-01');
      await page.fill('#draft-due', '2026-01-31');
      await page.locator('#draft-ms > button').click();
      await page.locator('#draft-ms-list .ms-item', { hasText: 'C001' }).click();
      await page.locator('#draft-ms-panel button', { hasText: 'ปิด' }).click();

      await page.evaluate(() => { window._draftLines[0].sku = '9001'; window.draftRenderLines(); });
      await page.locator('#draft-subitem-btn-0').click(); // 1.1
      await page.evaluate(() => window.draftLineField(1, 'sku', '9002'));
      await page.locator('#draft-lines-tbody tr').nth(1).locator('input[list="draft-sku-opts"]').fill('9002');
      await page.locator('#draft-subitem-btn-1').click(); // 1.1.1
      await page.evaluate(() => window.draftLineField(2, 'sku', 'SKU-SUB-SUB'));

      await page.evaluate(() => {
        SB.createPromoDraftHeader = async (fields) => ({ draft_no: 'PMD_NEW2', doc_no: 'PC2569-0100', ...fields });
        SB.addPromoDraftLines = async (rows) => { window.__postedLines = rows; return rows; };
      });
      await page.locator('button', { hasText: 'บันทึกร่าง' }).click();
      await expect(page.locator('#draft-fp')).toBeHidden({ timeout: 3000 });
      const posted = await page.evaluate(() => window.__postedLines);
      expect(posted.find(r => r.sku === '9001').is_sub_item).toBe(0);
      expect(posted.find(r => r.sku === '9002').is_sub_item).toBe(1);
      expect(posted.find(r => r.sku === 'SKU-SUB-SUB').is_sub_item).toBe(2);
    });

    test('loading an existing document reconstructs 1.1.1 numbering from is_sub_item=2', async ({ page }) => {
      await openDraftModal(page);
      await page.evaluate(() => {
        SB.getPromoDraftHeader = async () => ({ draft_no: 'PMD_EXIST2', doc_no: 'PC2569-0006', status: 'draft', promo_name: 'มีรายการย่อยระดับ 2 อยู่แล้ว' });
        SB.getPromoDraftLines = async () => ([
          { cust_code: 'C001', sku: '9001', sku_name: 'ชุดราคาพิเศษ', is_sub_item: 0 },
          { cust_code: 'C001', sku: '9002', sku_name: 'ชุดย่อยราคาพิเศษ', is_sub_item: 1 },
          { cust_code: 'C001', sku: 'SKU-SUB-SUB', sku_name: 'สินค้าย่อยของย่อย', is_sub_item: 2 },
        ]);
        SB.getPromoDraftAttachments = async () => [];
        SB.getAuditLog = async () => ([]);
      });
      await page.evaluate(() => window.showPromoDraftModal('PMD_EXIST2'));
      await expect(page.locator('#draft-lines-tbody tr')).toHaveCount(3);
      const nums = await page.locator('#draft-lines-tbody tr').evaluateAll(rows => rows.map(r => r.querySelector('.draft-line-num').textContent.trim()));
      expect(nums).toEqual(['1', '1.1', '1.1.1']);
      // บรรทัด 1.1 (SKU 9002) ต้องยังกดเพิ่มรายการย่อยต่อได้ (ปุ่มโผล่) ส่วน 1.1.1 ต้องไม่มีปุ่มอีก
      await expect(page.locator('#draft-subitem-btn-1')).toBeVisible();
      await expect(page.locator('#draft-subitem-btn-2')).toBeHidden();
    });
  });
});
