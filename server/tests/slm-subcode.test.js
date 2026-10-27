const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSlmCode } = require('../jobs/importFromExpress');

// รหัส Sales ย่อย (2026-10-27): 110-x เก็บตามจริง (บัญชี sales-hotel = 110-2) · รหัสอื่นยังรวบเหลือ 3 ตัวแบบเดิม
test('normalizeSlmCode keeps 110 sub-codes, collapses others as before', () => {
  assert.equal(normalizeSlmCode(' 110-2 '), '110-2');
  assert.equal(normalizeSlmCode('110-1'), '110-1');
  assert.equal(normalizeSlmCode('110'), '110');
  assert.equal(normalizeSlmCode('17-1'), '17-');
  assert.equal(normalizeSlmCode('1034'), '103');
  assert.equal(normalizeSlmCode('ON-001'), 'ON-001');
  assert.equal(normalizeSlmCode(''), '');
});
