'use strict';

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { requireRole } = require('../middleware/auth');
const { EXEC_CHANNELS, EXEC_CHANNEL_KEYS, guessExecChannel } = require('../lib/execChannel');
const { groupNameOf } = require('../lib/customerGroup');
const { autofillBusinessTypes } = require('../lib/businessType');
const { cacheJson } = require('../lib/responseCache');
const { resolveScope, factSql } = require('../lib/customerScope');
const chainSales = require('../lib/chainSales');
const { productGroupResolver } = require('../lib/productGroupMatch');
const { weightFromName } = require('../lib/weightFromName');
const nonSales = require('../lib/nonSales');
const CHAIN_CORP = { TOPS: 'Tops', MAKRO: 'Makro', GO: 'GO Wholesale' };

// Dashboard ผู้บริหาร (2026-10-03, ผู้ใช้ขอ "ออกแบบ Dashboard ใหม่ทั้งหน้า") — endpoint เดียวคืนทุกส่วนของหน้า
// ตามช่วงเวลาที่เลือก (YTD / เดือน / ไตรมาส / ทั้งปี) เทียบช่วงเดียวกันของปีก่อน:
//   monthly (ทั้งปีของช่วงที่เลือก + ปีก่อน, แยกบริษัท), kpi, channels (8 หมวด), top (Top 20 รวม / ห้าง / ร้านค้า + KG)
// ยอดบาท = invoice_sales_monthly (ใบกำกับ ARTRN ก่อน VAT — ตัวเลขเดียวกับ Dashboard/Sales Overview เดิม)
// KG = sales_lines_monthly (STCRD) × skus.weight_per_unit ของ tgm-wms — ดู syncSalesLinesMonthly()

const YM_RE = /^\d{4}-\d{2}$/;
// ช่วงวันที่ (2026-10-06, ผู้ใช้ขอเลือกเป็นช่วงวันได้) — from/to แบบ YYYY-MM-DD ใช้ตารางรายวัน (invoice_sales_daily /
// sales_lines_daily) แทนรายเดือน · กราฟรายเดือนยังเป็นรายเดือนทั้งปีเหมือนเดิม
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const tablesFor = (from) => (from.length === 10
  ? { inv: 'invoice_sales_daily', lines: 'sales_lines_daily', col: 'd' }
  : { inv: 'invoice_sales_monthly', lines: 'sales_lines_monthly', col: 'ym' });
const AUTOFILL_ROLES = ['superadmin', 'admin', 'manager', 'sales_manager', 'planning', 'planning_manager'];
// Express ขึ้นแฟ้มบริษัทใหม่ทุกปี — แฟ้มปีปัจจุบันคือ TSS / TSS-NV ส่วนปีก่อนอยู่ในแฟ้ม archive ตามปี พ.ศ.
// (TSS-68 = 2568 = ค.ศ. 2025, TSS-67 = 2024) · ตรวจกับข้อมูลจริง 2026-10-03: แฟ้ม archive ซ้อนกันบางช่วง
// (TSS-67 ซ้ำ TSS-68 ช่วง ม.ค.–เม.ย. 2025 และแฟ้ม TSS มีใบช่วง ต.ค.–ธ.ค. 2025 ที่ซ้ำกับ TSS-68 ราว 70–90%)
// จึงต้องเลือก "แฟ้มเดียวต่อปีต่อบริษัท" ห้ามบวกทุกแฟ้ม ไม่งั้นยอดปีก่อนบวม · CONSI/TGM ใช้แฟ้มเดียวทุกปี
const CUTOVER_YEAR = 2026;
// TGM ตั้งแต่ 2025 ใช้ Bplus ของโรงงาน (BP-TGM) แทนแฟ้ม TGM ของ Express ซึ่งเป็นส่วนย่อยที่ซ้ำกัน — ผู้ใช้ยืนยัน 2026-10-05
// (jobs/importFromBplus.js) · ยอดขายให้บริษัทในเครือ (BP-TGM-IC) ไม่อยู่ในรายการนี้ จึงไม่ถูกนับเป็นยอดขาย
const BPLUS_FROM_YEAR = 2025;
function yearSources(year) {
  const tgm = year >= BPLUS_FROM_YEAR ? { 'BP-TGM': 'TGM' } : { TGM: 'TGM' };
  if (year >= CUTOVER_YEAR) return { TSS: 'TSS', 'TSS-NV': 'TSSNV', ...tgm, CONSI: 'CONSI' };
  const be = String((year + 543) % 100).padStart(2, '0');
  return { [`TSS-${be}`]: 'TSS', [`TSSN-${be}`]: 'TSSNV', ...tgm, CONSI: 'CONSI' };
}
const NET_COMPANIES = new Set(['TSS', 'TSSNV', 'TGM']);

// น้ำหนักต่อหน่วยจาก tgm-wms (skus.weight_per_unit = กก. ต่อ 1 หน่วยสต็อก) — เปิด WMS DB แบบอ่านอย่างเดียว
// แยกจาก connection หลัก และ cache 10 นาที (ค่าน้ำหนักแทบไม่เปลี่ยน)
let weightCache = { at: 0, map: null };
function loadWeights() {
  if (weightCache.map && Date.now() - weightCache.at < 10 * 60 * 1000) return weightCache.map;
  const map = new Map();
  const dbPath = process.env.WMS_DB_PATH;
  if (dbPath) {
    let wdb = null;
    try {
      wdb = new DatabaseSync(dbPath, { readOnly: true });
      for (const r of wdb.prepare('SELECT sku_code, weight_per_unit FROM skus WHERE weight_per_unit > 0').all()) {
        map.set(String(r.sku_code).trim(), Number(r.weight_per_unit));
      }
    } catch (e) {
      console.warn('[dashboardExec] load WMS weights failed:', e.message);
    } finally {
      try { wdb && wdb.close(); } catch (_) { /* ignore */ }
    }
  }
  weightCache = { at: Date.now(), map };
  return map;
}
const KG_UNIT_RE = /^(กก|กิโล|kg)/i;

