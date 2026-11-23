'use strict';

const { guessExecChannel } = require('./execChannel');

// ประเภทธุรกิจของลูกค้า (2026-10-07, ผู้ใช้ขอ) — แยกจาก customer_profiles.category ซึ่งเป็นข้อความอิสระที่ปนหลายความหมาย
// (ประเภทธุรกิจ "ร้านอาหาร"/"โรงแรม", ชื่อห้าง "บิ๊กซี"/"Makro TSS", วิธีขาย "ตู้สด"/"ฝากขาย") และหน้าใบเคาะราคายังใช้อยู่
// และแยกจาก exec_channel (8 หมวดของ Dashboard ผู้บริหาร ซึ่งรวมร้านอาหาร/โรงแรม/เบเกอรี่ไว้ใน "ร้านค้าทั่วไป")
// ค่าที่เก็บใน customer_profiles.business_type คือ key ด้านล่าง (label เปลี่ยนได้โดยไม่ต้องย้ายข้อมูล)
// business_type_source: 'manual' = คนตั้งเอง (ห้ามระบบเดาทับ), 'auto' = ระบบเดาจาก guessBusinessType()
const BUSINESS_TYPES = [
  { key: 'modern_trade', label: 'Modern Trade (ห้าง/ซูเปอร์ฯ)' },
  { key: 'restaurant', label: 'ร้านอาหาร/คาเฟ่' },
  { key: 'hotel', label: 'โรงแรม/รีสอร์ท/คลับ' },
  { key: 'bakery', label: 'เบเกอรี่' },
  { key: 'catering', label: 'Catering/จัดเลี้ยง' },
  { key: 'food_processor', label: 'ผู้ผลิต/แปรรูปอาหาร' },
  { key: 'retail', label: 'ร้านค้าทั่วไป/ค้าส่ง' },
  { key: 'agent', label: 'เอเย่นต์/ตัวแทนจำหน่าย' },
  { key: 'export', label: 'ส่งออก/ต่างประเทศ' },
  { key: 'online', label: 'Online' },
  { key: 'direct', label: 'ไดเร็คเซลส์/รายบุคคล' },
  { key: 'employee', label: 'พนักงาน' },
  { key: 'company_shop', label: 'Shop ของบริษัท' },
  { key: 'affiliate', label: 'บริษัทในเครือ' },
  { key: 'other', label: 'อื่นๆ (ตัวอย่าง/ออกบูธ)' },
];
const BUSINESS_TYPE_KEYS = new Set(BUSINESS_TYPES.map((t) => t.key));

