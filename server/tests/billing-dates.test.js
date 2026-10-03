const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// กฎวันรับวางบิล (ลงทะเบียนลูกค้า, 2026-09-30) — ฟังก์ชันอยู่ฝั่ง client (index.html) จึงดึงซอร์สของฟังก์ชันมารันใน vm
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `ไม่พบ ${name} ใน index.html`);
  let i = html.indexOf('{', html.indexOf(')', start)), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
const ctx = vm.createContext({});
vm.runInContext(['crBillMatch', '_crShiftWeekend', 'crNextBillingDates'].map(fnSource).join('\n') + '\nthis.next = crNextBillingDates;', ctx);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const next = (rules, from, n, shift = '') => Array.from(ctx.next(rules, new Date(...from), n, shift), iso);

test('weekly rule: every Wednesday (from date counts when it matches)', () => {
  assert.deepEqual(next([{ type: 'weekly', days: [3] }], [2026, 9, 1], 3), ['2026-10-07', '2026-10-14', '2026-10-21']);
  assert.deepEqual(next([{ type: 'weekly', days: [3] }], [2026, 9, 7], 1), ['2026-10-07']);
});

test('monthday rule: day 31 falls back to month end, "last" = month end', () => {
  assert.deepEqual(next([{ type: 'monthday', days: [31] }], [2027, 1, 1], 3), ['2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(next([{ type: 'monthday', days: ['last'] }], [2028, 1, 1], 2), ['2028-02-29', '2028-03-31']); // ปีอธิกสุรทิน
  assert.deepEqual(next([{ type: 'monthday', days: [10, 25] }], [2026, 9, 11], 3), ['2026-10-25', '2026-11-10', '2026-11-25']);
});

test('nth weekday rule: 2nd Friday and last Friday of the month', () => {
  assert.deepEqual(next([{ type: 'nth_weekday', n: 2, weekday: 5 }], [2026, 9, 1], 3), ['2026-10-09', '2026-11-13', '2026-12-11']);
  assert.deepEqual(next([{ type: 'nth_weekday', n: 'last', weekday: 5 }], [2026, 9, 1], 3), ['2026-10-30', '2026-11-27', '2026-12-25']);
});

test('weekend shift: next / previous business day, duplicates merged, multiple rules combined', () => {
  // 25 ต.ค. 69 = อาทิตย์
  assert.deepEqual(next([{ type: 'monthday', days: [25] }], [2026, 9, 1], 1), ['2026-10-25']);
  assert.deepEqual(next([{ type: 'monthday', days: [25] }], [2026, 9, 1], 1, 'next'), ['2026-10-26']);
  assert.deepEqual(next([{ type: 'monthday', days: [25] }], [2026, 9, 1], 1, 'prev'), ['2026-10-23']);
  // 24 (เสาร์) และ 26 (จันทร์) เลื่อนไปวันจันทร์เดียวกัน → นับครั้งเดียว
  assert.deepEqual(next([{ type: 'monthday', days: [24, 26] }], [2026, 9, 20], 2, 'next'), ['2026-10-26', '2026-11-24']);
  assert.deepEqual(next([{ type: 'weekly', days: [3] }, { type: 'nth_weekday', n: 2, weekday: 5 }], [2026, 9, 1], 4), ['2026-10-07', '2026-10-09', '2026-10-14', '2026-10-21']);
  // วันที่เลื่อนแล้วตกก่อนวันเริ่ม ไม่นับ
  assert.deepEqual(next([{ type: 'monthday', days: [25] }], [2026, 9, 25], 1, 'prev'), ['2026-11-25']);
  assert.deepEqual(next([], [2026, 9, 1], 3), []);
});
