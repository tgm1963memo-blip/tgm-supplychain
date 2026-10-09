'use strict';

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { requireRole } = require('../middleware/auth');
const { EXEC_CHANNELS, EXEC_CHANNEL_KEYS, guessExecChannel } = require('../lib/execChannel');
const { groupNameOf } = require('../lib/customerGroup');
const { resolveScope, factSql } = require('../lib/customerScope');
const chainSales = require('../lib/chainSales');
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
  function companyFilter(year) {
    const all = yearSources(year);
    const keep = CO_GROUPS[reqCo];
    const src = keep ? Object.fromEntries(Object.entries(all).filter(([, canon]) => keep.has(canon))) : all;
    return { src, raw: Object.keys(src) };
  }

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
      .filter((r) => reqChain.slms.has(r.slm_code) && (!keep || keep.has(r.company)));
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
      const rows = parts(from, to, raw).flatMap((p) => db.prepare(`SELECT company, cust_code, sku, unit_code, SUM(qty) AS qty, SUM(qty_base) AS qty_base, SUM(amount) AS amount
        FROM ${p.t.lines}
        WHERE company IN (${inList(p.cos.length)}) AND ${p.t.col} >= ? AND ${p.t.col} <= ? AND cust_code IN (${inList(part.length)})
        ${slmCodes.sql}
        GROUP BY company, cust_code, sku, unit_code`).all(...p.cos, p.lo, p.hi, ...part, ...slmCodes.params));
      for (const r of rows) {
        const cur = out.get(r.cust_code) || { net: 0, consi: 0, amt: 0, amtKg: 0 };
        let kg = null;
        if (KG_UNIT_RE.test(r.unit_code || '')) kg = Number(r.qty) || 0;
        else if (weights.has(r.sku)) kg = (Number(r.qty_base) || 0) * weights.get(r.sku);
        const amt = Math.abs(Number(r.amount) || 0);
        cur.amt += amt;
        if (kg != null) {
          cur.amtKg += amt;
          if (src[r.company] === 'CONSI') cur.consi += kg; else cur.net += kg;
        }
        out.set(r.cust_code, cur);
      }
    }
    return out;
  }

  // GET /api/dashboard/exec?from=YYYY-MM&to=YYYY-MM&slm=101,110-1&consi=1&makro_in_mall=0
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
        from, to, ly_from: lyFrom, ly_to: lyTo, with_consi: withConsi, makro_in_mall: makroInMall, co,
        monthly: { ty: monthly(year, slmCodes, meta, consiCodes), ly: monthly(year - 1, slmCodes, meta, consiCodes) },
        kpi,
        channels: EXEC_CHANNELS.map((c) => ({ key: c.key, label: c.label, ...channelAgg[c.key] })),
        top: { all: top.all.map(shape), mall: top.mall.map(shape), shop: top.shop.map(shape) },
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
  let prefixCache = { at: 0, map: null };
  function productGroupByPrefix() {
    if (prefixCache.map && Date.now() - prefixCache.at < 10 * 60 * 1000) return prefixCache.map;
    const counts = new Map();
    for (const p of db.prepare("SELECT code, group_name FROM products WHERE group_name IS NOT NULL AND group_name <> ''").all()) {
      const pre = String(p.code).split('-')[0];
      const m = counts.get(pre) || new Map();
      m.set(p.group_name, (m.get(p.group_name) || 0) + 1);
      counts.set(pre, m);
    }
    const map = new Map([...counts].map(([pre, m]) => [pre, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
    prefixCache = { at: Date.now(), map };
    return map;
  }
  router.get('/bplus/sales_lines', (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!YM_RE.test(from) || !YM_RE.test(to) || from > to) return res.status(400).json({ error: 'from/to ต้องเป็น YYYY-MM และ from ≤ to' });
      const rows = db.prepare(`SELECT l.ym, l.cust_code, l.slm_code, l.sku, SUM(l.qty) AS qty, SUM(l.amount) AS amount,
          p.name AS p_name, p.group_name AS p_group, s.name AS s_name
        FROM sales_lines_monthly l LEFT JOIN products p ON p.code = l.sku LEFT JOIN bplus_skus s ON s.code = l.sku
        WHERE l.company = 'BP-TGM' AND l.ym >= ? AND l.ym <= ?
        GROUP BY l.ym, l.cust_code, l.slm_code, l.sku`).all(from, to);
      const pre = productGroupByPrefix();
      const out = rows.map((r) => {
        const group = r.sku === '0000' ? 'ไม่ระบุสินค้า (TG)' : (r.p_group || pre.get(String(r.sku).split('-')[0]) || '');
        return { ym: r.ym, cust_code: r.cust_code, slm_code: r.slm_code, prod_code: r.sku, prod_name: r.s_name || r.p_name || r.sku,
          prod_group: group, qty: Number(r.qty) || 0, amount: Number(r.amount) || 0 };
      });
      const customers = Object.fromEntries(db.prepare('SELECT code, name FROM bplus_customers').all().map((r) => [r.code, r.name]));
      const salesmen = Object.fromEntries(db.prepare('SELECT bp_code, bp_name FROM bplus_salesman_map').all().map((r) => [`BP-${r.bp_code}`, r.bp_name]));
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
