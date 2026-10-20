'use strict';

// ยอดขายรายสาขาห้าง (ห้อง SKU) แทนยอด DC ห้อง VAT ในมุมมองราย Sales (2026-10-07, ผู้ใช้ขอ) — ข้อมูลจาก jobs/importChainRooms.js
// Master (entity 'chain_sales_map' ใน approval_workflow_templates) นำเข้าจาก Excel ของแต่ละห้าง:
//   · ชีตจับคู่สาขา (เช่น Sheet2): "รหัสลูกค้า Express" + "เขต Sale"/"เขตเซลล์" (รหัส Sales เช่น 207, 211 หรือ "ออฟฟิศ")
//   · ชีตเทียบห้อง (เช่น Sheet1): "ห้อง SKU" (กลุ่มรหัส เช่น EU/FF/TS/TG) ↔ "ห้อง VAT" (ช่วงรหัส DC เช่น 30-MJ-0001-สุดท้าย)
//     หมายเหตุ "ห้อง TGM" = ยอด DC อยู่บริษัท TGM
// กติกาที่ผู้ใช้ยืนยัน 2026-10-07:
//   · ไม่รวมยอดบริษัท · ใช้เฉพาะมุมมองราย Sales: ตัดยอดรหัส DC (ช่วงห้อง VAT ของห้างที่เปิด "แทน") แล้วใช้ยอดสาขาจากห้อง SKU
//   · สาขาที่ไฟล์ระบุ "ออฟฟิศ" หรือไม่มีในไฟล์ → รหัส Sales ที่ตั้งเองใน Master (office_slm) · ไม่ได้ตั้ง = ไม่ระบุ Sales
//   · GO Wholesale ค่าเริ่มต้น "ไม่แทน" (ห้อง VAT แยกสาขาใต้ 207 อยู่แล้ว ห้อง GOWHOLES ยอดไม่ครบ) — เปิดได้ในหน้า Master
//   · keep_skus (2026-10-20, ผู้ใช้แจ้ง "คุณปูยังขาดข้อมูลการขายของ TOP"): ห้อง SKU ที่ "ไม่แทน" รายกลุ่ม — รหัส DC ของกลุ่มนี้
//     คงยอดใบกำกับเดิม (ตามรหัส Sales ในใบ) และไม่เพิ่มยอดสาขาของกลุ่มนี้ (กันนับซ้ำ) · Tops เบเกอรี่ KK (30-TA/TB/TF)
//     + Saladbar AA (30-TD) เป็นลูกค้าของคุณปู (106) ตามไฟล์ Group แต่ถูกแทนด้วยสาขาของ 207/ออฟฟิศ ยอดหาย ~33 ล้าน (ม.ค.–ก.ย. 69)
const ENTITY = 'chain_sales_map';
const CHAIN_KEYS = ['TOPS', 'MAKRO', 'GO'];
const DEFAULT_REPLACE = { TOPS: true, MAKRO: true, GO: false };
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const txt = v => String(v ?? '').replace(/\s+/g, ' ').trim();

function loadChainMap(db) {
  const row = db.prepare('SELECT levels_json, updated_at FROM approval_workflow_templates WHERE entity_type = ?').get(ENTITY);
  const v = parse(row?.levels_json) || {};
  const chains = {};
  for (const k of CHAIN_KEYS) {
    const c = v.chains?.[k] || {};
    chains[k] = { replace: c.replace ?? DEFAULT_REPLACE[k], office_slm: txt(c.office_slm), groups: Array.isArray(c.groups) ? c.groups : [],
      keep_skus: Array.isArray(c.keep_skus) ? c.keep_skus.map(x => txt(x).toUpperCase()).filter(Boolean) : [],
      cust: c.cust && typeof c.cust === 'object' ? c.cust : {}, aliases: c.aliases && typeof c.aliases === 'object' ? c.aliases : {}, file: c.file || '', imported_at: c.imported_at || '', imported_by: c.imported_by || '' };
  }
  return { chains, updated_at: row?.updated_at || '' };
}

