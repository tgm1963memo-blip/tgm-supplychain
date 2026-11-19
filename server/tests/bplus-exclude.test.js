'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { excludeNonSalesSkus } = require('../jobs/importFromBplus');

test('Bplus: 99-1 / 99-7 / 99-8 are removed from header totals, documents and lines', () => {
  const k = { d: '2026-09-30', cust_code: 'YA-005', slmn: 'S1', ic: 0 };
  const data = {
    monthly: [
      // วัน/ลูกค้าเดียวกัน: ใบ 99-1 ล้วน (1,000 + VAT 70) + ใบผสมสินค้า 500 กับ 99-1 200 (VAT 49)
      { ...k, amount: 1700, invoice_count: 2, cn_count: 0, cn_amount: 0, vat_amount: 119, cn_vat: 0 },
      // ลูกค้าที่มีแต่ 99-1 = แถวหายไปทั้งแถว
      { d: '2026-07-01', cust_code: 'YVD-01-PG', slmn: 'S2', ic: 0, amount: 300, invoice_count: 1, cn_count: 0, cn_amount: 0, vat_amount: 0, cn_vat: 0 },
    ],
    lines: [
      { ...k, sku: '99-1', unit: 'EA', qty: 2, qty_base: 2, amount: 1200 },
      { ...k, sku: '10140-3', unit: 'แพ็ค', qty: 5, qty_base: 5, amount: 500 },
      { d: '2026-07-01', cust_code: 'YVD-01-PG', slmn: 'S2', ic: 0, sku: '99-1', unit: 'EA', qty: 1, qty_base: 1, amount: 300 },
    ],
    docs: [
      { ...k, doc_key: 'A', amount: 1000, vat_amount: 70, is_cn: 0 },
      { ...k, doc_key: 'B', amount: 700, vat_amount: 49, is_cn: 0 },
      { d: '2026-07-01', cust_code: 'YVD-01-PG', slmn: 'S2', ic: 0, doc_key: 'C', amount: 300, vat_amount: 0, is_cn: 0 },
    ],
    docLines: [
      { doc_key: 'A', sku: '99-1', amount: 1000 },
      { doc_key: 'B', sku: '10140-3', amount: 500 },
      { doc_key: 'B', sku: '99-1', amount: 200 },
      { doc_key: 'C', sku: '99-1', amount: 300 },
    ],
  };
  excludeNonSalesSkus(data);
  assert.equal(data.monthly.length, 1);
  assert.deepEqual([data.monthly[0].amount, data.monthly[0].invoice_count, data.monthly[0].vat_amount], [500, 1, 35]);
  assert.deepEqual(data.lines.map((l) => l.sku), ['10140-3']);
  assert.deepEqual(data.docs.map((d) => [d.doc_key, d.amount, d.vat_amount]), [['B', 500, 35]]);
  assert.deepEqual(data.docLines.map((l) => l.sku), ['10140-3']);
});
