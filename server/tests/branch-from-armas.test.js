const { test } = require('node:test');
const assert = require('node:assert/strict');
const { branchFromArmas } = require('../jobs/importFromExpress');

// ชื่อสาขาจากที่อยู่ ARMAS (2026-10-12) — ตัวอย่างจริงจาก Express
test('branchFromArmas picks branch names and ignores phone/province/delivery notes', () => {
  assert.equal(branchFromArmas({ ADDR03: '(สาขาพาราไดร์)' }), 'พาราไดร์');
  assert.equal(branchFromArmas({ ADDR03: '(พาชิโอ\u00a0ลาดกระบัง)' }), 'พาชิโอ ลาดกระบัง');
  assert.equal(branchFromArmas({ ADDR03: '(พระราม 4) รอบส่ง จ,พ,ศ' }), 'พระราม 4');
  assert.equal(branchFromArmas({ ADDR01: 'บจ.ซีพี (สาขา ราไวย์ 2)', ADDR03: 'จ.ภูเก็ต 83000' }), 'ราไวย์ 2');
  assert.equal(branchFromArmas({ ADDR03: 'สาขานวรัฐ ตู้ TGM' }), 'นวรัฐ');
  for (const junk of ['โทร.085-251-3904', 'จ.ภูเก็ต   83000', 'เขตห้วยขวาง กรุงเทพมหานคร', '(สินค้า แพค TGM)', 'รอบส่ง อังคาร,พฤหัส', 'สาขาใหม่เริ่ม 1/4/67', 'สำนักงานใหญ่', '(สาขาที่ 00001)'])
    assert.equal(branchFromArmas({ ADDR03: junk }), null, junk);
});