const MALL_RE = /เซ็นทรัล\s*ฟุ้ด|เซ็นทรัล\s*ฟู้ด\s*รีเทล|central\s*food|tops|ท็อปส์|บิ๊กซี|big\s*c|วิลล่า|villa|โลตัส|lotus|เดอะมอลล์|the\s*mall|อิออน|aeon|ลอว์สัน|lawson|ฟู้ดแลนด์|foodland|ยูเอฟเอ็ม|ufm|ซี\.จ|cj\s*more|ซุปเปอร์ชีป|ไอคอนสยาม|iconsiam|มิตซูโคชิ|ซีพี\s*ออลล์|7-?eleven|เซเว่น|gourmet|กูร์เมต์|max\s*valu|แม็กซ์\s*แวลู|rimping|ริมปิง|ภูเก็ตโกรเซอรี่|ซี\.เจ|makro|แม็คโคร|แม็กโคร|แมคโคร|แอ็กซ์ตร้า|เอ็มโพเรี่ยม|สยามพารากอน|go\s*wholesale/i;
const SHOP_RE = /สุทธิดา|สุธิดา|shop\s*พระราม\s*3|shop\s*โรงงาน|tgm\.?\s*shop|ที\.จี\.เอ็ม\.\s*ช็อป|ซุปเปอร์\s*โรงงาน|pos\s*ซุปเปอร์/i;
const AFFILIATE_RE = /บริษัทในเครือ|ไทย-เยอรมัน\s*มีท|^ไทย-เยอรมัน$|ไทยซอสเซส|ทีจี\s*โคลด์\s*สตอเรจ/;
// ไทยซอสเซส มีทซัพพลาย นับเป็นยอดขาย ไม่ใช่บริษัทในเครือ (2026-11-04, ผู้ใช้สั่ง) — ไทยซอสเซส มาร์เก็ตติ้ง ยังเป็นบริษัทในเครือ
const NOT_AFFILIATE_RE = /ไทยซอสเซส\s*มีท\s*ซัพพลาย/;
const OTHER_RE = /เบิกตัวอย่าง|ออกบูธ|(^|\|\s*)วัด/;
const HOTEL_RE = /โรงแรม|hotel|resort|รีสอร์ท|คันทรี่\s*คลับ|country\s*club|กอล์ฟ|golf|อพาร์ท|apartment|เรสซิเดนซ์|residence|โฮเทล|โฮสเทล|hostel|ฮอสพิแทลลิตี้|hospitality/i;
const CATERING_RE = /เคเทอ|catering|จัดเลี้ยง|เอ็กซิบิชั่น|exhibition/i;
const BAKERY_RE = /เบเกอรี่|bakery|เบเกอร์|เบรด|bread|ขนม|เค้ก|cake|patisserie|ยามาซากิ/i;
// ต้นรายการ = เครือร้านอาหารรายใหญ่ที่ชื่อบริษัทไม่บอกประเภท (ตรวจกับลูกค้ายอดสูงจริง 2026-10-07)
const RESTAURANT_RE = /ไมเนอร์\s*ฟู้ด|ฟู้ดแพชชั่น|food\s*passion|ฮาวี\s*ลอจิสติกส์|ร้านอาหาร|ภัตตาคาร|restaurant|เรสเต|เรสโต|เรสทัว|คาเฟ่|cafe|café|coffee|คอฟฟี่|kitchen|คิทเช่น|steak|สเต็ก|pizza|พิซซ่า|บาร์บีคิว|bbq|barbecue|grill|กริล|bistro|บิสโตร|brew|บรูเออรี|บริวเวอรี่|eatery|อีทเทอรี|เบอร์เกอร์|burger|ลาบ|ซูชิ|sushi|ราเมน|ramen|ชาบู|shabu|ยากินิกุ|อิซากายะ|izakaya|trattoria|pub\b|ผับ|บาร์\s|\bbar\b|แบล็ค\s*แคนยอน|f\s*&\s*b|เอฟแอนด์บี|ฟู้ด\s*แอนด์\s*เบฟ|food\s*and\s*bev/i;
const FOOD_PROCESSOR_RE = /ซีพีแรม|cpram|นิสชิน|nisshin|เอ็นเอสแอล|nsl\s*food|เคซีจี|แปรรูป|อุตสาหกรรมอาหาร/i;

function guessBusinessType({ code = '', name = '', category = '', corporate = '', execChannel = '', hasConsi = false, hasExport = false } = {}) {
  const cat = String(category || '').trim();
  const corp = String(corporate || '').trim();
  const all = `${name} | ${cat} | ${corp}`;
  if (execChannel === 'shop_factory' || execChannel === 'shop_rama3' || SHOP_RE.test(all)) return 'company_shop';
  // เบิกตัวอย่าง/ออกบูธ ก่อนบริษัทในเครือ — รหัสเบิกตัวอย่างบางรายตั้งชื่อเป็นบริษัทในเครือ (01-IH-0007 ไทยซอสเซสพัทยา)
  if (OTHER_RE.test(`${cat} | ${corp} | ${name}`)) return 'other';
  if ([cat, corp, name].some((v) => AFFILIATE_RE.test(String(v).trim()) && !NOT_AFFILIATE_RE.test(String(v)))) return 'affiliate';
  if (/พนักงาน/.test(`${cat} | ${corp}`) || /^20-LG/.test(code)) return 'employee';
  if (hasExport || execChannel === 'export_agent') return 'export';
  if (/^online$/i.test(cat) || /^online$/i.test(corp) || execChannel === 'online') return 'online';
  if (/เอเย่น|agent/i.test(`${cat} | ${corp}`) || execChannel === 'local_agent') return 'agent';
  // Category เดิมที่เป็นประเภทธุรกิจจริงอยู่แล้ว (ผู้ใช้กรอกไว้) — เชื่อก่อนเดาจากชื่อ
  if (cat === 'ร้านอาหาร') return 'restaurant';
  if (cat === 'โรงแรม') return 'hotel';
  if (cat === 'เบเกอรี่') return 'bakery';
  if (cat === 'ไดเร็คเซลส์') return 'direct';
  if (hasConsi || execChannel === 'mall' || execChannel === 'makro' || MALL_RE.test(`${cat} | ${corp}`)) return 'modern_trade';
  if (HOTEL_RE.test(all)) return 'hotel';
  if (CATERING_RE.test(all)) return 'catering';
  if (BAKERY_RE.test(all)) return 'bakery';
  if (RESTAURANT_RE.test(all)) return 'restaurant';
  if (FOOD_PROCESSOR_RE.test(all)) return 'food_processor';
  return 'retail';
}

