'use strict';

// หมวดลูกค้าสำหรับผู้บริหาร (2026-10-03, ผู้ใช้ขอ) — Dashboard แสดงยอดขายแยก 8 หมวดนี้ และ Top 20 แยก ห้าง / ร้านค้า
// ค่าที่เก็บใน customer_profiles.exec_channel คือ key ภาษาอังกฤษด้านล่าง (label เปลี่ยนได้โดยไม่ต้องย้ายข้อมูล)
// exec_channel_source: 'manual' = คนตั้งเอง (ห้ามระบบเดาทับ), 'auto' = ระบบเดาจากกฎใน guessExecChannel()
const EXEC_CHANNELS = [
  { key: 'general', label: 'ร้านค้าทั่วไป' },
  { key: 'mall', label: 'ห้าง (ไม่รวม Makro)' },
  { key: 'makro', label: 'Makro' },
  { key: 'local_agent', label: 'Local Agent' },
  { key: 'export_agent', label: 'Export Agent' },
  { key: 'shop_factory', label: 'Shop โรงงาน' },
  { key: 'shop_rama3', label: 'Shop พระราม 3' },
  { key: 'online', label: 'Online' },
];
const EXEC_CHANNEL_KEYS = new Set(EXEC_CHANNELS.map((c) => c.key));

// กฎเดาหมวด — เรียงลำดับสำคัญ (ข้อแรกที่ตรงชนะ) อิงค่า category/corporate ที่มีจริงใน customer_profiles
// ณ 2026-10-03 (เช่น 'Makro TSS', 'เอเย่น', 'วิลล่า (ยอดสั่ง)', 'Online') — ลูกค้าที่เดาผิดให้แก้มือในหน้า
// จัดการกลุ่ม › กลุ่มลูกค้า ซึ่งจะตั้ง source='manual' และกฎนี้จะไม่ทับอีก
// "Shop พระราม 3" ผู้ใช้บอกว่าใน Express ชื่อ "สุทธิดา" แต่ยังไม่พบชื่อนี้ในข้อมูลฝั่งนี้ (น่าจะอยู่ในข้อมูลโรงงาน
// ที่ผู้ใช้จะส่งมา) จึงจับทั้ง "สุทธิดา" และ "SHOP พระราม 3" ที่มีอยู่จริง (01-KG-0590 TGM SHOP พระราม 3)
// ตันตราภัณฑ์/สุวรรณชาด/สินทรัพย์ก้าวหน้า/ตั้งฮั่วเส็ง/สหไทย — Excel "Sales Update" ของฝ่ายขายนับเป็นห้าง (เทียบ 2026-10-08)
const MALL_RE = /เซ็นทรัล\s*ฟุ้ด|เซ็นทรัล\s*ฟู้ด|central\s*food|tops|ท็อปส์|บิ๊กซี|big\s*c|วิลล่า|villa|โลตัส|lotus|เดอะมอลล์|the\s*mall|อิออน|aeon|ลอว์สัน|lawson|ฟู้ดแลนด์|foodland|ยูเอฟเอ็ม|ufm|ซี\.เจ|cj\s*more|ซุปเปอร์ชีป|ไอคอนสยาม|iconsiam|มิตซูโคชิ|ซีพี\s*ออลล์|7-?eleven|เซเว่น|gourmet|กูร์เมต์|max\s*valu|แม็กซ์\s*แวลู|rimping|ริมปิง|ภูเก็ตโกรเซอรี่|ตันตราภัณฑ์|สุวรรณชาด|สินทรัพย์ก้าวหน้า|ตั้งฮั่วเส็ง|สหไทย/i;
// ลูกค้าใหม่ที่ยังไม่มีกลุ่ม/เครือ — เดาห้างจากชื่อ (ขึ้นต้นด้วยชื่อห้างเท่านั้น กัน "ไทยยามาซากิ (บิ๊กซี …)" / "ซิตี้ วิลล่า")
const MALL_NAME_RE = /^\s*(เซ็นทรัล\s*ฟู้ด\s*รีเทล|เซ็นทรัลฟู้ด|บิ๊กซี|ท็อปส์|โลตัส|ฟู้ดแลนด์|เดอะมอลล์)/i;
const MAKRO_RE = /makro|แม็คโคร|แม็กโคร|แมคโคร|สยามแม็คโคร/i;
const ONLINE_RE = /^online$|shopee|lazada|line\s*my\s*shop|face\s*book|facebook|ecommerce|e-commerce|tiktok/i;
// ไดเร็คเซลส์ — Excel ฝ่ายขายรวมไว้ในหมวดเอเย่น (2026-10-08)
const AGENT_RE = /เอเย่น|agent|ไดเร็คเซลส์/i;
// ลูกค้า Bplus โรงงาน: ตัวท้ายรหัสคือกลุ่มลูกค้า — C = เอเย่น, D = โรงแรม (Excel ฝ่ายขายนับเป็นเอเย่น) เช่น TTN-01-QC, TVC-01-QD
const BPLUS_AGENT_CODE_RE = /^[A-Z]{2,4}-\d{2}-[A-Z][CD]$/;
const GENERAL_CAT_RE = /^(ร้านค้าทั่วไป|เบเกอรี่|ร้านอาหาร|โรงแรม)$/;
const EXPORT_RE = /export|ส่งออก|international|overseas/i;
// Bplus โรงงานสะกด "ซุปเปอร์(สุธิดา)" (TG-IG-0001) — ตรวจกับข้อมูลจริง 2026-10-05
const RAMA3_RE = /สุทธิดา|สุธิดา|shop\s*พระราม\s*3/i;
// รวมลูกค้าเงินสด POS ในโรงงาน (Bplus รหัส '0' → BP-POS "เงินสด(รายได้จากเครื่องPOS ซุปเปอร์ โรงงาน2)")
const FACTORY_SHOP_RE = /shop\s*โรงงาน|tgm\.?\s*shop|ที\.จี\.เอ็ม\.\s*ช็อป|ซุปเปอร์\s*โรงงาน|pos\s*ซุปเปอร์/i;

