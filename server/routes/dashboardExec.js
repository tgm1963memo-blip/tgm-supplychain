'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');
const execCh = require('../lib/execChannel');
const { EXEC_CHANNELS, guessExecChannel } = execCh;
const { groupNameOf } = require('../lib/customerGroup');
const { autofillBusinessTypes } = require('../lib/businessType');
const { cacheJson } = require('../lib/responseCache');
const { resolveScope, factSql, slmListSql } = require('../lib/customerScope');
const chainSales = require('../lib/chainSales');
const { productGroupResolver } = require('../lib/productGroupMatch');
const nonSales = require('../lib/nonSales');
const skuCost = require('../lib/skuCost');

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

// น้ำหนักต่อหน่วย (WMS) / KG ต่อบรรทัดขาย → lib/lineWeight.js (2026-11-16)
const { loadWeights, lineWeights } = require('../lib/lineWeight');

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
    map.shop = new Map(); // รหัส Shop → ยอด (ไม่อยู่ใน map — แสดงแยกเป็น "ยอด Shop")
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (reqNonSales.ic.has(r.cust_code)) { map.ic += amt; continue; }
      if (reqNonSales.shop.has(r.cust_code)) { map.shop.set(r.cust_code, (map.shop.get(r.cust_code) || 0) + amt); continue; }
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

  // ข้อมูลเดาหมวด + กติกาหมวด ย้ายไป lib/execChannel.js (2026-10-22) — ใช้ร่วมกับสิทธิ์ "ดูทีมห้างทั้งหมด" ใน lib/customerScope.js
  const customerMeta = () => execCh.customerMeta(db);
  const channelOf = execCh.channelOf;

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
    // (2026-11-17, ผู้ใช้ขอ) Shop ของบริษัท — ยังไม่นับเป็นยอดขาย แต่แสดงยอดแยกเป็น "ยอด Shop" ใต้ KPI (เหมือนยอดในเครือ)
    //   รวม Shop โรงงาน (Bplus BP-POS) + Shop พระราม 3 (TG-IG-0001 ซุปเปอร์สุธิดา) และ Shop ฝั่ง Express
    const shop = new Set(db.prepare(`SELECT code FROM customer_profiles
      WHERE business_type = 'company_shop' OR exec_channel IN ('shop_factory', 'shop_rama3')
         OR corporate LIKE 'TGM Shop%' OR corporate LIKE 'TGM. SHOP%' OR corporate LIKE 'Shop โรงงาน%'`).all()
      .map((r) => r.code).filter((c) => staff.has(c)));
    return { ic, staff, shop };
  }
  let reqNonSales = { ic: new Set(), staff: new Set(), shop: new Set() };
  const isNonSales = (code) => reqNonSales.ic.has(code) || reqNonSales.staff.has(code);

  // ขายให้บริษัทในเครือจาก Bplus โรงงาน — แสดงแยก ไม่รวมในยอดขาย (ผู้ใช้ยืนยัน 2026-10-05)
  function icTotal(from, to, slmCodes) {
    const [p] = parts(from, to, ['BP-TGM-IC']);
    const r = db.prepare(`SELECT SUM(amount) AS a FROM ${p.t.inv} WHERE company = 'BP-TGM-IC' AND ${p.t.col} >= ? AND ${p.t.col} <= ?
      ${slmCodes.sql}`).get(p.lo, p.hi, ...slmCodes.params);
    return Number(r?.a) || 0;
  }

  // KG ของ 1 บรรทัดขาย / ชื่อสินค้า — lib/lineWeight.js (ย้ายออกมา 2026-11-16 ให้ /api/invoice_detail/pivot ใช้ร่วม)
  const { lineKg, skuNames } = lineWeights(db);

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

  // ── กำไรขั้นต้น (2026-11-16, ทุน 3 ช่องจากไฟล์ Master SKU — lib/skuCost.js) ───────────────────────────
  // ส่งเฉพาะผู้มีสิทธิ์เห็นทุน (skuCost.canSeeCost) — execPayload ไม่ใส่ก้อน margin ให้คนอื่นเลย · รายงาน LINE เรียก execPayload
  // ด้วย user = null จึงไม่มีกำไรติดไป
  // แหล่งข้อมูล: sales_lines_daily ทั้งปีของช่วงที่เลือก (ต้องรู้วันขายเพื่อใช้ทุนที่มีผล ณ วันนั้น) ตัวกรองชุดเดียวกับ perProduct
  //   รวมกลุ่มตาม "ช่วงทุน" bk = จำนวนรอบทุนที่เริ่มมีผลแล้ว ณ วันขาย → ทุกวันในกลุ่มเดียวกันใช้ทุนรอบเดียวกัน คิดทุนครั้งเดียวต่อ SKU×ช่วงทุน
  // กำไรคิดได้เฉพาะบรรทัดที่มีรหัสสินค้า + มีทุน + เทียบหน่วยได้ (covered) — ส่วนที่เหลือรายงานใน gaps ไม่ประมาณ:
  //   ยอดห้อง SKU/DC และบิลสรุป Bplus รหัส 0000 ไม่มีรหัสสินค้า · ยอด KPI มาจากใบกำกับ (ARTRN) จึงไม่เท่ากับผลรวมบรรทัดสินค้าพอดี
  // cogs เก็บครบ 3 ฐาน (total/depr/base) ให้หน้าจอสลับได้โดยไม่ต้องโหลดใหม่
  function marginData(year, from, to, slmCodes, withConsi, meta, consiCodes, codeGroup, wantGroups, wantSkus) {
    const ctx = skuCost.costContext(db);
    const effDates = [...new Set([...ctx.idx.values()].flatMap((l) => l.map((r) => r.eff_date)))].sort();
    if (!effDates.length) return { has_cost: false };
    const { src, raw } = companyFilter(year);
    const cos = withConsi ? raw : raw.filter((c) => src[c] !== 'CONSI');
    const lo = from.length === 10 ? from : `${from}-01`;
    const hi = to.length === 10 ? to : `${to}-31`;
    const skip = JSON.stringify([...reqNonSales.ic, ...reqNonSales.staff]);
    const rows = cos.length ? db.prepare(`SELECT company, cust_code, sku, unit_code, substr(d, 1, 7) AS ym,
        (${effDates.map(() => '(d >= ?)').join(' + ')}) AS bk, (d >= ? AND d <= ?) AS inr, MIN(d) AS d0,
        SUM(qty) AS qty, SUM(qty_base) AS qty_base, SUM(amount) AS amount
      FROM sales_lines_daily
      WHERE company IN (${inList(cos.length)}) AND d >= ? AND d <= ?
        AND cust_code NOT IN (SELECT value FROM json_each(?))
      ${slmCodes.sql}
      GROUP BY company, cust_code, sku, unit_code, ym, bk, inr`)
      .all(...effDates, lo, hi, ...cos, `${year}-01-01`, `${year}-12-31`, skip, ...slmCodes.params) : [];

    const zero = () => ({ lines: 0, covered: 0, cogs: { total: 0, depr: 0, base: 0 } });
    const add = (a, amt, cg) => {
      a.lines += amt;
      if (!cg) return;
      a.covered += amt;
      a.cogs.total += cg.total; a.cogs.depr += cg.depr; a.cogs.base += cg.base;
    };
    const totals = zero();
    const monthlyAgg = {};
    const channels = Object.fromEntries(EXEC_CHANNELS.map((c) => [c.key, zero()]));
    const groupAgg = new Map();
    const products = new Map();
    const gaps = { lump: 0, no_cost: new Map(), unit: new Map(), est_covered: 0 };
    const costMemo = new Map();
    const chMemo = new Map();
    let weights = null;
    for (const r of rows) {
      if (!r.sku) continue;
      const amt = Number(r.amount) || 0;
      let cg = null, cost = null, q = null, reason = null;
      if (r.sku === TG_LUMP_SKU) reason = 'lump';
      else {
        const ck = `${r.sku}|${r.bk}`;
        if (!costMemo.has(ck)) costMemo.set(ck, skuCost.resolveAll(ctx, r.sku, r.d0));
        cost = costMemo.get(ck);
        if (!cost) reason = 'no_cost';
        else {
          const line = { qty: r.qty, qty_base: r.qty_base, unit_code: r.unit_code, base_unit: ctx.baseUnits.get(r.sku) };
          q = skuCost.costQty(cost, line);
          if (q == null) {
            weights = weights || loadWeights();
            const kg = lineKg(r, weights);
            if (kg != null) q = skuCost.costQty(cost, { ...line, kg });
            if (!skuCost.kgPathOk(cost, q, r.amount)) q = null; // น้ำหนักผิดหน่วย — ดู lib/skuCost.js kgPathOk
            if (q == null) q = skuCost.packQty(cost, line); // แพ ↔ ซอง ↔ ถุง ↔ ถาด
          }
          if (q == null) reason = 'unit';
          else cg = { total: cost.costs.total * q, depr: cost.costs.depr * q, base: cost.costs.base * q };
        }
      }
      add((monthlyAgg[r.ym] = monthlyAgg[r.ym] || zero()), amt, cg);
      if (!r.inr) continue;
      add(totals, amt, cg);
      let ch = chMemo.get(r.cust_code);
      if (!ch) { ch = channelOf(meta, r.cust_code, consiCodes.has(r.cust_code)); chMemo.set(r.cust_code, ch); }
      add(channels[ch], amt, cg);
      const gname = codeGroup.get(r.cust_code);
      if (gname && wantGroups.has(gname)) { if (!groupAgg.has(gname)) groupAgg.set(gname, zero()); add(groupAgg.get(gname), amt, cg); }
      if (reason === 'lump') { gaps.lump += amt; continue; }
      if (reason) gaps[reason].set(r.sku, (gaps[reason].get(r.sku) || 0) + amt);
      let p = products.get(r.sku);
      if (!p) { p = { ...zero(), qc: 0, unit: null, source: null, from: [], suspect: false, estimated: false }; products.set(r.sku, p); }
      add(p, amt, cg);
      if (cg) {
        p.qc += q; p.unit = cost.unit; p.source = cost.source; p.from = cost.from;
        p.suspect = p.suspect || cost.suspect; p.estimated = p.estimated || cost.estimated;
        if (cost.estimated) gaps.est_covered += amt;
      }
    }

    const names = skuNames();
    const outProduct = (sku, p) => ({ sku, name: names.get(sku) || sku, lines: p.lines, covered: p.covered, cogs: p.cogs, qc: p.qc,
      unit: p.unit, source: p.source, from: p.from, suspect: p.suspect, estimated: p.estimated });
    const covered = [...products.entries()].filter(([, p]) => p.covered > 0);
    const flagSum = (f) => covered.filter(([, p]) => f(p)).reduce((a, [, p]) => ({ count: a.count + 1, amount: a.amount + p.covered }), { count: 0, amount: 0 });
    const gapList = (m) => {
      const list = [...m.entries()].filter(([, a]) => a > 0.005).sort((a, b) => b[1] - a[1]);
      return { count: list.length, amount: list.reduce((a, x) => a + x[1], 0), top: list.slice(0, 15).map(([sku, amount]) => ({ sku, name: names.get(sku) || sku, amount })) };
    };
    const up = db.prepare('SELECT rm_label, file_name, eff_date FROM sku_cost_round_uploads ORDER BY eff_date DESC, uploaded_at DESC LIMIT 1').get() || {};
    return {
      has_cost: true, first_date: effDates[0], last_date: effDates[effDates.length - 1], rm_label: up.rm_label || null,
      totals, monthly: monthlyAgg, channels,
      groups: Object.fromEntries(groupAgg),
      products: Object.fromEntries(wantSkus.filter((s) => products.has(s)).map((s) => [s, outProduct(s, products.get(s))])),
      // รายการควรตรวจราคา: อัตรากำไรจากทุนรวม < 10% (ทุนรวมสูงสุดใน 3 ฐาน จึงครอบทุกฐาน) เรียงจากกำไรน้อยสุด — หน้าจอกรองซ้ำตามฐานที่เลือก
      watch: covered.filter(([, p]) => p.covered - p.cogs.total < p.covered * 0.10)
        .sort((a, b) => (a[1].covered - a[1].cogs.total) - (b[1].covered - b[1].cogs.total)).slice(0, 40).map(([sku, p]) => outProduct(sku, p)),
      gaps: {
        lump: gaps.lump, no_cost: gapList(gaps.no_cost), unit: gapList(gaps.unit), est_covered: gaps.est_covered,
        converted: flagSum((p) => p.source === 'converted'), suspect: flagSum((p) => p.suspect),
      },
    };
  }

  // GET /api/dashboard/exec?from=YYYY-MM&to=YYYY-MM&slm=101,110-1&consi=1&makro_in_mall=0
  // แคชผลลัพธ์ /exec (2026-10-09, ผู้ใช้ขอให้ระบบเร็วขึ้น — วัดจริง 0.6–1.5 วิ/ครั้ง) — ดู lib/responseCache.js
  router.get('/exec', cacheJson(db));
  // คำนวณข้อมูลหน้า Dashboard ผู้บริหาร — แยกจาก route (2026-11-13) ให้รายงาน LINE รายสัปดาห์ (lib/weeklySalesReport.js)
  // ใช้ตัวเลขชุดเดียวกับหน้าเว็บ · opts.scopeAll = ข้ามการจำกัดสิทธิ์ (งานระบบ) · opts.allGroups = คืนทุกเครือลูกค้า (ไม่ใช่แค่ Top 20)
  const badReq = (msg) => Object.assign(new Error(msg), { status: 400 });
  // อ่านตัวกรอง + สิทธิ์ของคำขอ แล้วตั้งค่าตัวแปร req* ของ route (แยกจาก execPayload 2026-11-16 ให้ /margin ใช้ตัวกรองชุดเดียวกัน)
  function setupReq(query, user, opts = {}) {
    {
      const req = { query: query || {}, user };
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      const daily = YMD_RE.test(from) && YMD_RE.test(to);
      if (!daily && !(YM_RE.test(from) && YM_RE.test(to))) throw badReq('from/to ต้องเป็น YYYY-MM หรือ YYYY-MM-DD (ทั้งคู่แบบเดียวกัน)');
      if (daily && [from, to].some((x) => Number.isNaN(Date.parse(x + 'T00:00:00Z')) || new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) !== x)) throw badReq('วันที่ไม่ถูกต้อง');
      if (from.slice(0, 4) !== to.slice(0, 4) || from > to) throw badReq('from/to ต้องอยู่ในปีเดียวกัน และ from ≤ to');
      const year = Number(from.slice(0, 4));
      if (year < 2020 || year > 2100) throw badReq('ปีไม่ถูกต้อง');
      // ตัวกรอง Sales + สิทธิ์ (2026-10-06, lib/customerScope.js): slmCodes เป็น {sql, params} ที่ต่อท้าย WHERE ได้เลย
      //   · ไม่จำกัด: เลือก Sales มา = slm_code IN (…) · ไม่เลือก = ทั้งหมด
      //   · ถูกจำกัด: เลือก Sales มา = ตัดให้เหลือเฉพาะรหัสที่ดูได้ (ไม่เหลือ = ว่าง) · ไม่เลือก = รหัสที่ดูได้ + ลูกค้าเจ้า MT
      const scope = opts.scopeAll ? { all: true, restricted: false } : resolveScope(db, req.user);
      let wantSlm = [...new Set(String(req.query.slm || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 50);
      if (!scope.all && wantSlm.length) wantSlm = wantSlm.filter((c) => scope.slmCodes.includes(c));
      const slmCodes = req.query.slm && (scope.all || wantSlm.length || String(req.query.slm).trim())
        ? (wantSlm.length ? (() => { const x = slmListSql(wantSlm, { company: 'company' }); return { sql: `AND ${x.sql}`, params: x.params }; })() : { sql: 'AND 0', params: [] })
        // ใบไม่มีรหัส Sales ของแฟ้ม TSS = ของเซลล์เจ้าของลูกค้า (2026-10-20, code review — เดิม Dashboard ไม่นับ แต่ Sales Overview นับ ยอดไม่ตรงกัน)
        : scope.all ? { sql: '', params: [] } : (() => { const x = factSql(scope, { cust: 'cust_code', slm: 'slm_code', blankToOwner: true, company: 'company' }); return { sql: `AND ${x.sql}`, params: x.params }; })();
      const withConsi = req.query.consi !== '0';
      const makroInMall = req.query.makro_in_mall === '1';
      const co = String(req.query.co || 'all');
      if (!['all', 'tss', 'tgm'].includes(co)) throw badReq('co ต้องเป็น all, tss หรือ tgm');
      reqCo = co;
      const noNv = req.query.no_nv === '1';
      const noBakery = req.query.no_bakery === '1';
      reqNoNv = noNv;
      reqBakery = noBakery
        ? new Set(db.prepare(`SELECT code FROM customer_profiles WHERE category = 'เบเกอรี่' OR category LIKE '%/เบเกอรี่'`).all().map((r) => r.code))
        : null;
      if (noBakery) slmCodes.sql += ` AND ${BAKERY_SQL}`;
      {
        // ผู้ดูทีมห้างทั้งหมด (scope.allMt, 2026-10-22) เห็นยอดห้างระดับบริษัท — ไม่แทนยอด DC ด้วยยอดสาขาห้อง (ยกเว้นเลือก Sales เอง)
        const salesView = !!String(req.query.slm || '').trim() || (!scope.all && !scope.allMt);
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
      return { req, from, to, daily, year, slmCodes, withConsi, makroInMall, co, noNv, noBakery, lyFrom, lyTo };
    }
  }
  function execPayload(query, user, opts = {}) {
    {
      const { req, from, to, daily, year, slmCodes, withConsi, makroInMall, co, noNv, noBakery, lyFrom, lyTo } = setupReq(query, user, opts);

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
      // ยอด Shop แยกตาม Shop โรงงาน / Shop พระราม 3 (2026-11-17) — ไม่รวมในยอดขาย
      for (const [k, m] of [['ty', ty.shop], ['ly', ly.shop]]) {
        const by = { shop_factory: 0, shop_rama3: 0 };
        for (const [code, amt] of m) by[channelOf(meta, code, consiCodes.has(code)) === 'shop_rama3' ? 'shop_rama3' : 'shop_factory'] += amt;
        kpi[`${k}_shop`] = by.shop_factory + by.shop_rama3;
        kpi[`${k}_shop_factory`] = by.shop_factory;
        kpi[`${k}_shop_rama3`] = by.shop_rama3;
      }

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

      const topProd = topProducts(from, to, lyFrom, lyTo, slmCodes, withConsi);
      // กำไรขั้นต้น (2026-11-16) — เฉพาะผู้มีสิทธิ์เห็นทุน · คำนวณพลาดไม่ทำให้ทั้งหน้าล่ม (ส่ง error ให้หน้าจอแจ้งในแถบกำไร)
      let margin;
      if (skuCost.canSeeCost(req.user)) {
        try {
          const codeGroup = new Map(allGroups.flatMap((g) => g.codes.map((c) => [c, g.name])));
          const wantGroups = new Set([...top.all, ...top.mall, ...top.shop].map((g) => g.name));
          const wantSkus = [...new Set([...topProd.by_amount, ...topProd.by_kg].map((x) => x.sku))];
          margin = marginData(year, from, to, slmCodes, withConsi, meta, consiCodes, codeGroup, wantGroups, wantSkus);
        } catch (e) {
          console.error('[dashboardExec] margin failed:', e);
          margin = { has_cost: false, error: e.message };
        }
      }

      const freshness = db.prepare(`SELECT MAX(ym) AS last_ym FROM invoice_sales_monthly WHERE company IN ('TSS','CONSI')`).get();
      const lastDay = daily ? db.prepare(`SELECT MAX(d) AS d FROM invoice_sales_daily WHERE company IN ('TSS','CONSI')`).get() : null;
      const linesSync = db.prepare(`SELECT MAX(synced_at) AS at FROM sync_file_state WHERE source LIKE '%/STCRD.DBF'`).get();

      return {
        from, to, ly_from: lyFrom, ly_to: lyTo, with_consi: withConsi, makro_in_mall: makroInMall, co, no_nv: noNv, no_bakery: noBakery,
        monthly: { ty: monthly(year, slmCodes, meta, consiCodes), ly: monthly(year - 1, slmCodes, meta, consiCodes) },
        kpi,
        channels: EXEC_CHANNELS.map((c) => ({ key: c.key, label: c.label, ...channelAgg[c.key] })),
        top: { all: top.all.map(shape), mall: top.mall.map(shape), shop: top.shop.map(shape) },
        top_products: topProd,
        ...(margin ? { margin } : {}),
        top_excluded: offTop.map((g) => ({ name: g.name, channel: g.channel, ty: g.ty_net + (withConsi ? g.ty_consi : 0) }))
          .filter((x) => Math.abs(x.ty) > 0.5).sort((a, b) => b.ty - a.ty),
        last_ym: freshness?.last_ym || null,
        daily, last_d: lastDay?.d || null, tgm_daily_missing: reqBpDailyMissing,
        kg_synced_at: linesSync?.at || null,
        ...(opts.allGroups ? { groups: allGroups.map((g) => ({ name: g.name, channel: g.channel, codes: g.codes,
          ty_net: g.ty_net, ty_consi: g.ty_consi, ly_net: g.ly_net, ly_consi: g.ly_consi })) } : {}),
      };
    }
  }
  router.execPayload = execPayload;
  router.get('/exec', (req, res) => {
    try {
      res.json(execPayload(req.query, req.user));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[dashboardExec] /exec failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/dashboard/margin?from&to&slm&co&consi — กำไรขั้นต้นแบบเจาะลึก (2026-11-16) สำหรับ Sales Overview และหน้าวิเคราะห์กำไร
  // เฉพาะผู้มีสิทธิ์เห็นทุน (403) · ตัวกรอง/ขอบเขตลูกค้าชุดเดียวกับ /exec (setupReq) — สิทธิ์เห็นทุนไม่ขยายขอบเขตข้อมูล
  // คืนกำไรตาม ลูกค้า / สินค้า / เซลส์ / กลุ่มผลิตภัณฑ์ + คู่ลูกค้า×สินค้าที่ขายต่ำกว่าทุน + ทุนที่เปลี่ยนระหว่างสองรอบล่าสุด
  // ระดับใบกำกับไม่มีในตารางนี้ (sales_lines_daily รวมรายวันแล้ว) — รายการขายต่ำกว่าทุนจึงเป็นระดับ ลูกค้า × สินค้า ของช่วงที่เลือก
  function marginDetail(query, user) {
    const { from, to, year, slmCodes, withConsi } = setupReq(query, user);
    const ctx = skuCost.costContext(db);
    const effDates = [...new Set([...ctx.idx.values()].flatMap((l) => l.map((r) => r.eff_date)))].sort();
    if (!effDates.length) return { has_cost: false, from, to };
    const { src, raw } = companyFilter(year);
    const cos = withConsi ? raw : raw.filter((c) => src[c] !== 'CONSI');
    const lo = from.length === 10 ? from : `${from}-01`;
    const hi = to.length === 10 ? to : `${to}-31`;
    const skip = JSON.stringify([...reqNonSales.ic, ...reqNonSales.staff]);
    const rows = cos.length ? db.prepare(`SELECT cust_code, slm_code, sku, unit_code,
        (${effDates.map(() => '(d >= ?)').join(' + ')}) AS bk, MIN(d) AS d0,
        SUM(qty) AS qty, SUM(qty_base) AS qty_base, SUM(amount) AS amount
      FROM sales_lines_daily
      WHERE company IN (${inList(cos.length)}) AND d >= ? AND d <= ?
        AND cust_code NOT IN (SELECT value FROM json_each(?))
      ${slmCodes.sql}
      GROUP BY cust_code, slm_code, sku, unit_code, bk`).all(...effDates, ...cos, lo, hi, skip, ...slmCodes.params) : [];

    const zero = () => ({ lines: 0, covered: 0, cogs: { total: 0, depr: 0, base: 0 } });
    const add = (a, amt, cg) => {
      a.lines += amt;
      if (!cg) return;
      a.covered += amt;
      a.cogs.total += cg.total; a.cogs.depr += cg.depr; a.cogs.base += cg.base;
    };
    const bump = (map, key) => { let v = map.get(key); if (!v) { v = zero(); map.set(key, v); } return v; };
    // กลุ่มสินค้า = กลุ่ม Express 001–006 แบบเดียวกับหมวดสินค้าใน Sales Overview (2026-11-16, ผู้ใช้ขอ — เดิมใช้กลุ่มจากไฟล์ Master SKU)
    // รหัสกลุ่มนอก 001–006 → หาจากรหัส/ชื่อ (lib/productGroupMatch.js) · หาไม่ได้ = ไม่ใช่สินค้า (ค่าเช่า/เงินมัดจำ ฯลฯ) → ไม่นับในหน้านี้
    // กติกาเดียวกับ /api/invoice_detail/pivot (x = 1)
    const PG_RE = /^00[1-6]$/;
    const pgResolve = productGroupResolver(db).resolve;
    const pgOfProducts = new Map(db.prepare('SELECT code, group_name FROM products').all().map((r) => [r.code, r.group_name]));
    const groupMemo = new Map();
    const groupOf = { get: (sku) => {
      if (!groupMemo.has(sku)) {
        const g0 = String(pgOfProducts.get(sku) || '');
        let g = PG_RE.test(g0) ? g0 : null;
        if (!g) { const g2 = String(pgResolve(sku, skuNames().get(sku) || '', '') || ''); g = PG_RE.test(g2) ? g2 : null; }
        groupMemo.set(sku, g);
      }
      return groupMemo.get(sku);
    } };
    const NO_GROUP = 'ไม่ระบุกลุ่ม';
    const totals = zero();
    const byCust = new Map(), bySlm = new Map(), bySku = new Map(), byGroup = new Map(), pair = new Map();
    const skuCust = new Map(); // sku → Map(cust → {lines, covered, cogs, qc}) — "ขายใคร" ต่อสินค้า
    const skuInfo = new Map();
    const costMemo = new Map();
    let weights = null;
    for (const r of rows) {
      if (!r.sku) continue;
      if (r.sku !== TG_LUMP_SKU && !groupOf.get(r.sku)) continue; // ไม่ใช่สินค้า
      const amt = Number(r.amount) || 0;
      let cg = null, cost = null, q = null;
      if (r.sku !== TG_LUMP_SKU) {
        const ck = `${r.sku}|${r.bk}`;
        if (!costMemo.has(ck)) costMemo.set(ck, skuCost.resolveAll(ctx, r.sku, r.d0));
        cost = costMemo.get(ck);
        if (cost) {
          const line = { qty: r.qty, qty_base: r.qty_base, unit_code: r.unit_code, base_unit: ctx.baseUnits.get(r.sku) };
          q = skuCost.costQty(cost, line);
          if (q == null) {
            weights = weights || loadWeights();
            const kg = lineKg(r, weights);
            if (kg != null) q = skuCost.costQty(cost, { ...line, kg });
            if (!skuCost.kgPathOk(cost, q, r.amount)) q = null; // น้ำหนักผิดหน่วย — ดู lib/skuCost.js kgPathOk
            if (q == null) q = skuCost.packQty(cost, line); // แพ ↔ ซอง ↔ ถุง ↔ ถาด
          }
          if (q != null) cg = { total: cost.costs.total * q, depr: cost.costs.depr * q, base: cost.costs.base * q };
        }
      }
      add(totals, amt, cg);
      add(bump(byCust, r.cust_code), amt, cg);
      add(bump(bySlm, r.slm_code || ''), amt, cg);
      if (r.sku === TG_LUMP_SKU) continue;
      add(bump(bySku, r.sku), amt, cg);
      add(bump(byGroup, groupOf.get(r.sku) || NO_GROUP), amt, cg);
      let sc = skuCust.get(r.sku);
      if (!sc) { sc = new Map(); skuCust.set(r.sku, sc); }
      let scr = sc.get(r.cust_code);
      if (!scr) { scr = { ...zero(), qc: 0 }; sc.set(r.cust_code, scr); }
      add(scr, amt, cg); if (cg) scr.qc += q;
      let info = skuInfo.get(r.sku);
      if (!info) { info = { qc: 0, unit: null, source: null, from: [], suspect: false, estimated: false }; skuInfo.set(r.sku, info); }
      if (cg) {
        info.qc += q; info.unit = cost.unit; info.source = cost.source; info.from = cost.from;
        info.suspect = info.suspect || cost.suspect; info.estimated = info.estimated || cost.estimated;
        const pk = `${r.cust_code}\u0001${r.sku}\u0001${r.slm_code || ''}`;
        let p = pair.get(pk);
        if (!p) { p = { ...zero(), qc: 0 }; pair.set(pk, p); }
        add(p, amt, cg); p.qc += q;
      }
    }

    const names = skuNames();
    const meta = customerMeta();
    const custName = (c) => { const m = meta.get(c) || {}; return m.pname || m.name || c; };
    const slmName = new Map(db.prepare("SELECT slm_id, name FROM sc_users WHERE slm_id IS NOT NULL AND slm_id <> ''").all().map((r) => [r.slm_id, r.name]));
    const top = (map, n, shape) => [...map.entries()].filter(([, v]) => Math.abs(v.lines) > 0.005)
      .sort((a, b) => b[1].lines - a[1].lines).slice(0, n).map(([k, v]) => ({ ...shape(k), lines: v.lines, covered: v.covered, cogs: v.cogs }));
    const skuShape = (sku) => ({ sku, name: names.get(sku) || sku, group: groupOf.get(sku) || NO_GROUP, ...(skuInfo.get(sku) || {}) });
    // ทุนเปลี่ยนระหว่างสองรอบล่าสุดของรหัสที่มียอดขายในช่วงนี้ (มีทุนตั้งแต่ 2 รอบขึ้นไป)
    const changes = [];
    for (const [sku, v] of bySku) {
      const list = ctx.idx.get(sku);
      if (!list || list.length < 2 || !(v.covered > 0)) continue;
      const a = list[list.length - 2], b = list[list.length - 1];
      if (!(a.cost_total > 0) || a.cost_total === b.cost_total) continue;
      const info = skuInfo.get(sku) || {};
      changes.push({ sku, name: names.get(sku) || sku, unit: b.unit, prev: a.cost_total, cur: b.cost_total, prev_date: a.eff_date, cur_date: b.eff_date,
        avg_price: info.qc > 0 ? v.covered / info.qc : null, covered: v.covered });
    }
    return {
      has_cost: true, from, to, first_date: effDates[0], last_date: effDates[effDates.length - 1], rounds: effDates.length,
      totals,
      by_customer: top(byCust, 300, (c) => ({ code: c, name: custName(c) })),
      by_slm: top(bySlm, 200, (c) => ({ code: c, name: slmName.get(c) || '' })),
      by_sku: top(bySku, 600, skuShape),
      by_group: top(byGroup, 200, (g) => ({ name: g })),
      // ลูกค้าที่ซื้อแต่ละสินค้า (เฉพาะสินค้าใน by_sku · 30 รายแรกตามยอด) — แสดงเมื่อกดที่สินค้าในหน้าวิเคราะห์กำไร
      sku_custs: Object.fromEntries([...bySku.entries()].filter(([, v]) => Math.abs(v.lines) > 0.005)
        .sort((a, b) => b[1].lines - a[1].lines).slice(0, 600)
        .map(([sku]) => [sku, [...(skuCust.get(sku) || new Map()).entries()].sort((a, b) => b[1].lines - a[1].lines).slice(0, 30)
          .map(([c, v]) => ({ code: c, name: custName(c), lines: v.lines, covered: v.covered, cogs: v.cogs, qc: v.qc }))])),
      below_cost: [...pair.entries()].filter(([, p]) => p.covered - p.cogs.total < -0.005)
        .sort((a, b) => (a[1].covered - a[1].cogs.total) - (b[1].covered - b[1].cogs.total)).slice(0, 100)
        .map(([k, p]) => { const [cust, sku, slm] = k.split('\u0001'); return { cust, cust_name: custName(cust), sku, name: names.get(sku) || sku, slm, unit: (skuInfo.get(sku) || {}).unit, qc: p.qc, covered: p.covered, cogs: p.cogs }; }),
      cost_changes: changes.sort((a, b) => Math.abs(b.cur / b.prev - 1) * b.covered - Math.abs(a.cur / a.prev - 1) * a.covered).slice(0, 60),
    };
  }
  // แคช /margin (2026-11-23, ผู้ใช้แจ้งเมนูโหลดช้า): วัดบนสำเนา DB จริง 1.8–3.7 วิ/ครั้ง และระหว่างคำนวณ server ตอบคนอื่นไม่ได้
  // (SQLite แบบ sync บน thread เดียว) · ล้างแคชเมื่อข้อมูล sync/ทุนรอบใหม่เปลี่ยน — กติกาเดียวกับ /exec (lib/responseCache.js)
  router.get('/margin', cacheJson(db), (req, res) => {
    if (!skuCost.canSeeCost(req.user)) return res.status(403).json({ error: 'ไม่มีสิทธิ์เห็นทุนและกำไร' });
    try {
      res.json(marginDetail(req.query, req.user));
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      console.error('[dashboardExec] /margin failed:', e);
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
  // ใช้กลุ่มของสินค้า Express ที่ขึ้นต้นรหัสเดียวกัน (20394-xx) · รหัส 0000 = ยอดสรุปสินค้ารหัส TG ที่ Bplus ไม่แยกรายตัว (แตกจาก Express TGM ด้านล่าง)
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
      // บรรทัด 0000 (ใบสรุป Makro "A M" / Lotus EA) → แตกเป็นรายการสินค้าจริงของบิลชุดเดียวกันจาก Express TGM
      // (tgm_detail_lines_daily) ลูกค้า+เดือนเดียวกัน ปรับสัดส่วนให้รวมเท่ายอด Bplus เดิม (2026-10-22, ผู้ใช้ขอ: เห็นแต่สาขาไม่เห็นสินค้า)
      // ไม่มีรายการใน Express → คงเป็น "ไม่ระบุสินค้า (TG)" ตามเดิม
      const lumps = rows.filter((r) => r.sku === TG_LUMP_SKU);
      const detail = new Map(); // `${ym}|${cust}` → [{ sku, qty, amount, p_name, p_group }]
      if (lumps.length) {
        const custs = [...new Set(lumps.map((r) => r.cust_code))];
        const dRows = db.prepare(`SELECT substr(t.d, 1, 7) AS ym, t.cust_code, t.sku, SUM(t.qty) AS qty, SUM(t.amount) AS amount,
            p.name AS p_name, p.group_name AS p_group
          FROM tgm_detail_lines_daily t LEFT JOIN products p ON p.code = t.sku
          WHERE t.d >= ? AND t.d <= ? AND t.cust_code IN (SELECT value FROM json_each(?))
          GROUP BY substr(t.d, 1, 7), t.cust_code, t.sku`).all(`${from}-01`, `${to}-31`, JSON.stringify(custs));
        for (const d of dRows) {
          const k = `${d.ym}|${d.cust_code}`;
          if (!detail.has(k)) detail.set(k, []);
          detail.get(k).push(d);
        }
      }
      const { map: pre, byName } = productGroupByPrefix();
      const groupOf = (sku, pGroup, name) => pGroup || pre.get(String(sku).split('-')[0]) || byName(name) || '';
      const out = rows.flatMap((r) => {
        const amount = Number(r.amount) || 0;
        if (r.sku === TG_LUMP_SKU) {
          const lines = detail.get(`${r.ym}|${r.cust_code}`) || [];
          const total = lines.reduce((a, d) => a + (Number(d.amount) || 0), 0);
          if (Math.abs(total) < 0.005) {
            return [{ ym: r.ym, cust_code: r.cust_code, slm_code: r.slm_code, prod_code: r.sku, prod_name: r.s_name || r.p_name || r.sku,
              prod_group: 'ไม่ระบุสินค้า (TG)', qty: Number(r.qty) || 0, amount }];
          }
          const f = amount / total;
          return lines.map((d) => ({ ym: r.ym, cust_code: r.cust_code, slm_code: r.slm_code, prod_code: d.sku, prod_name: d.p_name || d.sku,
            prod_group: groupOf(d.sku, d.p_group, d.p_name), qty: Number(d.qty) || 0, amount: (Number(d.amount) || 0) * f }));
        }
        return [{ ym: r.ym, cust_code: r.cust_code, slm_code: r.slm_code, prod_code: r.sku, prod_name: r.s_name || r.p_name || r.sku,
          prod_group: groupOf(r.sku, r.p_group, r.s_name || r.p_name), qty: Number(r.qty) || 0, amount }];
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

module.exports.yearSources = yearSources;