function businessTypeLabel(key) {
  return (BUSINESS_TYPES.find((t) => t.key === key) || {}).label || key || '';
}

// เดาประเภทธุรกิจให้ลูกค้าทุกรายที่มี customer_profiles + ทุกรหัสที่มียอดตั้งแต่ 2024 (รวม Bplus โรงงาน) · ไม่ทับ source='manual'
// รหัสที่ไม่มีใน customers (Bplus/สาขาห้าง) ได้ชื่อจาก bplus_customers/chain_customers ไปด้วย ให้หน้า จัดการกลุ่ม แสดงชื่อ
function autofillBusinessTypes(db, editedBy = 'system') {
  const meta = new Map();
  for (const r of db.prepare(`SELECT cp.code, COALESCE(NULLIF(cp.name,''), c.name) AS name, cp.category, cp.corporate, cp.exec_channel,
      cp.exec_channel_source, cp.business_type_source, c.code IS NOT NULL AS in_cust FROM customer_profiles cp LEFT JOIN customers c ON c.code = cp.code`).all()) meta.set(r.code, { ...r, has_profile: 1 });
  const salesCodes = db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly
    WHERE ym >= '2024-01' AND company NOT LIKE '%-IC' AND cust_code NOT IN ('', '(none)')`).all().map((r) => r.cust_code);
  const custName = db.prepare('SELECT name FROM customers WHERE code = ?');
  const extName = db.prepare(`SELECT COALESCE((SELECT name FROM bplus_customers WHERE code = ?), (SELECT name FROM chain_customers WHERE code = ?)) AS name`);
  for (const code of salesCodes) {
    if (meta.has(code)) continue;
    const c = custName.get(code);
    meta.set(code, { code, name: c ? c.name : extName.get(code, code)?.name || null, in_cust: c ? 1 : 0, has_profile: 0 });
  }
  const consi = new Set(db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE company = 'CONSI'`).all().map((r) => r.cust_code));
  const exportCodes = new Set(db.prepare('SELECT code FROM bplus_customers WHERE has_export = 1').all().map((r) => r.code));
  const upsert = db.prepare(`INSERT INTO customer_profiles (code, name, business_type, business_type_source, edited_by, updated_at)
    VALUES (?, ?, ?, 'auto', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET business_type = excluded.business_type, business_type_source = 'auto', updated_at = excluded.updated_at
    WHERE COALESCE(customer_profiles.business_type_source, '') <> 'manual'
      AND customer_profiles.business_type IS NOT excluded.business_type`);
  const counts = {};
  let updated = 0, skippedManual = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const m of meta.values()) {
      if (m.business_type_source === 'manual') { skippedManual++; continue; }
      // FIXED (2026-10-09, /code-review): ใช้หมวดผู้บริหารที่บันทึกไว้เฉพาะที่คนตั้งเอง — ค่า 'auto' อาจค้างจากกฎเก่า
      // (เช่นเบเกอรี่ในบิ๊กซีค้าง 'mall' → ถูกเดาเป็น modern_trade) · กติกาเดียวกับ channelOf ใน routes/dashboardExec.js
      const hasConsi = consi.has(m.code), hasExport = exportCodes.has(m.code);
      const execChannel = m.exec_channel_source === 'manual' && m.exec_channel ? m.exec_channel
        : guessExecChannel({ code: m.code, name: m.name || '', category: m.category || '', corporate: m.corporate || '', hasConsi, hasExport });
      const t = guessBusinessType({ code: m.code, name: m.name || '', category: m.category || '', corporate: m.corporate || '',
        execChannel, hasConsi, hasExport });
      // ชื่อใส่เฉพาะแถวใหม่ของรหัสที่ไม่มีใน customers — แถวเดิมไม่แตะชื่อ (ON CONFLICT ไม่อัปเดต name)
      if (upsert.run(m.code, m.in_cust ? null : (m.name || null), t, editedBy).changes) { updated++; counts[t] = (counts[t] || 0) + 1; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { updated, skipped_manual: skippedManual, counts };
}

module.exports = { BUSINESS_TYPES, BUSINESS_TYPE_KEYS, guessBusinessType, businessTypeLabel, autofillBusinessTypes };
