'use strict';

// จัดกลุ่มสินค้าโรงงาน (Bplus) ตามกลุ่มที่เคยจัดใน Express (STKGRP 001–006) — 2026-10-14
// รหัสโรงงานส่วนใหญ่ (บาร์โค้ด 8850826…, 20368-177 HK ฯลฯ) ไม่มีใน Express ทั้งรหัสตรงและขึ้นต้นรหัสเดียวกัน
// เลยเทียบจาก "ชื่อสินค้า" แทน ลำดับ:
//   1) ชื่อคล้ายสินค้า Express ตัวใดตัวหนึ่งมาก (Dice bigram ≥ STRONG) → กลุ่มของตัวนั้น
//   2) มีคำหลัก (เบค่อน/แฮม/ไส้กรอก/บาโลน่า/ซาลามี่ …) → กลุ่มที่สินค้า Express ที่มีคำนั้นส่วนใหญ่อยู่ (คำนวณจากข้อมูลจริง)
//   3) ชื่อคล้ายพอใช้ (≥ WEAK) → กลุ่มของตัวที่คล้ายที่สุด
//   ไม่เข้าเงื่อนไข (เช่น เครื่องดื่ม รายได้เบ็ดเตล็ด ค่าใช้จ่าย) = '' (คง "ไม่ระบุกลุ่ม")
const PRODUCT_GROUP_RE = /^00[1-6]$/;
const STRONG = 0.75;
const WEAK = 0.6;
// ลำดับ = ความสำคัญ (คำเฉพาะก่อนคำกว้าง) · คำอังกฤษจับชื่อสินค้าส่งออก/ร้านอาหาร (Prime Bacon, PORK HAM, Haus Salami)
const KEYWORDS = [
  ['ซาลามี่', 'สลามี่', 'salami', 'เปปโปโรนี'],
  ['มีทโลฟ', 'meat loaf'],
  ['บาโลน่า', 'bologna'],
  ['เบค่อน', 'bacon'],
  ['แฮม', 'ham'],
  ['ฮอทดอก', 'เวียนนา', 'ค็อกเทล', 'ไส้กรอก', 'ซอสเซส', 'sausage', 'รมควัน'],
  ['หมูยอ'],
];

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/ตรา\S*|tgm|tss|ทีจีเอ็ม|แช่แข็ง|แช่เย็น|พาสเจอร์ไรซ์|สไลซ์|สไลด์|พิเศษ|ยกเลิก|ไม่มีตรา|\bsp\b|freeze|pack/g, ' ')
    .replace(/\d[\d,.]*\s*(กรัม|ก\.|กก\.|g\.?|kg\.?|มม\.?|mm\.?|นิ้ว|ซม\.?)?/g, ' ')
    .replace(/[^฀-๿a-z]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  m.size_ = t.length > 1 ? t.length - 1 : 0;
  return m;
}

function dice(a, b) {
  const n = a.size_ + b.size_;
  if (!n) return 0;
  let x = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) { const w = big.get(k); if (w) x += Math.min(v, w); }
  return (2 * x) / n;
}

// products: [{ code, name, group_name }] จากตาราง products (Express)
function buildProductGroupMatcher(products) {
  const ex = [];
  for (const p of products) {
    if (!PRODUCT_GROUP_RE.test(String(p.group_name || ''))) continue;
    const n = normName(p.name);
    if (n.length > 1) ex.push({ g: p.group_name, gm: bigrams(n) });
  }
  // คำหลัก → กลุ่มส่วนใหญ่ของสินค้า Express ที่ชื่อมีคำนั้น
  const kwGroup = KEYWORDS.map((words) => {
    const c = {};
    for (const p of products) {
      if (!PRODUCT_GROUP_RE.test(String(p.group_name || ''))) continue;
      const nm = String(p.name || '').toLowerCase();
      if (words.some((w) => nm.includes(w))) c[p.group_name] = (c[p.group_name] || 0) + 1;
    }
    const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return { words, g: top ? top[0] : '' };
  });
  const memo = new Map();
  return function groupForName(name) {
    const key = String(name || '');
    if (memo.has(key)) return memo.get(key);
    let out = '';
    const n = normName(key);
    if (n.length > 1) {
      const gm = bigrams(n);
      let best = null;
      for (const p of ex) { const sc = dice(gm, p.gm); if (!best || sc > best.sc) best = { sc, g: p.g }; }
      if (best && best.sc >= STRONG) out = best.g;
      else {
        const low = key.toLowerCase();
        const kw = kwGroup.find((k) => k.g && k.words.some((w) => (/^[a-z ]+$/.test(w) ? new RegExp(`\\b${w}\\b`).test(low) : low.includes(w))));
        if (kw) out = kw.g;
        else if (best && best.sc >= WEAK) out = best.g;
      }
    }
    memo.set(key, out);
    return out;
  };
}

// ตัวหากลุ่มสินค้าของ 1 รหัส (ใช้ร่วม /api/dashboard/bplus/sales_lines และ /api/invoice_detail/pivot — 2026-10-14)
// ลำดับ: group_name ของรหัสนั้น → กลุ่มส่วนใหญ่ของรหัสที่ขึ้นต้นเหมือนกัน (20018-227 → 20018-*) → เทียบจากชื่อ → ''
// cache 10 นาทีต่อ db (ข้อมูล products เปลี่ยนไม่บ่อย)
const resolverCache = new WeakMap();
function productGroupResolver(db) {
  const hit = resolverCache.get(db);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  const counts = new Map();
  const all = db.prepare("SELECT code, name, group_name FROM products WHERE group_name IS NOT NULL AND group_name <> ''").all();
  for (const p of all) {
    const pre = String(p.code).split('-')[0];
    const m = counts.get(pre) || new Map();
    m.set(p.group_name, (m.get(p.group_name) || 0) + 1);
    counts.set(pre, m);
  }
  const map = new Map([...counts].map(([pre, m]) => [pre, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  const byName = buildProductGroupMatcher(all);
  const resolve = (sku, name, group) => group || map.get(String(sku || '').split('-')[0]) || byName(name) || '';
  const out = { at: Date.now(), map, byName, resolve };
  resolverCache.set(db, out);
  return out;
}

// ชื่อหน่วยขาย (2026-10-14, ผู้ใช้ขอแสดงหน่วยของจำนวน) — Express เก็บรหัสย่อ 2 ตัว (กก/แพ/ซอ/ลง …) ส่วน Bplus เก็บชื่อเต็ม
// ความหมายของรหัสย่อตรวจจากชื่อสินค้าจริง (กน = ตับบด → ก้อน, คง = ค่าขนส่ง → ครั้ง, ทง = บีฟซาลามี่ → ท่อน)
const UNIT_LABELS = {
  'กก': 'กก.', 'กก.': 'กก.', 'กิโลกรัม': 'กก.', 'kg': 'กก.', 'แพ': 'แพ็ค', 'pack': 'แพ็ค', 'ซอ': 'ซอง', 'ลง': 'ลัง', 'กน': 'ก้อน', 'กล': 'กล่อง',
  'คง': 'ครั้ง', 'ชน': 'ชิ้น', 'ถา': 'ถาด', 'เส': 'เส้น', 'แท': 'แท่ง', 'ชด': 'ชุด', 'ขา': 'ขา', 'ทง': 'ท่อน',
};
function unitLabel(u) {
  const k = String(u || '').trim();
  return UNIT_LABELS[k] || UNIT_LABELS[k.toLowerCase()] || k;
}

module.exports = { buildProductGroupMatcher, normName, productGroupResolver, unitLabel };
