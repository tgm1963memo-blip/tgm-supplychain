'use strict';

// น้ำหนัก (กก.) ต่อ 1 หน่วยขาย จากชื่อสินค้า — ใช้เมื่อ tgm-wms ยังไม่มี weight_per_unit ของรหัสนั้น (2026-10-14)
// ชื่อสินค้า Express/Bplus ส่วนใหญ่บอกน้ำหนักไว้: "500กรัม", "1000ก.", "(10กก/กล่อง)", "500ก.(10แพ็ค/ลัง)", "1000g.x10ซอง"
// ตรวจกับสินค้าที่ WMS มีน้ำหนักแล้ว ~480 รายการ ตรงทุกตัวยกเว้นชื่อแบบเซ็ต ("54 ก.(Set 3 pack=162g)")
//   หน่วยขายเป็นลัง/กล่อง → ต้องมี "(N กก./กล่อง)" หรือ "N แพ็ค/ลัง" × น้ำหนักต่อแพ็ค ไม่งั้นไม่เดา (คืน null)
//   หน่วยอื่น (แพ็ค/ซอง/ชิ้น/ถุง) → น้ำหนักต่อแพ็คในชื่อ
//   ชื่อไม่มีน้ำหนัก (ชุดโปรราคา 99 บาท, 1แถม1, (แท่ง), ค่าขนส่ง) → null
const BOX_UNIT = /^(กล่อง|ลัง|หีบ|ลง|กล|หบ|ctn|carton|box)/i;
const PACK = '(?:แพ็?ค|แพค|พ\\.|ซอง|ถุง|ชิ้น|ห่อ|pack|pcs)';
const BOX_KG = /(\d[\d,.]*)\s*(?:กก|kg|กิโล)\.?\s*\/\s*(?:กล่อง|ลัง|หีบ|ctn)/i;
const PACKS_PER_BOX = [
  new RegExp(`(\\d+)\\s*${PACK}\\s*\\/?\\s*(?:กล่อง|ลัง|หีบ)`, 'i'), // (10แพ็ค/ลัง) (10แพ็คลัง)
  new RegExp(`(?:กล่อง|ลัง)\\s*\\/\\s*(\\d+)\\s*${PACK}`, 'i'), // (1กล่อง/10แพ็ค)
  new RegExp(`x\\s*(\\d+)\\s*${PACK}`, 'i'), // 1000g.x10ซอง
];
// น้ำหนักต่อแพ็ค — ไม่เอาตัวเลขที่ตามด้วย "/" (นั่นคือสเปกต่อกล่อง)
const PACK_WEIGHT = [
  /(\d[\d,.]*)\s*(กรัม|ก\.|g\b|g\.|กก\.?|kg|กิโลกรัม)(?!\s*\.?\s*\/)/i,
  /(\d[\d,.]*)\s*(ก)(?=[\s.A-Zก-๙(]|$)/,
];

const num = (s) => Number(String(s).replace(/,/g, ''));

function weightFromName(name, unitCode) {
  const n = String(name || '').replace(/\s+/g, ' ');
  if (!n) return null;
  const unit = String(unitCode || '').split('/')[0].trim();
  let pack = null;
  for (const re of PACK_WEIGHT) {
    const m = n.match(re);
    if (!m) continue;
    const v = num(m[1]);
    pack = /กก|kg|กิโล/i.test(m[2]) ? v : v / 1000;
    if (!(pack > 0 && pack <= 50)) pack = null;
    break;
  }
  if (BOX_UNIT.test(unit)) {
    const bk = n.match(BOX_KG);
    if (bk && num(bk[1]) > 0) return num(bk[1]);
    if (pack == null) return null;
    for (const re of PACKS_PER_BOX) {
      const m = n.match(re);
      if (m && num(m[1]) > 0) return num(m[1]) * pack;
    }
    return null;
  }
  return pack;
}

module.exports = { weightFromName };