// ── อ่านไฟล์ Excel (client ส่งแถวดิบของทุกชีต {name: [[...],[...]]}) ───────────────────────────────
const RANGE_RE = /^([A-Z0-9]+-[A-Z0-9]+-)(\d+)\s*-\s*(\d+|สุดท้าย)$/;
function parseVatRanges(text) {
  const out = [], bad = [];
  for (const part of txt(text).toUpperCase().split(/[/,]+/).map(s => s.trim()).filter(Boolean)) {
    // "30-PN-1001-1102" · "30-TD-0001-สุดท้าย" · "MK-LA-1001-1002" · รหัสเดี่ยว "30-LC-0013"
    let m = part.match(RANGE_RE);
    if (m) { out.push({ prefix: m[1], from: +m[2], to: m[3] === 'สุดท้าย' ? 999999 : +m[3] }); continue; }
    m = part.match(/^([A-Z0-9]+-[A-Z0-9]+-)(\d+)$/);
    if (m) { out.push({ prefix: m[1], from: +m[2], to: +m[2] }); continue; }
    bad.push(part);
  }
  return { ranges: out, bad };
}
function parseChainFile(sheets) {
  const cust = {}, groups = [], warnings = [];
  for (const [name, rows] of Object.entries(sheets || {})) {
    if (!Array.isArray(rows)) continue;
    // ชีตจับคู่สาขา: แถวหัวที่มี "รหัสลูกค้า Express" และคอลัมน์ "เขต…"
    const hi = rows.findIndex(r => Array.isArray(r) && r.some(c => /รหัสลูกค้า\s*Express/i.test(txt(c))));
    if (hi >= 0) {
      const h = rows[hi].map(txt);
      const ci = h.findIndex(c => /รหัสลูกค้า\s*Express/i.test(c)), si = h.findIndex(c => /^เขต/.test(c));
      if (si < 0) continue; // ชีตยอดขายรายเดือน (มีรหัสลูกค้าแต่ไม่มีเขต Sale) — ไม่ใช่ชีตจับคู่
      for (const r of rows.slice(hi + 1)) {
        const code = txt(r[ci]).toUpperCase(), slm = txt(r[si]);
        if (/^[A-Z0-9]+-[A-Z0-9]+-\d+$/.test(code)) cust[code] = slm;
      }
      continue;
    }
    // ชีตเทียบห้อง: แถวหัว "ห้อง SKU | ห้อง VAT"
    const gi = rows.findIndex(r => Array.isArray(r) && txt(r[0]) === 'ห้อง SKU');
    if (gi >= 0) {
      for (const r of rows.slice(gi + 1)) {
        const skus = txt(r[0]).toUpperCase().split(/[/,]+/).map(s => s.trim()).filter(Boolean);
        if (!skus.length || !txt(r[1])) continue;
        const { ranges, bad } = parseVatRanges(r[1]);
        if (bad.length) warnings.push(`ชีต ${name}: อ่านช่วงรหัสไม่ได้ "${bad.join(', ')}"`);
        groups.push({ skus, vat: ranges, src: txt(r[1]), company: /TGM/i.test(txt(r[2])) ? 'TGM' : 'TSS' });
      }
    }
  }
  if (!Object.keys(cust).length) warnings.push('ไม่พบชีตจับคู่สาขา (ต้องมีคอลัมน์ "รหัสลูกค้า Express" และ "เขต Sale")');
  return { cust, groups, warnings, custCount: Object.keys(cust).length };
}

