// @ts-check
const { test, expect } = require('@playwright/test');

// Sales Overview (2026-11-27, ผู้ใช้แจ้ง "การดึงข้อมูล / filter / ค้นหา ยังมี error" + "กำหนดเองรายวันไม่ขึ้นวันที่ระบุ"
// + ขอ "แสดงยอดขายเฉพาะลูกค้าที่กำหนดได้") — ใช้ฟังก์ชันจริงของหน้า แทนที่เฉพาะตัวดึงข้อมูล
test.describe('Sales Overview filters and loading', () => {
  async function openPage(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      ROLE = 'superadmin'; UID = 'TESTUID'; CURRENT_USER = { uid: 'TESTUID', role: 'superadmin' };
      DB.set('users', [{ uid: 'TESTUID', name: 'Test Admin', role: 'superadmin' }]);
      window._scopeNow = () => null;
      window._scopeMulti = () => true;
      window.myScopeKey = () => '';
      window._sdLoadSlm = () => '';
    });
  }

  test('customer filter narrows totals, customers and last year to the chosen codes', async ({ page }) => {
    await openPage(page);
    const res = await page.evaluate(() => {
      window.sdRender = () => {};
      _sd.slmF = ''; _sd.mgrView = true; _sd.pt = 'month';
      Object.assign(_sdApi, { loaded: true, invoiceBased: true, _slmId: '', _rows: [], _bpRows: [], _filt: null, _buildCacheKey: 'k',
        _invRows: [
          { company: 'TSS', ym: '2026-11', cust_code: 'C1', slm_code: 'A', amount: 100, invoice_count: 2 },
          { company: 'TSS', ym: '2026-11', cust_code: 'C2', slm_code: 'A', amount: 300, invoice_count: 1 },
          { company: 'TSS', ym: '2026-11', cust_code: 'C3', slm_code: 'B', amount: 50, invoice_count: 1 },
        ] });
      _sdApi._invRowsSlm = _sdApi._invRows;
      _sdApi.yoy = { _rows: [], invoiceBased: true, _invRows: [{ company: 'TSS-68', cust_code: 'C2', slm_code: 'A', amount: 70, invoice_count: 1 }, { company: 'TSS-68', cust_code: 'C3', slm_code: 'B', amount: 9, invoice_count: 1 }] };
      _sdApi.yoy._invRowsSlm = _sdApi.yoy._invRows;
      const none = _sdFiltered();
      _sd.custF = 'C2,C3';
      const F = _sdFiltered();
      const codes = F.custs.flatMap(c => (c.branches || []).map(b => b.c)).sort();
      // ใช้ร่วมกับตัวกรอง Sales: ต้องตรงทั้งคู่
      _sd.slmF = 'B'; _sdApi._filt = null;
      const both = _sdFiltered();
      return { none, total: F.total, invoices: F.invoices, codes, yoy: F.yoy.total, both: both.total, bothSlm: both.slm };
    });
    expect(res.none).toBeNull();
    expect(res).toMatchObject({ total: 350, invoices: 2, codes: ['C2', 'C3'], yoy: 79, both: 50, bothSlm: 'B' });
  });

  test('switching tab in custom-range mode keeps the chosen dates (no month reload)', async ({ page }) => {
    await openPage(page);
    const called = await page.evaluate(() => {
      document.getElementById('ct').innerHTML = '<div id="sd-root"><div class="tab" id="t1"></div></div>';
      let monthLoads = 0;
      window.sdLoad = () => { monthLoads++; };
      window.sdRender = () => {};
      _sd.pt = 'custom'; _sdApi.loaded = true; _sdApi.rangeMode = 'monthly'; _sdApi._rows = [];
      sdTab(document.getElementById('t1'), 'cust');
      return monthLoads;
    });
    expect(called).toBe(0);
  });

  test('changing company keeps Year / custom period instead of jumping back to this month', async ({ page }) => {
    await openPage(page);
    const pt = await page.evaluate(() => {
      window.sdLoadYear = async () => {}; window.sdLoad = async () => {}; window.sdLoadCustom = async () => {};
      window.sdRender = () => {};
      _sd.pt = 'year'; _sd.cy_y = 2568;
      sdSetCo('tss');
      return [_sd.pt, _sd.cy_y];
    });
    expect(pt).toEqual(['year', 2568]);
  });

  test('a month without order rows does not reload forever', async ({ page }) => {
    await openPage(page);
    const loads = await page.evaluate(async () => {
      let n = 0;
      window.sdRender = () => {};
      window._sdStartYoY = () => {};
      window._loadSalesFromSupabase = async () => {
        n++;
        Object.assign(_sdApi, { loaded: true, invoiceBased: false, month: _sdApiMonth(), monthly: [{ ym: '2026-10', total: 5 }] });
      };
      _sd.pt = 'month'; _sd.cm = 11; _sd.cy = 2569; _sd._autoLatest = false; // ผู้ใช้กด › ไปเดือนที่ยังไม่มีข้อมูล
      await sdLoad();
      await new Promise(r => setTimeout(r, 100));
      return n;
    });
    expect(loads).toBe(1);
  });

  test('product / salesperson search survives numeric or empty names', async ({ page }) => {
    await openPage(page);
    const html = await page.evaluate(() => {
      document.getElementById('ct').innerHTML = '<div id="sd-ta"></div>';
      Object.assign(_sdApi, { loaded: true, invoiceBased: false, _rows: [], _filt: null, total: 10, yoy: null });
      window._sdEnsureBuilt = () => {};
      _sdApi.prods = [{ n: 'กลุ่ม', _tot: 10, it: [{ n: null, c: 10154, _tot: 10, custs: [] }] }];
      _sdApi.slms = [{ name: null, code: 101, _tot: 10, custs: [] }];
      _sd.q = '1015'; _sd.slmF = ''; _sd.custF = '';
      sdProd();
      const prod = document.getElementById('sd-ta').innerHTML.includes('กลุ่ม');
      _sd.q = '10';
      sdSlm();
      return { prod, slm: document.getElementById('sd-ta').innerHTML.length > 0 };
    });
    expect(html).toEqual({ prod: true, slm: true });
  });
});
