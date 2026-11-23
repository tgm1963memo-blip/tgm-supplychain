// @ts-check
const { test, expect } = require('@playwright/test');

// Sales Overview "เทียบปีที่แล้ว" (2026-10-09, ผู้ใช้แจ้ง: เปลี่ยนตัวกรอง Sales แล้วปี 2569 กับ 2568 แสดงยอดเท่ากัน)
// 1) a YoY fetch that finishes after the user moved to another period must be discarded, not written
//    into _sdApi.yoy (it used to be — and then sdLoad/sdLoadYear saw yoy as "already loaded")
// 2) when the current figures are invoice-based, last year must be invoice-based too, and the
//    per-Sales filter must filter last year's invoices by slm_code (it used to filter order rows,
//    a different source with no TGM factory / BP-xx codes)
test.describe('Sales Overview YoY', () => {
  async function openPage(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      ROLE = 'superadmin'; UID = 'TESTUID'; CURRENT_USER = { uid: 'TESTUID', role: 'superadmin' };
      DB.set('users', [{ uid: 'TESTUID', name: 'Test Admin', role: 'superadmin' }]);
      window.sdRender = () => {};
      window._scopeNow = () => null;
      window._sdLoadSlm = () => '';
    });
  }

  test('a YoY result that resolves after the period changed is discarded', async ({ page }) => {
    await openPage(page);
    const yoy = await page.evaluate(async () => {
      let release;
      window._sbSalesRows = () => new Promise(r => { release = r; });
      _sd.pt = 'year'; _sd.cy_y = 2569; _sdApi.invoiceBased = false; _sdApi.yoy = null;
      _sdStartYoY();
      // user navigates to 2568 while the 2568-as-last-year fetch is still in flight
      _sd.cy_y = 2568; _sdApi.yoy = null; _sdYoYSeq++;
      release([{ slm_id: 'A', ym: '2025-01', amount: 999, qty: 1, cust_code: 'C1', prod_code: 'P1' }]);
      await new Promise(r => setTimeout(r, 50));
      return _sdApi.yoy;
    });
    expect(yoy).toBeNull();
  });

  test('invoice-based view: last year comes from invoices and follows the Sales filter', async ({ page }) => {
    await openPage(page);
    const res = await page.evaluate(async () => {
      window._sbSalesRows = async () => [];
      window._sdBpLines = async () => [];
      window._chainSwap = async () => null;
      window._sdInvRange = async () => [
        { company: 'TSS-68', ym: '2025-10', cust_code: 'C1', slm_code: 'A', amount: 100, invoice_count: 2 },
        { company: 'BP-TGM', ym: '2025-10', cust_code: 'C2', slm_code: 'BP-K3', amount: 300, invoice_count: 1 },
      ];
      _sd.pt = 'month'; _sd.cy = 2569; _sd.cm = 9; _sdApi.invoiceBased = true; _sdApi.yoy = null;
      _sdStartYoY();
      await new Promise(r => setTimeout(r, 50));
      const all = _sdApi.yoy && { total: _sdApi.yoy.total, invoices: _sdApi.yoy.invoices };
      // current period: filtered by the person who owns codes A + BP-K3, showing only A's invoices this year
      _sdApi.loaded = true; _sdApi._slmId = ''; _sdApi._rows = [];
      _sdApi._invRows = [{ company: 'TSS', ym: '2026-10', cust_code: 'C1', slm_code: 'A', amount: 50, invoice_count: 1 }];
      _sdApi._invRowsSlm = _sdApi._invRows; _sdApi._filt = null;
      window._sdEffSlm = () => 'BP-K3';
      const F = _sdFiltered();
      return { all, cur: F.total, prev: F.yoy.total };
    });
    expect(res.all).toEqual({ total: 400, invoices: 3 });
    expect(res.cur).toBe(0);
    expect(res.prev).toBe(300);
  });

  // (2026-10-20) โหมดกำหนดเอง: ปีที่แล้วต้องมาจากใบกำกับรายวันช่วงเดียวกันของปีก่อน (เดิมใช้แถวออเดอร์จาก sales_transactions
  // ที่กรองคอลัมน์ผิด → ดึงทั้งตาราง ยอด 2568 โหลดไม่จบ)
  test('custom range: last year comes from daily invoices of the same dates a year earlier', async ({ page }) => {
    await openPage(page);
    const res = await page.evaluate(async () => {
      let asked = null;
      window._sbSalesRows = async () => [];
      window._sdBpLines = async () => [];
      window._chainSwap = async () => null;
      window._sdInvDays = async (from, to) => { asked = [from, to]; return [{ company: 'TSS-68', cust_code: 'C1', slm_code: 'A', amount: 700, invoice_count: 4 }]; };
      _sd.pt = 'custom'; _sd.dateFrom = '2026-10-01'; _sd.dateTo = '2026-10-20'; _sdApi.invoiceBased = true; _sdApi.yoy = null;
      _sdStartYoY();
      await new Promise(r => setTimeout(r, 50));
      return { asked, total: _sdApi.yoy && _sdApi.yoy.total, inv: _sdApi.yoy && _sdApi.yoy.invoiceBased };
    });
    expect(res).toEqual({ asked: ['2025-10-01', '2025-10-20'], total: 700, inv: true });
  });
});
