const { test } = require('node:test');
const assert = require('node:assert/strict');
const { weightFromName } = require('../lib/weightFromName');

// น้ำหนักจากชื่อสินค้าเมื่อ WMS ยังไม่มี weight_per_unit (2026-10-14) — ค่าคาดหวังตรงกับ WMS จริงของรหัสเดียวกัน
test('weight per sold unit is read from the product name', () => {
  assert.equal(weightFromName('ฮอทดอกรมควัน (รวมพิเศษ) 500 กรัม', 'แพ็ค/แพ'), 0.5);
  assert.equal(weightFromName('สโมคเบค่อน 2000 กรัม', 'ซอง/แพ'), 2);
  assert.equal(weightFromName('คอทเทจเบค่อน1000ก.TSSแช่แข็ง(10กก/กล่อง)', 'กล่อง/กล'), 10);
  assert.equal(weightFromName('สโมคเบค่อน(บีท)500กรัม(10แพ็ค/ลัง)', 'ลง'), 5);
  assert.equal(weightFromName('สโมคเบค่อน6นิ้วพลัส500ก.TGM(10แพ็คลัง)', 'ลง'), 5);
  assert.equal(weightFromName('แพนเชตต้า (สไลซ์หนา 5mm) 100กรัม(1กล่อง/10แพ็ค)', 'ลง'), 1);
  assert.equal(weightFromName('เบค่อน1000g.x10ซอง', 'ลัง/ลง'), 10);
  // ลัง/กล่องที่ไม่บอกจำนวนแพ็ค → ไม่เดา (น้ำหนักต่อแพ็ค ≠ ต่อลัง)
  assert.equal(weightFromName('พิซซ่าเปปเปอร์โรนี 250กรัม', 'กล'), null);
  // ไม่มีน้ำหนักในชื่อ
  assert.equal(weightFromName('ทีจีเอ็มอาหารพร้อมทาน 99บาท(C', 'แพ'), null);
  assert.equal(weightFromName('เปปเปอร์โรนี่(แท่ง)', 'แท'), null);
  assert.equal(weightFromName('', 'แพ'), null);
});