function shiftYear(ym, delta) {
  return `${Number(ym.slice(0, 4)) + delta}${ym.slice(4)}`;
}
function inList(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

module.exports = function dashboardExecRoutes(db) {
  const router = express.Router();

  // ตัวกรองบริษัท (2026-10-05, ผู้ใช้ขอ): all | tss (TSS + TSS-NV + ฝากขาย CONSI จาก Express) | tgm (โรงงานจาก Bplus)
  // ตั้งค่าที่ต้น handler /exec — handler ทำงานแบบ synchronous ทั้งหมด (ไม่มี await) จึงไม่มีคำขออื่นแทรกระหว่างใช้ค่านี้
  const CO_GROUPS = { tss: new Set(['TSS', 'TSSNV', 'CONSI']), tgm: new Set(['TGM']) };
  let reqCo = 'all';
  // ไม่รวม Non-VAT (2026-10-14, ผู้ใช้ขอ — เทียบ Excel รายเซลล์ที่ไม่นับแฟ้ม TSS-NV): ตัดแฟ้ม TSS-NV / TSSN-xx ทุกส่วนของหน้า
  let reqNoNv = false;
  function companyFilter(year) {
    const all = yearSources(year);
    const keep = CO_GROUPS[reqCo];
    const src = Object.fromEntries(Object.entries(all)
      .filter(([, canon]) => (!keep || keep.has(canon)) && !(reqNoNv && canon === 'TSSNV')));
    return { src, raw: Object.keys(src) };
  }
  // ไม่รวมเบเกอรี่ (2026-10-14, ผู้ใช้ขอ): ลูกค้าที่กลุ่มลูกค้า (category) เป็น "เบเกอรี่" หรือ "…/เบเกอรี่"
  // (เช่น Tops/เบเกอรี่ 30-TA/TF, เบเกอรี่ในบิ๊กซี BD-LF-*) — ต่อท้าย WHERE ของทุก query ผ่าน slmCodes.sql
  const BAKERY_SQL = `cust_code NOT IN (SELECT code FROM customer_profiles WHERE category = 'เบเกอรี่' OR category LIKE '%/เบเกอรี่')`;
  let reqBakery = null; // Set ของรหัสเบเกอรี่ เมื่อเปิด "ไม่รวมเบเกอรี่" (ใช้กรองแถวห้อง SKU ที่ไม่ผ่าน SQL) | null

  // ยอดรายเดือนทั้งปี แยกบริษัท และแยกหมวดลูกค้า (net/consi) — หมวดคิดจากยอดจริงรายลูกค้า ไม่ได้ประมาณตามสัดส่วน
  function monthly(year, slmCodes, meta, consiCodes) {
    const { src, raw } = companyFilter(year);
    const rows = db.prepare(`SELECT company, ym, cust_code, SUM(amount) AS amount FROM invoice_sales_monthly
      WHERE company IN (${inList(raw.length)}) AND ym >= ? AND ym <= ?
      ${slmCodes.sql}
      GROUP BY company, ym, cust_code`).all(...raw, `${year}-01`, `${year}-12`, ...slmCodes.params);
    const company = {};
    const channel = {};
    const chCache = new Map();
    for (const r of rows) {
      if (isNonSales(r.cust_code)) continue;
      const amt = Number(r.amount) || 0;
      const co = src[r.company];
      const m = (company[r.ym] = company[r.ym] || { TSS: 0, TSSNV: 0, TGM: 0, CONSI: 0 });
      m[co] += amt;
      let ch = chCache.get(r.cust_code);
      if (!ch) { ch = channelOf(meta, r.cust_code, consiCodes.has(r.cust_code)); chCache.set(r.cust_code, ch); }
      const c = (channel[r.ym] = channel[r.ym] || {});
      const cc = (c[ch] = c[ch] || { net: 0, consi: 0 });
      if (co === 'CONSI') cc.consi += amt; else cc.net += amt;
    }
    for (const r of chainRows(`${year}-01`, `${year}-12`)) {
      const m = (company[r.period] = company[r.period] || { TSS: 0, TSSNV: 0, TGM: 0, CONSI: 0 });
      m[r.company] = (m[r.company] || 0) + r.amount;
      let ch = chCache.get(r.cust_code);
      if (!ch) { ch = channelOf(meta, r.cust_code, false); chCache.set(r.cust_code, ch); }
      const c = (channel[r.period] = channel[r.period] || {});
      const cc = (c[ch] = c[ch] || { net: 0, consi: 0 });
      cc.net += r.amount;
    }
    return { company, channel };
  }

  // แหล่งข้อมูลของช่วง (2026-10-06): ช่วงวันที่ใช้ตารางรายวัน — แต่ถ้ายอดโรงงาน (BP-TGM*) ยังไม่มีแถวรายวัน
  // (Bplus sync ยังไม่สำเร็จหลังเพิ่มตารางรายวัน) ให้ส่วนของ BP-* อ่านจากรายเดือนของเดือนที่อยู่ในช่วงแทนชั่วคราว
  // ไม่งั้นยอด "ทุกบริษัท" หายทั้งก้อนของโรงงาน · หน้า Dashboard แสดงหมายเหตุจาก tgm_daily_missing
  let reqBpDailyMissing = false;
  // มุมมองราย Sales (2026-10-07, lib/chainSales.js): เลือก Sales หรือผู้ใช้ถูกจำกัดสิทธิ์ → ตัดรหัส DC ห้อง VAT ที่ถูกแทน
  // แล้วเพิ่มยอดสาขาห้องจากห้อง SKU ที่จับคู่ Sales ได้ (เฉพาะรหัส Sales ในชุด reqChain.slms) · ภาพรวมบริษัทไม่แตะ
  let reqChain = null; // { map, slms: Set } | null
  function chainRows(from, to) {
    if (!reqChain) return [];
    const keep = CO_GROUPS[reqCo];
    return chainSales.chainFacts(db, reqChain.map, from, to)
      .filter((r) => reqChain.slms.has(r.slm_code) && (!keep || keep.has(r.company))
        && !(reqNoNv && r.company === 'TSSNV') && !(reqBakery && reqBakery.has(r.cust_code)));
  }
  function parts(from, to, companies) {
    const t = tablesFor(from);
    if (t.col !== 'd' || !reqBpDailyMissing) return [{ t, lo: from, hi: to, cos: companies }];
    const bp = companies.filter((c) => c.startsWith('BP-'));
    const rest = companies.filter((c) => !c.startsWith('BP-'));
    const out = [];
    if (rest.length) out.push({ t, lo: from, hi: to, cos: rest });
    if (bp.length) out.push({ t: tablesFor(from.slice(0, 7)), lo: from.slice(0, 7), hi: to.slice(0, 7), cos: bp });
    return out;
  }

  // Makro/โลตัส TGM รายวัน (2026-10-08): Bplus ลงยอดลูกค้ากลุ่มนี้ (30-NW/30-NU …) เป็นบิลสรุปก้อนเดียววันสิ้นเดือน
  // (เช่น 30 ก.ย. 2025 = 9.57 ล้าน) เลือกช่วงวันแล้วยอดหายทั้งก้อน — แฟ้ม TGM ของ Express มีบิลรายวันจริงของลูกค้าชุดเดียวกัน
  // → ช่วงวันที่ใช้แถวรายวันของ Express TGM แทนแถว BP-TGM
  // FIXED (2026-10-09, /code-review): เดิมตัด BP-TGM ของลูกค้าทั้งช่วง แต่ Express มีแทนแค่ถึง พ.ค. 2026 (ช่วงคร่อมเดือนหลัง
  // ยอดหาย) และแทนทุกลูกค้าที่มีแถวใน Express (Express บางเดือนไม่ตรง Bplus — เช่น BB-VG-* ม.ค. 2025 ไม่มีใน Bplus เลย)
  // → แทนรายลูกค้า×เดือน เฉพาะเดือนที่ยอดทั้งเดือนของ Express TGM เท่ากับ Bplus (ข้อมูลจริง: ตรง 129 จาก 176 ลูกค้า-เดือน)
  // คืนแถวปรับยอด (BP-TGM ติดลบ + TGM บวก) ต่อท้ายแถวเดิม — map รวมยอดตามลูกค้าอยู่แล้ว
  function expressTgmSwap(from, to, raw, slmCodes) {
    if (from.length !== 10 || reqBpDailyMissing || !raw.includes('BP-TGM')) return [];
    const m0 = from.slice(0, 7), m1 = to.slice(0, 7);
    const same = new Set(db.prepare(`WITH bp AS (SELECT cust_code, substr(d, 1, 7) AS ym, SUM(amount) AS amt FROM invoice_sales_daily
        WHERE company = 'BP-TGM' AND substr(d, 1, 7) BETWEEN ? AND ? GROUP BY 1, 2),
      ex AS (SELECT cust_code, substr(d, 1, 7) AS ym, SUM(amount) AS amt FROM invoice_sales_daily
        WHERE company = 'TGM' AND substr(d, 1, 7) BETWEEN ? AND ? GROUP BY 1, 2)
      SELECT ex.cust_code, ex.ym FROM ex JOIN bp ON bp.cust_code = ex.cust_code AND bp.ym = ex.ym WHERE abs(bp.amt - ex.amt) < 1`)
      .all(m0, m1, m0, m1).map((r) => `${r.cust_code}|${r.ym}`));
    if (!same.size) return [];
    const inRange = (company, sign) => db.prepare(`SELECT cust_code, substr(d, 1, 7) AS ym, SUM(amount) AS amount FROM invoice_sales_daily
      WHERE company = ? AND d >= ? AND d <= ? ${slmCodes.sql} GROUP BY 1, 2`).all(company, from, to, ...slmCodes.params)
      .filter((r) => same.has(`${r.cust_code}|${r.ym}`)).map((r) => ({ company, cust_code: r.cust_code, amount: sign * (Number(r.amount) || 0) }));
    return [...inRange('BP-TGM', -1), ...inRange('TGM', 1)];
  }

  // ยอดต่อลูกค้าในช่วง → Map(code → { net, consi }) · ยอดขายให้บริษัทในเครือฝั่ง Express สะสมใน map.ic (ไม่อยู่ใน map)
  function perCustomer(from, to, slmCodes) {
    const { src, raw } = companyFilter(Number(from.slice(0, 4)));
    let rows = parts(from, to, raw).flatMap((p) => db.prepare(`SELECT company, cust_code, SUM(amount) AS amount FROM ${p.t.inv}
      WHERE company IN (${inList(p.cos.length)}) AND ${p.t.col} >= ? AND ${p.t.col} <= ?
      ${slmCodes.sql}
      GROUP BY company, cust_code`).all(...p.cos, p.lo, p.hi, ...slmCodes.params));
    rows = rows.concat(expressTgmSwap(from, to, raw, slmCodes));
    const coOf = (c) => src[c] || (c === 'TGM' ? 'TGM' : c);
    const map = new Map();
    map.ic = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (reqNonSales.ic.has(r.cust_code)) { map.ic += amt; continue; }
      if (reqNonSales.staff.has(r.cust_code)) continue;
      // tgm = ส่วนที่ขายผ่านโรงงาน (Bplus) — ใช้แสดงยอดแยกบริษัทใต้ชื่อเครือใน Top 20
      const cur = map.get(r.cust_code) || { net: 0, consi: 0, tgm: 0 };
      if (coOf(r.company) === 'CONSI') cur.consi += amt;
      else cur.net += amt;
      if (coOf(r.company) === 'TGM') cur.tgm += amt;
      map.set(r.cust_code, cur);
    }
    for (const r of chainRows(from, to)) {
      const cur = map.get(r.cust_code) || { net: 0, consi: 0, tgm: 0 };
      cur.net += r.amount;
      if (r.company === 'TGM') cur.tgm += r.amount;
      map.set(r.cust_code, cur);
    }
    return map;
  }

  function customerMeta() {
    const map = new Map();
    for (const r of db.prepare(`SELECT c.code, c.name, cp.name AS pname, cp.category, cp.corporate, cp.exec_channel, cp.exec_channel_source
      FROM customers c LEFT JOIN customer_profiles cp ON cp.code = c.code`).all()) map.set(r.code, r);
    for (const r of db.prepare(`SELECT code, name AS pname, category, corporate, exec_channel, exec_channel_source
      FROM customer_profiles WHERE code NOT IN (SELECT code FROM customers)`).all()) map.set(r.code, { ...r, name: r.pname });
    // ลูกค้า Bplus ของโรงงาน — รหัสชุดเดียวกับ Express; รหัสที่ไม่มีใน Express ใช้ชื่อจาก bplus_customers · has_export ช่วยเดาหมวด
    // สาขาห้างจากห้อง SKU (รหัสไม่มีใน customers ของห้อง VAT) — corporate ตามห้างให้รวมเครือ/หมวดถูก
    for (const r of db.prepare('SELECT code, chain, name FROM chain_customers').all()) {
      const cur = map.get(r.code);
      if (!cur) map.set(r.code, { code: r.code, name: r.name, corporate: CHAIN_CORP[r.chain] || r.chain });
      else if (!cur.corporate) cur.corporate = CHAIN_CORP[r.chain] || r.chain;
    }
    for (const r of db.prepare('SELECT code, name, has_export FROM bplus_customers').all()) {
      const cur = map.get(r.code);
      if (cur) cur.has_export = r.has_export; else map.set(r.code, { code: r.code, name: r.name, has_export: r.has_export });
    }
    return map;
  }

  // ใช้ค่าที่บันทึกไว้เฉพาะที่คนตั้งเอง (manual) — ค่า 'auto' เดาซ้ำทุกครั้งตามกฎปัจจุบัน (2026-10-08) ไม่งั้นค่าที่เดาไว้ก่อน
  // ตั้งกลุ่ม/เครือหรือก่อนแก้กฎจะค้าง เช่น TG-IG-0001 (Shop พระราม 3) ค้างเป็นร้านค้าทั่วไป
  function channelOf(meta, code, hasConsi) {
    const m = meta.get(code) || {};
    if (m.exec_channel_source === 'manual' && EXEC_CHANNEL_KEYS.has(m.exec_channel)) return m.exec_channel;
    return guessExecChannel({ code, name: m.pname || m.name || '', category: m.category || '', corporate: m.corporate || '', hasConsi, hasExport: !!m.has_export });
  }

  // ลูกค้าที่ไม่นับเป็นยอดขาย (2026-10-08, ผู้ใช้ยืนยันตาม Excel "Sales Update" ของฝ่ายขาย):
  //   ic    = ขายให้บริษัทในเครือฝั่ง Express (ทีจีเอ็ม 30-IA-0002, ไทย-เยอรมัน 30-TG-*/30-TGM-*, รายได้บริหารจัดการ) → แสดงรวมกับยอดในเครือ
  //   staff = พนักงานซื้อ / เบิกตัวอย่าง → ตัดทิ้ง
  function nonSalesCodes() {
    const ic = new Set();
    const staff = new Set();
    for (const r of db.prepare(`SELECT code, category, corporate FROM customer_profiles
      WHERE category IN ('ไทย-เยอรมัน', 'ได้รายเบ็ดเตล็ด/บริหารจัดการ', 'พนักงาน', 'เบิกตัวอย่าง')
         OR corporate LIKE 'ไทย-เยอรมัน มีท โปรดักท์%' OR code LIKE '30-TG%'`).all()) {
      (r.category === 'พนักงาน' || r.category === 'เบิกตัวอย่าง' ? staff : ic).add(r.code);
    }
    for (const r of db.prepare(`SELECT code FROM customers WHERE code LIKE '30-TG%'`).all()) ic.add(r.code);
    // (2026-10-12, ผู้ใช้ขอ) ลูกค้าที่ตั้งกลุ่มเป็น "(บริษัทในเครือ)" (เช่น ทีจี โคลด์ สตอเรจ YA-005, ไทยซอสเซส TSM-01-QD ที่ขายผ่าน
    // Bplus โรงงาน) และลูกค้า Bplus ที่ติดธง is_intercompany — ไม่นับเป็นยอดขาย ไม่แสดงใน Top 20 (ไปรวมใน "ยอดในเครือ")
    for (const r of db.prepare(`SELECT code FROM customer_profiles WHERE corporate LIKE '%(บริษัทในเครือ)%'
      UNION SELECT code FROM bplus_customers WHERE is_intercompany = 1`).all()) ic.add(r.code);
    // (2026-10-14, ผู้ใช้ขอ) Shop ของบริษัท (TGM Shop โรงงาน / พระราม 3 / ตู้ทอด) ไม่นับเป็นยอดขาย — ตัดทิ้งเหมือนพนักงาน
    // ชุดเดียวกับทุกหน้า (lib/nonSales.js) · บริษัทในเครือยังแสดงใน "ยอดในเครือ" ตามเดิม
    for (const code of nonSales.nonSalesCodes(db)) if (!ic.has(code)) staff.add(code);
    return { ic, staff };
  }
  let reqNonSales = { ic: new Set(), staff: new Set() };
  const isNonSales = (code) => reqNonSales.ic.has(code) || reqNonSales.staff.has(code);

  // ขายให้บริษัทในเครือจาก Bplus โรงงาน — แสดงแยก ไม่รวมในยอดขาย (ผู้ใช้ยืนยัน 2026-10-05)
  function icTotal(from, to, slmCodes) {
    const [p] = parts(from, to, ['BP-TGM-IC']);
    const r = db.prepare(`SELECT SUM(amount) AS a FROM ${p.t.inv} WHERE company = 'BP-TGM-IC' AND ${p.t.col} >= ? AND ${p.t.col} <= ?
      ${slmCodes.sql}`).get(p.lo, p.hi, ...slmCodes.params);
    return Number(r?.a) || 0;
  }

  // KG ของ 1 บรรทัดขาย: หน่วยกิโลกรัม → qty · มีน้ำหนักใน WMS → qty_base × weight_per_unit
  // · ไม่มีใน WMS → น้ำหนักจากชื่อสินค้า × qty (lib/weightFromName.js, 2026-10-14) — ลองชื่อรหัสคู่ A-xxx / xxx ด้วย
  //   (เช่น TS0197 "แฮมหมู ตรา เอโร่" ไม่บอกน้ำหนัก แต่ A-TS0197 "แฮมหมู ตราเอโร่ 1000 กรัม") · ไม่รู้ = null (ไม่นับ KG)
  let skuNameCache = { at: 0, map: null };
  const nameKgMemo = new Map();
  function skuNames() {
    if (skuNameCache.map && Date.now() - skuNameCache.at < 10 * 60 * 1000) return skuNameCache.map;
    const map = new Map();
    for (const r of db.prepare('SELECT code, name FROM bplus_skus').all()) if (r.name) map.set(r.code, r.name);
    for (const r of db.prepare('SELECT code, name FROM products').all()) if (r.name) map.set(r.code, r.name);
    skuNameCache = { at: Date.now(), map };
    nameKgMemo.clear();
    return map;
  }
  // ชุดราคาพิเศษฝากขาย (90022-x "ทีจีเอ็มอาหารพร้อมทาน 99บาท" ฯลฯ) ไม่มีน้ำหนักในชื่อ แต่ invoice_line_components บอกสินค้าจริง
  // ในแต่ละบิล → น้ำหนักเฉลี่ยต่อแพ็ค = KG ของสินค้าลูกทั้งหมด ÷ จำนวนแพ็ค (ใช้เมื่อรู้น้ำหนักสินค้าลูก ≥ 70% ของจำนวน)
  let bundleCache = { at: 0, map: null };
  function bundleWeights(weights) {
    if (bundleCache.map && Date.now() - bundleCache.at < 10 * 60 * 1000) return bundleCache.map;
    const parentQty = new Map(db.prepare(`SELECT l.sku, SUM(l.qty) AS q FROM invoice_lines l
      WHERE EXISTS (SELECT 1 FROM invoice_line_components c WHERE c.company = l.company AND c.doc_num = l.doc_num AND c.seq_num = l.seq_num)
      GROUP BY l.sku`).all().map((r) => [r.sku, Number(r.q) || 0]));
    const acc = new Map();
    for (const r of db.prepare(`SELECT parent_sku, child_code, MAX(child_name) AS child_name, SUM(child_qty) AS q FROM invoice_line_components
      GROUP BY parent_sku, child_code`).all()) {
      const a = acc.get(r.parent_sku) || { kg: 0, known: 0, all: 0 };
      const q = Number(r.q) || 0;
      const w = weights.has(r.child_code) ? weights.get(r.child_code) : weightFromName(r.child_name, '');
      a.all += q;
      if (w != null) { a.known += q; a.kg += q * w; }
      acc.set(r.parent_sku, a);
    }
    const map = new Map();
    for (const [sku, a] of acc) {
      const pq = parentQty.get(sku);
      if (pq > 0 && a.all > 0 && a.known / a.all >= 0.7) map.set(sku, a.kg / (a.known / a.all) / pq);
    }
    bundleCache = { at: Date.now(), map };
    return map;
  }
  function lineKg(r, weights) {
    if (KG_UNIT_RE.test(r.unit_code || '')) return Number(r.qty) || 0;
    if (weights.has(r.sku)) return (Number(r.qty_base) || 0) * weights.get(r.sku);
    const bundles = bundleWeights(weights);
    if (bundles.has(r.sku)) return (Number(r.qty) || 0) * bundles.get(r.sku);
    const names = skuNames();
    const key = `${r.sku}|${r.unit_code || ''}`;
    if (!nameKgMemo.has(key)) {
      const sku = String(r.sku || '');
      const twin = sku.startsWith('A-') ? sku.slice(2) : `A-${sku}`;
      let w = weightFromName(names.get(sku), r.unit_code);
      if (w == null && weights.has(twin) && !/^(กล่อง|ลัง|ลง|กล)/.test(r.unit_code || '')) w = weights.get(twin);
      if (w == null) w = weightFromName(names.get(twin), r.unit_code);
      nameKgMemo.set(key, w);
    }
    const w = nameKgMemo.get(key);
    return w == null ? null : (Number(r.qty) || 0) * w;
  }

  // KG ของบรรทัดสรุป Bplus รหัส 0000 (ใบ Makro "A M" / EA ไม่มีสินค้า) — ใช้รายการสินค้าจริงของบิลชุดเดียวกันจาก
  // Express TGM (tgm_detail_lines_daily, 2026-10-14) ต่อลูกค้าในช่วงเดียวกัน · ช่วงเดือน = ทั้งเดือน · คืน Map(cust → kg)
  const TG_LUMP_SKU = '0000';
  function tgmDetailKg(lo, hi, custs, weights) {
    const out = new Map();
    if (!custs.length) return out;
    const d0 = lo.length === 7 ? `${lo}-01` : lo;
    const d1 = hi.length === 7 ? `${hi}-31` : hi;
    const rows = db.prepare(`SELECT cust_code, sku, unit_code, SUM(qty) AS qty, SUM(qty_base) AS qty_base FROM tgm_detail_lines_daily
      WHERE d >= ? AND d <= ? AND cust_code IN (SELECT value FROM json_each(?)) GROUP BY cust_code, sku, unit_code`).all(d0, d1, JSON.stringify(custs));
    for (const r of rows) {
      const kg = lineKg(r, weights);
      if (kg != null) out.set(r.cust_code, (out.get(r.cust_code) || 0) + kg);
    }
    return out;
  }

  // KG ต่อรหัสลูกค้า แยก net/consi สำหรับช่วงที่ระบุ — คืน Map(code → { net, consi, amt, amtKg }) โดย amt/amtKg
  // ใช้บอกสัดส่วนยอดที่คำนวณน้ำหนักได้ (สินค้าที่ WMS ยังไม่มีน้ำหนัก → ไม่นับ KG)
  function kgPerCustomer(from, to, codes, slmCodes) {
    const out = new Map();
    if (!codes.length) return out;
    const { src, raw } = companyFilter(Number(from.slice(0, 4)));
    const weights = loadWeights();
    const CHUNK = 800;
    for (let i = 0; i < codes.length; i += CHUNK) {
      const part = codes.slice(i, i + CHUNK);
      const lump = new Map(); // `${lo}|${hi}` → Map(cust → ยอดบรรทัด 0000)
      const rows = parts(from, to, raw).flatMap((p) => db.prepare(`SELECT company, cust_code, sku, unit_code, SUM(qty) AS qty, SUM(qty_base) AS qty_base, SUM(amount) AS amount
        FROM ${p.t.lines}
        WHERE company IN (${inList(p.cos.length)}) AND ${p.t.col} >= ? AND ${p.t.col} <= ? AND cust_code IN (${inList(part.length)})
        ${slmCodes.sql}
        GROUP BY company, cust_code, sku, unit_code`).all(...p.cos, p.lo, p.hi, ...part, ...slmCodes.params).map((r) => ({ ...r, range: `${p.lo}|${p.hi}` })));
      for (const r of rows) {
        const cur = out.get(r.cust_code) || { net: 0, consi: 0, amt: 0, amtKg: 0 };
        const amt = Math.abs(Number(r.amount) || 0);
        cur.amt += amt;
        out.set(r.cust_code, cur);
        if (r.sku === TG_LUMP_SKU && r.company === 'BP-TGM') {
          const m = lump.get(r.range) || new Map();
          m.set(r.cust_code, (m.get(r.cust_code) || 0) + amt);
          lump.set(r.range, m);
          continue;
        }
        const kg = lineKg(r, weights);
        if (kg != null) {
          cur.amtKg += amt;
          if (src[r.company] === 'CONSI') cur.consi += kg; else cur.net += kg;
        }
      }
      for (const [range, m] of lump) {
        const [lo, hi] = range.split('|');
        const detail = tgmDetailKg(lo, hi, [...m.keys()], weights);
        for (const [cust, amt] of m) {
          if (!detail.has(cust)) continue;
          const cur = out.get(cust);
          cur.net += detail.get(cust);
          cur.amtKg += amt;
        }
      }
    }
    return out;
  }

  // ยอดรายสินค้า (2026-10-12, ผู้ใช้ขอ Top 20 สินค้าขายดี) — จาก sales_lines (STCRD/Bplus รายบรรทัด) ตัวกรองชุดเดียวกับ /exec
  // (บริษัท, ช่วงวันที่, Sales/สิทธิ์) ไม่นับบริษัทในเครือ/พนักงาน · KG = หน่วยกก. หรือ qty_base × น้ำหนัก WMS
  // คืน Map(sku → { amount, qty, kg, kgKnown(ยอดที่คำนวณ KG ได้) })
  function perProduct(from, to, slmCodes, withConsi) {
    const { src, raw } = companyFilter(Number(from.slice(0, 4)));
    const cos = withConsi ? raw : raw.filter((c) => src[c] !== 'CONSI');
    const weights = loadWeights();
    const skip = JSON.stringify([...reqNonSales.ic, ...reqNonSales.staff]);
    const out = new Map();
    if (!cos.length) return out;
    const rows = parts(from, to, cos).flatMap((p) => db.prepare(`SELECT sku, unit_code, SUM(qty) AS qty, SUM(qty_base) AS qty_base, SUM(amount) AS amount
      FROM ${p.t.lines}
      WHERE company IN (${inList(p.cos.length)}) AND ${p.t.col} >= ? AND ${p.t.col} <= ?
        AND cust_code NOT IN (SELECT value FROM json_each(?))
      ${slmCodes.sql}
      GROUP BY sku, unit_code`).all(...p.cos, p.lo, p.hi, skip, ...slmCodes.params));
    for (const r of rows) {
      if (!r.sku) continue;
      const cur = out.get(r.sku) || { amount: 0, qty: 0, kg: 0, kgAmt: 0 };
      const amt = Number(r.amount) || 0;
      cur.amount += amt;
      cur.qty += Number(r.qty) || 0;
      const kg = r.sku === TG_LUMP_SKU ? null : lineKg(r, weights);
      if (kg != null) { cur.kg += kg; cur.kgAmt += Math.abs(amt); }
      out.set(r.sku, cur);
    }
    // บรรทัด 0000 ของ Bplus → KG จากรายการจริงใน Express TGM ของลูกค้าที่มีบรรทัดนี้ (ตัวกรองเดียวกัน)
    const lumpCur = out.get(TG_LUMP_SKU);
    if (lumpCur && cos.includes('BP-TGM')) {
      for (const p of parts(from, to, ['BP-TGM'])) {
        const lumps = db.prepare(`SELECT cust_code, SUM(amount) AS amount FROM ${p.t.lines}
          WHERE company = 'BP-TGM' AND sku = ? AND ${p.t.col} >= ? AND ${p.t.col} <= ?
            AND cust_code NOT IN (SELECT value FROM json_each(?))
          ${slmCodes.sql}
          GROUP BY cust_code`).all(TG_LUMP_SKU, p.lo, p.hi, skip, ...slmCodes.params);
        const detail = tgmDetailKg(p.lo, p.hi, lumps.map((r) => r.cust_code), weights);
        for (const r of lumps) {
          if (!detail.has(r.cust_code)) continue;
          lumpCur.kg += detail.get(r.cust_code);
          lumpCur.kgAmt += Math.abs(Number(r.amount) || 0);
        }
      }
    }
    return out;
  }
  function topProducts(from, to, lyFrom, lyTo, slmCodes, withConsi) {
    const ty = perProduct(from, to, slmCodes, withConsi);
    const ly = perProduct(lyFrom, lyTo, slmCodes, withConsi);
    const totals = { amount: 0, kg: 0 };
    for (const v of ty.values()) { totals.amount += v.amount; totals.kg += v.kg; }
    const names = db.prepare(`SELECT p.name AS p_name, p.group_name AS g, s.name AS s_name FROM (SELECT ? AS code) x
      LEFT JOIN products p ON p.code = x.code LEFT JOIN bplus_skus s ON s.code = x.code`);
    const shape = ([sku, v]) => {
      const n = names.get(sku) || {};
      const l = ly.get(sku);
      return { sku, name: n.s_name || n.p_name || sku, group: n.g || '', amount: v.amount, qty: v.qty, kg: v.kg,
        kg_coverage: Math.abs(v.amount) > 0 ? v.kgAmt / Math.abs(v.amount) : null,
        ly_amount: l ? l.amount : 0, ly_kg: l ? l.kg : 0 };
    };
    const list = [...ty.entries()].filter(([, v]) => v.amount > 0);
    return {
      totals,
      by_amount: [...list].sort((a, b) => b[1].amount - a[1].amount).slice(0, 20).map(shape),
      by_kg: [...list].filter(([, v]) => v.kg > 0).sort((a, b) => b[1].kg - a[1].kg).slice(0, 20).map(shape),
    };
  }

  // GET /api/dashboard/exec?from=YYYY-MM&to=YYYY-MM&slm=101,110-1&consi=1&makro_in_mall=0
  // แคชผลลัพธ์ /exec (2026-10-09, ผู้ใช้ขอให้ระบบเร็วขึ้น — วัดจริง 0.6–1.5 วิ/ครั้ง) — ดู lib/responseCache.js
  router.get('/exec', cacheJson(db));
  router.get('/exec', (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      const daily = YMD_RE.test(from) && YMD_RE.test(to);
      if (!daily && !(YM_RE.test(from) && YM_RE.test(to))) return res.status(400).json({ error: 'from/to ต้องเป็น YYYY-MM หรือ YYYY-MM-DD (ทั้งคู่แบบเดียวกัน)' });
      if (daily && [from, to].some((x) => Number.isNaN(Date.parse(x + 'T00:00:00Z')) || new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) !== x)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });
      if (from.slice(0, 4) !== to.slice(0, 4) || from > to) return res.status(400).json({ error: 'from/to ต้องอยู่ในปีเดียวกัน และ from ≤ to' });
      const year = Number(from.slice(0, 4));
      if (year < 2020 || year > 2100) return res.status(400).json({ error: 'ปีไม่ถูกต้อง' });
      // ตัวกรอง Sales + สิทธิ์ (2026-10-06, lib/customerScope.js): slmCodes เป็น {sql, params} ที่ต่อท้าย WHERE ได้เลย
      //   · ไม่จำกัด: เลือก Sales มา = slm_code IN (…) · ไม่เลือก = ทั้งหมด
      //   · ถูกจำกัด: เลือก Sales มา = ตัดให้เหลือเฉพาะรหัสที่ดูได้ (ไม่เหลือ = ว่าง) · ไม่เลือก = รหัสที่ดูได้ + ลูกค้าเจ้า MT
      const scope = resolveScope(db, req.user);
      let wantSlm = [...new Set(String(req.query.slm || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50);
      if (!scope.all && wantSlm.length) wantSlm = wantSlm.filter((c) => scope.slmCodes.includes(c));
      const slmCodes = req.query.slm && (scope.all || wantSlm.length || String(req.query.slm).trim())
        ? (wantSlm.length ? { sql: `AND slm_code IN (${inList(wantSlm.length)})`, params: wantSlm } : { sql: 'AND 0', params: [] })
        : scope.all ? { sql: '', params: [] } : (() => { const x = factSql(scope, { cust: 'cust_code', slm: 'slm_code' }); return { sql: `AND ${x.sql}`, params: x.params }; })();
      const withConsi = req.query.consi !== '0';
      const makroInMall = req.query.makro_in_mall === '1';
      const co = String(req.query.co || 'all');
      if (!['all', 'tss', 'tgm'].includes(co)) return res.status(400).json({ error: 'co ต้องเป็น all, tss หรือ tgm' });
      reqCo = co;
      const noNv = req.query.no_nv === '1';
      const noBakery = req.query.no_bakery === '1';
      reqNoNv = noNv;
      reqBakery = noBakery
        ? new Set(db.prepare(`SELECT code FROM customer_profiles WHERE category = 'เบเกอรี่' OR category LIKE '%/เบเกอรี่'`).all().map((r) => r.code))
        : null;
      if (noBakery) slmCodes.sql += ` AND ${BAKERY_SQL}`;
      {
        const salesView = !!String(req.query.slm || '').trim() || !scope.all;
        const cmap = salesView ? chainSales.loadChainMap(db) : null;
        const slms = new Set(String(req.query.slm || '').trim() ? wantSlm : (scope.slmCodes || []));
        reqChain = cmap && chainSales.replacedRanges(cmap).length ? { map: cmap, slms } : null;
        if (reqChain) {
          const nr = chainSales.notReplacedSql(cmap, 'cust_code');
          slmCodes.sql += ` ${nr.sql}`;
          slmCodes.params = [...slmCodes.params, ...nr.params];
        }
      }
      reqBpDailyMissing = daily && !db.prepare("SELECT 1 FROM invoice_sales_daily WHERE company = 'BP-TGM' LIMIT 1").get();
      reqNonSales = nonSalesCodes();
      const lyFrom = shiftYear(from, -1);
      const lyTo = shiftYear(to, -1);

      const ty = perCustomer(from, to, slmCodes);
      const ly = perCustomer(lyFrom, lyTo, slmCodes);
      const meta = customerMeta();
      // ลูกค้าที่เคยมียอดฝากขาย (ทุกปี) — ใช้ชุดเดียวกันทุกส่วนของหน้า ให้หมวดของลูกค้าไม่เปลี่ยนไปตามช่วงเวลาที่เลือก
      const consiCodes = new Set(db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE company = 'CONSI'`).all().map((r) => r.cust_code));

      const sum = (map, k) => [...map.values()].reduce((a, v) => a + v[k], 0);
      const active = (map) => [...map.values()].filter((v) => v.net + (withConsi ? v.consi : 0) > 0.005).length;
      const kpi = {
        ty_net: sum(ty, 'net'), ty_consi: sum(ty, 'consi'), ly_net: sum(ly, 'net'), ly_consi: sum(ly, 'consi'),
        ty_active: active(ty), ly_active: active(ly),
        // ยอดในเครือ = โรงงานขายให้ไทยซอสเซสฯ (BP-TGM-IC) + TSS ขายให้ไทย-เยอรมัน (ty.ic — ดู nonSalesCodes)
        ty_ic: (co === 'tss' ? 0 : icTotal(from, to, slmCodes)) + ty.ic,
        ly_ic: (co === 'tss' ? 0 : icTotal(lyFrom, lyTo, slmCodes)) + ly.ic,
      };

      // หมวด + กลุ่มลูกค้า (Corporate group ก่อน ไม่มีค่อยใช้ชื่อลูกค้า — กติกาเดียวกับ Top 10 ลูกค้าเดิม)
      const channelAgg = Object.fromEntries(EXEC_CHANNELS.map((c) => [c.key, { ty_net: 0, ty_consi: 0, ly_net: 0, ly_consi: 0 }]));
      const groups = new Map();
      const codes = new Set([...ty.keys(), ...ly.keys()]);
      for (const code of codes) {
        const t = ty.get(code) || { net: 0, consi: 0, tgm: 0 };
        const l = ly.get(code) || { net: 0, consi: 0, tgm: 0 };
        const ch = channelOf(meta, code, consiCodes.has(code));
        const a = channelAgg[ch];
        a.ty_net += t.net; a.ty_consi += t.consi; a.ly_net += l.net; a.ly_consi += l.consi;
        const m = meta.get(code) || {};
        // รวมเป็น "เครือลูกค้า" (2026-10-05): ตัดชื่อบริษัท/ฝากขาย/หน่วยย่อยออกจาก corporate แล้วจับชื่อสะกดต่างกันเข้าเครือเดียว
        // เช่น Makro TSS + Makro TGM → Makro · ดูกฎใน lib/customerGroup.js
        const gname = groupNameOf({ corporate: m.corporate, name: m.pname || m.name, code });
        const g = groups.get(gname) || { name: gname, codes: [], ty_net: 0, ty_consi: 0, ly_net: 0, ly_consi: 0, ty_tgm: 0, chAmt: {} };
        g.codes.push(code);
        g.ty_net += t.net; g.ty_consi += t.consi; g.ly_net += l.net; g.ly_consi += l.consi; g.ty_tgm += t.tgm;
        g.chAmt[ch] = (g.chAmt[ch] || 0) + Math.abs(t.net + t.consi) + Math.abs(l.net + l.consi);
        groups.set(gname, g);
      }
      for (const g of groups.values()) g.channel = Object.entries(g.chAmt).sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';

      // Makro นับเป็นห้างเสมอใน Top 20 — อยู่แท็บห้าง ไม่อยู่แท็บร้านค้า (ผู้ใช้ยืนยัน 2026-10-05; เดิมเป็นสวิตช์ makro_in_mall)
      const isMall = (g) => g.channel === 'mall' || g.channel === 'makro';
      // ไม่นับใน Top 20 (2026-10-05, ผู้ใช้ขอ): ไทย-เยอรมัน/ทีจีเอ็ม (30-IA-0002, 30-LA-0002 — บริษัทในเครือ) และกลุ่ม Shop
      // (Shop โรงงาน / Shop พระราม 3) — ยังนับใน KPI และยอดตามหมวดตามเดิม · จับชื่อเครือแบบตรงตัว ไม่ใช่ "มีคำว่า"
      // เพื่อไม่ให้โดน "วิลล่า … (ตู้ทีจีเอ็ม)" หรือ "ร้านอาหารไทย-เยอรมัน"
      const OFF_TOP_NAMES = new Set(['ไทย-เยอรมัน', 'ทีจีเอ็ม']);
      const OFF_TOP_CHANNELS = new Set(['shop_factory', 'shop_rama3']);
      const allGroups = [...groups.values()];
      // ปุ่ม "รวม Makro" (makro_in_mall=1): ปิด = ซ่อน Makro จาก Top 20 ทุกแท็บ (ยังนับใน KPI) · เปิด = แสดงในแท็บรวม/ห้าง
      // Makro ไม่อยู่แท็บร้านค้าไม่ว่ากรณีใด (ผู้ใช้ยืนยัน 2026-10-05)
      const offTop = allGroups.filter((g) => OFF_TOP_NAMES.has(g.name) || OFF_TOP_CHANNELS.has(g.channel) || (!makroInMall && g.channel === 'makro'));
      const list = allGroups.filter((g) => !offTop.includes(g));
      const top = {
        all: list.filter((g) => g.ty_net + (withConsi ? g.ty_consi : 0) > 0)
          .sort((a, b) => (b.ty_net + (withConsi ? b.ty_consi : 0)) - (a.ty_net + (withConsi ? a.ty_consi : 0))).slice(0, 20),
        mall: list.filter((g) => isMall(g) && g.ty_net + g.ty_consi > 0)
          .sort((a, b) => (b.ty_net + b.ty_consi) - (a.ty_net + a.ty_consi)).slice(0, 20),
        shop: list.filter((g) => !isMall(g) && g.ty_net > 0).sort((a, b) => b.ty_net - a.ty_net).slice(0, 20),
      };

      const topCodes = [...new Set([...top.all, ...top.mall, ...top.shop].flatMap((g) => g.codes))];
      const kgTy = kgPerCustomer(from, to, topCodes, slmCodes);
      const kgLy = kgPerCustomer(lyFrom, lyTo, topCodes, slmCodes);
      const shape = (g) => {
        const k = { ty_net: 0, ty_consi: 0, ly_net: 0, ly_consi: 0, amt: 0, amtKg: 0 };
        for (const c of g.codes) {
          const a = kgTy.get(c); const b = kgLy.get(c);
          if (a) { k.ty_net += a.net; k.ty_consi += a.consi; k.amt += a.amt; k.amtKg += a.amtKg; }
          if (b) { k.ly_net += b.net; k.ly_consi += b.consi; k.amt += b.amt; k.amtKg += b.amtKg; }
        }
        return {
          name: g.name, channel: g.channel, branches: g.codes.length,
          ty_net: g.ty_net, ty_consi: g.ty_consi, ly_net: g.ly_net, ly_consi: g.ly_consi,
          // ยอดปีนี้ที่ขายผ่านโรงงาน TGM (ส่วนที่เหลือของ ty_net + ty_consi คือ TSS/TSS-NV/CONSI)
          ty_tgm: g.ty_tgm,
          kg_ty_net: k.ty_net, kg_ty_consi: k.ty_consi, kg_ly_net: k.ly_net, kg_ly_consi: k.ly_consi,
          kg_coverage: k.amt > 0 ? k.amtKg / k.amt : null,
        };
      };

      const freshness = db.prepare(`SELECT MAX(ym) AS last_ym FROM invoice_sales_monthly WHERE company IN ('TSS','CONSI')`).get();
      const lastDay = daily ? db.prepare(`SELECT MAX(d) AS d FROM invoice_sales_daily WHERE company IN ('TSS','CONSI')`).get() : null;
      const linesSync = db.prepare(`SELECT MAX(synced_at) AS at FROM sync_file_state WHERE source LIKE '%/STCRD.DBF'`).get();

      res.json({
        from, to, ly_from: lyFrom, ly_to: lyTo, with_consi: withConsi, makro_in_mall: makroInMall, co, no_nv: noNv, no_bakery: noBakery,
        monthly: { ty: monthly(year, slmCodes, meta, consiCodes), ly: monthly(year - 1, slmCodes, meta, consiCodes) },
        kpi,
        channels: EXEC_CHANNELS.map((c) => ({ key: c.key, label: c.label, ...channelAgg[c.key] })),
        top: { all: top.all.map(shape), mall: top.mall.map(shape), shop: top.shop.map(shape) },
        top_products: topProducts(from, to, lyFrom, lyTo, slmCodes, withConsi),
        top_excluded: offTop.map((g) => ({ name: g.name, channel: g.channel, ty: g.ty_net + (withConsi ? g.ty_consi : 0) }))
          .filter((x) => Math.abs(x.ty) > 0.5).sort((a, b) => b.ty - a.ty),
        last_ym: freshness?.last_ym || null,
        daily, last_d: lastDay?.d || null, tgm_daily_missing: reqBpDailyMissing,
        kg_synced_at: linesSync?.at || null,
      });
    } catch (e) {
      console.error('[dashboardExec] /exec failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/dashboard/exec_channel/autofill — ให้ระบบเดาหมวดให้ลูกค้าที่มียอดตั้งแต่ 2024 และยังไม่ถูกตั้งด้วยมือ
  // ไม่ทับค่าที่ source='manual' เด็ดขาด · ทำใน transaction เดียว
  router.post('/exec_channel/autofill', requireRole(...AUTOFILL_ROLES), (req, res) => {
    try {
      const meta = customerMeta();
      const consiCodes = new Set(db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE company = 'CONSI'`).all().map((r) => r.cust_code));
      const codes = db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE ym >= '2024-01'`).all().map((r) => r.cust_code)
        .filter((c) => c && c !== '(none)');
      const known = new Set(db.prepare('SELECT code FROM customers').all().map((r) => r.code));
      const upsert = db.prepare(`INSERT INTO customer_profiles (code, exec_channel, exec_channel_source, edited_by, updated_at)
        VALUES (?, ?, 'auto', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(code) DO UPDATE SET exec_channel = excluded.exec_channel, exec_channel_source = 'auto', updated_at = excluded.updated_at
        WHERE COALESCE(customer_profiles.exec_channel_source, '') <> 'manual'`);
      const counts = {};
      let updated = 0, skippedManual = 0;
      db.exec('BEGIN');
      try {
        for (const code of codes) {
          if (!known.has(code)) continue;
          const m = meta.get(code) || {};
          if (m.exec_channel_source === 'manual') { skippedManual++; continue; }
          const ch = guessExecChannel({ code, name: m.pname || m.name || '', category: m.category || '', corporate: m.corporate || '', hasConsi: consiCodes.has(code), hasExport: !!m.has_export });
          if (upsert.run(code, ch, req.user?.uid || 'system').changes) { updated++; counts[ch] = (counts[ch] || 0) + 1; }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      res.json({ updated, skipped_manual: skippedManual, counts });
    } catch (e) {
      console.error('[dashboardExec] autofill failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/dashboard/business_type/autofill — เดาประเภทธุรกิจลูกค้า (lib/businessType.js) · ไม่ทับค่าที่ตั้งเอง (2026-10-07)
  router.post('/business_type/autofill', requireRole(...AUTOFILL_ROLES), (req, res) => {
    try {
      res.json(autofillBusinessTypes(db, req.user?.uid || 'system'));
    } catch (e) {
      console.error('[dashboardExec] business_type autofill failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // บรรทัดสินค้าจริงของโรงงาน (Bplus) สำหรับ Sales Overview แท็บรายสินค้า + ชื่อลูกค้า/พนักงานขายโรงงาน (2026-10-05)
  // กลุ่มสินค้าใช้ products.group_name (STKGRP) ชุดเดียวกับ TSS — รหัสโรงงานที่ไม่มีใน Express (เช่น 20394-177 "ตราทีจีเอ็ม (HK)")
  // ใช้กลุ่มของสินค้า Express ที่ขึ้นต้นรหัสเดียวกัน (20394-xx) · รหัส 0000 = ยอดสรุปสินค้ารหัส TG ที่ Bplus ไม่แยกรายตัว
  // ไม่มีทั้งรหัสตรงและขึ้นต้นรหัส (บาร์โค้ด 8850826…, 20368-177 HK) → เทียบชื่อกับสินค้า Express (lib/productGroupMatch.js, 2026-10-14)
  // กลุ่มสินค้าจากรหัสขึ้นต้น / ชื่อ — ย้ายไป lib/productGroupMatch.js (ใช้ร่วมกับ /api/invoice_detail/pivot, 2026-10-14)
  const productGroupByPrefix = () => productGroupResolver(db);
  router.get('/bplus/sales_lines', (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!YM_RE.test(from) || !YM_RE.test(to) || from > to) return res.status(400).json({ error: 'from/to ต้องเป็น YYYY-MM และ from ≤ to' });
      // สิทธิ์การเห็น (2026-10-12, security review) — กรองแบบเดียวกับ /exec และ invoice_sales_monthly (lib/customerScope.js)
      const scope = resolveScope(db, req.user);
      const sc = nonSales.withExclude(db, factSql(scope, { cust: 'l.cust_code', slm: 'l.slm_code' }), 'l.cust_code'); // + ตัดบริษัทในเครือ/Shop
      const rows = db.prepare(`SELECT l.ym, l.cust_code, l.slm_code, l.sku, SUM(l.qty) AS qty, SUM(l.amount) AS amount,
          p.name AS p_name, p.group_name AS p_group, s.name AS s_name
        FROM sales_lines_monthly l LEFT JOIN products p ON p.code = l.sku LEFT JOIN bplus_skus s ON s.code = l.sku
        WHERE l.company = 'BP-TGM' AND l.ym >= ? AND l.ym <= ?${sc ? ` AND ${sc.sql}` : ''}
        GROUP BY l.ym, l.cust_code, l.slm_code, l.sku`).all(from, to, ...(sc ? sc.params : []));
      const { map: pre, byName } = productGroupByPrefix();
      const out = rows.map((r) => {
        const group = r.sku === '0000' ? 'ไม่ระบุสินค้า (TG)'
          : (r.p_group || pre.get(String(r.sku).split('-')[0]) || byName(r.s_name || r.p_name) || '');
        return { ym: r.ym, cust_code: r.cust_code, slm_code: r.slm_code, prod_code: r.sku, prod_name: r.s_name || r.p_name || r.sku,
          prod_group: group, qty: Number(r.qty) || 0, amount: Number(r.amount) || 0 };
      });
      // ถูกจำกัดสิทธิ์ = ส่งชื่อเฉพาะรหัสที่อยู่ในแถวที่เห็น
      const seenCust = new Set(out.map((r) => r.cust_code)), seenSlm = new Set(out.map((r) => r.slm_code));
      const customers = Object.fromEntries(db.prepare('SELECT code, name FROM bplus_customers').all()
        .filter((r) => scope.all || seenCust.has(r.code)).map((r) => [r.code, r.name]));
      const salesmen = Object.fromEntries(db.prepare('SELECT bp_code, bp_name FROM bplus_salesman_map').all()
        .filter((r) => scope.all || seenSlm.has(`BP-${r.bp_code}`)).map((r) => [`BP-${r.bp_code}`, r.bp_name]));
      res.json({ rows: out, customers, salesmen });
    } catch (e) {
      console.error('[dashboardExec] bplus/sales_lines failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ตารางจับคู่รหัสพนักงานขาย Bplus โรงงาน → รหัส Sales ใน Express (2026-10-05, ผู้ใช้เลือก "จับคู่กับรหัส Express")
  // GET คืนรายการพร้อมยอดขายตั้งแต่ 2025 ต่อรหัส (ช่วยเลือก) · PUT { rows:[{bp_code, slm_code}] } — slm_code ว่าง = ยกเลิกจับคู่
  // มีผลในรอบ sync Bplus ถัดไป (ล้างเวลา sync ล่าสุดให้รันในรอบ Express ถัดไปภายใน ~15 นาที)
  router.get('/bplus/salesmen', (req, res) => {
    try {
      const rows = db.prepare(`SELECT m.bp_code, m.bp_name, m.slm_code, m.updated_by, m.updated_at,
          (SELECT COUNT(*) FROM bplus_customers c WHERE c.bp_slm_code = m.bp_code AND c.is_intercompany = 0) AS customers
        FROM bplus_salesman_map m
        WHERE m.slm_code IS NOT NULL OR EXISTS (SELECT 1 FROM bplus_customers c WHERE c.bp_slm_code = m.bp_code)
        ORDER BY m.bp_code`).all();
      const sync = db.prepare(`SELECT synced_at FROM sync_file_state WHERE source = 'bplus/TGM'`).get();
      res.json({ rows, synced_at: sync?.synced_at || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  router.put('/bplus/salesmen', requireRole(...AUTOFILL_ROLES), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length > 500) return res.status(400).json({ error: 'rows is required (≤ 500)' });
    const up = db.prepare(`UPDATE bplus_salesman_map SET slm_code = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE bp_code = ?`);
    try {
      db.exec('BEGIN');
      let n = 0;
      for (const r of rows) {
        const bp = String(r?.bp_code || '').trim();
        const slm = String(r?.slm_code || '').trim();
        if (!bp || slm.length > 40 || /[,\s]/.test(slm)) throw new Error(`แถวไม่ถูกต้อง: ${bp || '(ไม่มีรหัส)'} → ${slm}`);
        n += up.run(slm || null, req.user?.uid || null, bp).changes;
      }
      db.prepare(`UPDATE sync_file_state SET synced_at = NULL WHERE source = 'bplus/TGM'`).run();
      db.exec('COMMIT');
      res.json({ updated: n });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* not in tx */ }
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};