// hasExport: ลูกค้าที่มีใบขายส่งออก 0% ใน Bplus (EXA/EXB) — ผู้ซื้อต่างประเทศ เช่น TOA International, กัมพูชา
// code: รหัสลูกค้า (ใช้กับลูกค้า Bplus โรงงานที่ไม่มีกลุ่มใน Express — ดู BPLUS_AGENT_CODE_RE)
function guessExecChannel({ code = '', name = '', category = '', corporate = '', hasConsi = false, slmCode = '', hasExport = false } = {}) {
  const text = `${name} | ${category} | ${corporate}`;
  if (RAMA3_RE.test(text)) return 'shop_rama3';
  if (FACTORY_SHOP_RE.test(text)) return 'shop_factory';
  if (hasExport) return 'export_agent';
  if (MAKRO_RE.test(`${category} | ${corporate} | ${name}`)) return 'makro';
  if (ONLINE_RE.test(String(category).trim()) || ONLINE_RE.test(String(corporate).trim()) || String(slmCode).toUpperCase().startsWith('ON-')) return 'online';
  if (/shopee|lazada|line\s*my\s*shop|face\s*book\s*shop/i.test(name)) return 'online';
  if (AGENT_RE.test(`${category} | ${corporate}`)) return EXPORT_RE.test(text) ? 'export_agent' : 'local_agent';
  if (!category && BPLUS_AGENT_CODE_RE.test(String(code).trim())) return 'local_agent';
  // กลุ่มลูกค้าใน Express เป็นร้านค้า/เบเกอรี่/ร้านอาหาร/โรงแรม → ร้านค้าทั่วไป แม้ชื่อเครือจะเข้ากฎห้าง (Excel ฝ่ายขายยึดกลุ่มนี้)
  // กัน "สยาม คานาเดี่ยน กูร์เมต์", "Cazalla Villalba", เบเกอรี่ในบิ๊กซี (BD-LF-*) ถูกนับเป็นห้าง (2026-10-08)
  if (!hasConsi && GENERAL_CAT_RE.test(String(category).trim())) return 'general';
  // ลูกค้าที่มียอดฝากขาย (CONSI) คือคู่ค้าห้างทั้งหมด (วิลล่า/โลตัส/Tops (ยอดสั่ง)) — Makro ถูกจับไปแล้วด้านบน
  if (hasConsi || MALL_RE.test(`${category} | ${corporate}`)) return 'mall';
  if (!category && MALL_NAME_RE.test(name)) return 'mall';
  return 'general';
}

function execChannelLabel(key) {
  return (EXEC_CHANNELS.find((c) => c.key === key) || {}).label || key || '';
}

module.exports = { EXEC_CHANNELS, EXEC_CHANNEL_KEYS, guessExecChannel, execChannelLabel };