// ── การใช้งาน ───────────────────────────────────────────────────────────────────────────────────
// กลุ่มรหัส (ห้อง SKU) ของสาขา = ส่วนกลางของรหัส เช่น 30-KK-0004 → KK, 01-NB-0001 → NB
const skuGroupOf = code => (String(code || '').split('-')[1] || '').toUpperCase();
const isOffice = v => !v || /ออฟ|office/i.test(v);
// ค่า 'เขต Sale' ที่เป็นรหัส Sales (207, 211, 110-1, ON-001) ใช้ตรงๆ · เป็นชื่อ/ข้อความ (เช่น 'คุณอนิตา', 'แบ่งกัน') → ตารางแปลงใน Master
// (aliases) · ไม่ได้แปลง / ออฟฟิศ / ไม่มีในไฟล์ → office_slm ของห้างนั้น
const isSlmCode = v => /^[0-9A-Z]{1,4}(-[0-9A-Z]{1,4})?$/i.test(v);
function slmFor(map, chain, code) {
  const c = map.chains[chain];
  const v = txt(c?.cust?.[String(code).toUpperCase()]);
  if (!isOffice(v) && isSlmCode(v)) return v;
  if (!isOffice(v) && txt(c?.aliases?.[v])) return txt(c.aliases[v]);
  return c?.office_slm || '';
}
// กลุ่มห้อง SKU ที่ถูกแทนของห้างนั้น — กลุ่มที่ทุกห้อง SKU อยู่ใน keep_skus = ไม่แทน
function replacedGroups(map, k) {
  const keep = new Set(map.chains[k].keep_skus || []);
  return map.chains[k].groups.filter(g => !(g.skus || []).length || !(g.skus || []).every(s => keep.has(String(s).toUpperCase())));
}
// ช่วงรหัส DC ห้อง VAT ที่ถูกแทน (เฉพาะห้างที่เปิด "แทน")
function replacedRanges(map) {
  return CHAIN_KEYS.filter(k => map.chains[k].replace).flatMap(k => replacedGroups(map, k).flatMap(g => g.vat || []));
}
// SQL: แถวที่ "ไม่ใช่" รหัส DC ที่ถูกแทน · ช่วงละเงื่อนไข (ไม่กี่สิบช่วง) — ใช้ต่อท้าย WHERE เฉพาะมุมมองราย Sales
function notReplacedSql(map, col = 'cust_code') {
  const rs = replacedRanges(map);
  if (!rs.length) return { sql: '', params: [] };
  const conds = rs.map(() => `(substr(${col}, 1, ?) = ? AND CAST(substr(${col}, ? + 1) AS INTEGER) BETWEEN ? AND ?)`);
  return { sql: `AND NOT (${conds.join(' OR ')})`, params: rs.flatMap(r => [r.prefix.length, r.prefix, r.prefix.length, r.from, r.to]) };
}
// ยอดสาขาห้อง (ห้างที่เปิด "แทน") ในช่วง → [{chain, company:'TSS'|'TGM', period, cust_code, slm_code, amount, invoice_count}]
function chainFacts(db, map, from, to) {
  const daily = from.length === 10;
  const keys = CHAIN_KEYS.filter(k => map.chains[k].replace);
  if (!keys.length) return [];
  const rows = db.prepare(`SELECT chain, ${daily ? 'd' : 'ym'} AS period, cust_code, SUM(amount) AS amount, SUM(invoice_count) AS invoice_count
    FROM ${daily ? 'chain_sales_daily' : 'chain_sales_monthly'}
    WHERE chain IN (${keys.map(() => '?').join(',')}) AND ${daily ? 'd' : 'ym'} >= ? AND ${daily ? 'd' : 'ym'} <= ?
    GROUP BY chain, period, cust_code`).all(...keys, from, to);
  const coOf = {};
  for (const k of keys) for (const g of map.chains[k].groups) for (const s of g.skus) coOf[`${k}|${s}`] = g.company || 'TSS';
  // ไม่แทนเป็นรายกลุ่ม (code review 2026-10-20): ตัดสาขาเฉพาะห้องของกลุ่มที่ไม่แทนทั้งกลุ่ม — ตรงกับ replacedGroups
  // (กลุ่ม KK/KF ที่ตั้งไม่แทนแค่ KK ยังถูกแทนทั้งกลุ่ม ห้องเดียวกันต้องคงยอดสาขาไว้ ไม่งั้นยอด KK หายทั้ง 2 ฝั่ง)
  const kept = new Set();
  for (const k of keys) {
    const rep = new Set(replacedGroups(map, k));
    for (const g of map.chains[k].groups) if (!rep.has(g)) for (const s of g.skus || []) kept.add(`${k}|${String(s).toUpperCase()}`);
  }
  return rows.filter(r => !kept.has(`${r.chain}|${skuGroupOf(r.cust_code)}`)).map(r => ({ chain: r.chain, company: coOf[`${r.chain}|${skuGroupOf(r.cust_code)}`] || 'TSS', period: r.period, cust_code: r.cust_code,
    slm_code: slmFor(map, r.chain, r.cust_code), amount: Number(r.amount) || 0, invoice_count: Number(r.invoice_count) || 0 }));
}

module.exports = { isOffice, isSlmCode, ENTITY, CHAIN_KEYS, loadChainMap, parseChainFile, parseVatRanges, slmFor, skuGroupOf, replacedGroups, replacedRanges, notReplacedSql, chainFacts };
