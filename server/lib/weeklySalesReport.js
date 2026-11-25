'use strict';

// รายงานยอดขายส่ง LINE ทุกวันจันทร์ ยอดรวมบิลลงวันจันทร์นั้น (2026-11-13, ผู้ใช้ขอ — แทนตาราง Excel ที่ทำด้วยมือ)
// 4 ตาราง เทียบช่วงเดียวกันของปีก่อน:
//   1) ยอดตามช่องทาง (ร้านค้า / เอเย่น / ห้าง / แม็คโคร) + ตารางย่อย Shop / Online
//   2) ยอดห้างรายเจ้า แบ่ง 3 กลุ่ม (กลุ่มคุณแต้ว ฯลฯ)
//   3) ลูกค้าโรงงานที่รับโอนจากออฟฟิศ (NSL, OIS ฯลฯ)
//   4) ลูกค้าโรงงาน (Bplus BP-TGM) ทุกราย แยกกลุ่ม
// ตัวเลขช่องทาง/ห้างใช้ชุดเดียวกับ Dashboard ผู้บริหาร (routes/dashboardExec.js execPayload) — ไม่คำนวณซ้ำ
// การจัดกลุ่มแก้ได้ที่ db/data/weekly-report-groups.json

const fs = require('fs');
const path = require('path');
const execCh = require('./execChannel');
const nonSales = require('./nonSales');
const { groupNameOf } = require('./customerGroup');
const dashboardExec = require('../routes/dashboardExec');

const CONFIG_PATH = path.join(__dirname, '..', 'db', 'data', 'weekly-report-groups.json');
const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
// รหัสลูกค้า → "กลุ่มลูกค้า" จากมาสเตอร์ไฟล์ของฝ่ายขาย (สร้างด้วย scripts/build-weekly-master-groups.js) · ไม่มีไฟล์ = ว่าง
const MASTER_PATH = path.join(__dirname, '..', 'db', 'data', 'weekly-report-master-groups.json');
function loadMasterGroups() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8')).groups || {})); } catch { return new Map(); }
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftYear = (s) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;

// ช่วงของรายงานที่ส่งวัน `today` (ตามเวลาเครื่อง): วันที่ 1 ของเดือน → วันจันทร์ล่าสุด "รวมวันนี้"
// (2026-11-25, ผู้ใช้ขอ: ส่งสรุปวันจันทร์ ให้ดึงบิลที่เปิดลงวันที่วันจันทร์นั้นด้วย — บิลเปิดล่วงหน้าไว้แล้ว · เดิมตัดถึงวันอาทิตย์)
// ส่งทุกวันจันทร์เช้า → ช่วงจบที่วันนั้นเอง · เรียกวันอื่น (ดูตัวอย่าง/ส่งทดสอบ) = จบที่วันจันทร์ที่ผ่านมา
// ถ้าสัปดาห์ (อังคาร–จันทร์) เริ่มในเดือนก่อน = ส่งยอดเต็มเดือนก่อน (เช่น จันทร์ 2 พ.ย. 2569 → 1–31 ต.ค.,
// จันทร์ 30 พ.ย. 2569 → 1–30 พ.ย.)
function reportRange(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const back = (d.getDay() + 6) % 7; // วันจันทร์ล่าสุด (วันนี้เป็นจันทร์ = วันนี้)
  const end = new Date(d); end.setDate(d.getDate() - back);
  const start = new Date(end); start.setDate(end.getDate() - 6);
  if (start.getMonth() !== end.getMonth()) {
    const last = new Date(end.getFullYear(), end.getMonth(), 0); // วันสุดท้ายของเดือนก่อน
    return { from: ymd(new Date(last.getFullYear(), last.getMonth(), 1)), to: ymd(last) };
  }
  return { from: ymd(new Date(end.getFullYear(), end.getMonth(), 1)), to: ymd(end) };
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
// "1–31 ต.ค. 2569"
function thaiRange(from, to) {
  const be = Number(to.slice(0, 4)) + 543;
  return `${Number(from.slice(8))}–${Number(to.slice(8))} ${TH_MONTHS[Number(to.slice(5, 7)) - 1]} ${be}`;
}

const row = (label, ly, ty, extra = {}) => ({ label, ly, ty, ...extra });

function buildWeeklyReport(db, { from, to }) {
  const cfg = loadConfig();
  // ไม่รวม TSS-NV ทั้งรายงาน (2026-11-25) — Excel ฝ่ายขาย 1–23 พ.ย. 2568: ห้าง 26,685,271 / แม็คโคร 26,757,493 = ยอดระบบหัก TSS-NV พอดี
  const exec = dashboardExec(db).execPayload({ from, to, no_nv: '1' }, null, { scopeAll: true, allGroups: true });
  const lyFrom = shiftYear(from), lyTo = shiftYear(to);

  const meta = execCh.customerMeta(db);
  const consiCodes = new Set(db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE company = 'CONSI'`).all().map((r) => r.cust_code));
  const chCache = new Map();
  const chOf = (code) => {
    if (!chCache.has(code)) chCache.set(code, execCh.channelOf(meta, code, consiCodes.has(code)));
    return chCache.get(code);
  };
  const skip = nonSales.nonSalesCodes(db);

  // ---- 1) ช่องทาง ----
  // ห้าง / แม็คโคร (แถวที่มี keys อย่างเดียว) = ยอดหมวดของ Dashboard ผู้บริหาร ไม่รวม TSS-NV — ตรง Excel พอดี
  // ร้านค้า / เอเย่น (แถวที่มี master) = กติกา Excel ฝ่ายขาย (2026-11-25, ผู้ใช้สั่ง "แก้ตามกติกา Excel ทั้งหมด"):
  //   · ลูกค้า Express (TSS + TSS-NV) จัดตาม "กลุ่มลูกค้า" ในมาสเตอร์ไฟล์ (loadMasterGroups) — รวม TSS-NV และรหัส Shop ที่มาสเตอร์
  //     จัดเป็นร้านค้าทั่วไป/เอเย่น (เช่น 30-IA-0003 Shop ตู้ทอด = เอเย่น, TG-LG-0001 = ร้านค้าทั่วไป)
  //   · ลูกค้าที่ไม่อยู่ในมาสเตอร์ และลูกค้าโรงงาน (BP-TGM) จัดตามหมวดของระบบ (keys) — Shop โรงงาน (BP-POS) นับในร้านค้า
  //   เทียบ 1–23 พ.ย. 2568: ร้านค้า 66,152,359 (Excel 66,241,089) · เอเย่น 17,232,596 (Excel 17,267,996)
  const chMap = new Map(exec.channels.map((c) => [c.key, c]));
  const master = loadMasterGroups();
  const masterCh = cfg.channels.filter((c) => c.master);
  function masterTotals(lo, hi) {
    const src = dashboardExec.yearSources(Number(lo.slice(0, 4)));
    const cos = Object.keys(src).filter((c) => src[c] !== 'CONSI');
    const out = new Map(masterCh.map((c) => [c, 0]));
    for (const r of db.prepare(`SELECT company, cust_code, SUM(amount) AS a FROM invoice_sales_daily
      WHERE company IN (SELECT value FROM json_each(?)) AND d >= ? AND d <= ? GROUP BY company, cust_code`).all(JSON.stringify(cos), lo, hi)) {
      let c;
      if (src[r.company] !== 'TGM' && master.has(r.cust_code)) {
        const g = master.get(r.cust_code);
        c = masterCh.find((x) => x.master.includes(g));
      } else {
        const ch = chOf(r.cust_code);
        if (skip.has(r.cust_code) && ch !== 'shop_factory') continue;
        c = masterCh.find((x) => x.keys.includes(ch));
      }
      if (c) out.set(c, out.get(c) + (Number(r.a) || 0));
    }
    return out;
  }
  const mTy = masterCh.length ? masterTotals(from, to) : new Map(), mLy = masterCh.length ? masterTotals(lyFrom, lyTo) : new Map();
  const channels = cfg.channels.map((c) => (c.master
    ? row(c.label, mLy.get(c) || 0, mTy.get(c) || 0)
    : row(c.label,
      c.keys.reduce((a, k) => a + (chMap.get(k)?.ly_net || 0), 0),
      c.keys.reduce((a, k) => a + (chMap.get(k)?.ty_net || 0), 0))));

  // Shop ของบริษัทถูกตัดออกจากยอดขาย (lib/nonSales.js) จึงรวมยอดเองจากใบกำกับรายวัน — ไม่รวมฝากขาย
  const shopKeys = new Set(cfg.shops.map((s) => s.channel));
  function shopTotals(lo, hi) {
    const src = dashboardExec.yearSources(Number(lo.slice(0, 4)));
    // ไม่รวม TSS-NV — Excel Shop โรงงาน 1–23 พ.ย. 2568 = 1,477,465 = ยอด Bplus อย่างเดียว (2026-11-25)
    const cos = Object.keys(src).filter((c) => src[c] !== 'CONSI' && src[c] !== 'TSSNV');
    const out = {};
    for (const r of db.prepare(`SELECT cust_code, SUM(amount) AS a FROM invoice_sales_daily
      WHERE company IN (SELECT value FROM json_each(?)) AND d >= ? AND d <= ? GROUP BY cust_code`).all(JSON.stringify(cos), lo, hi)) {
      const ch = chOf(r.cust_code);
      if (shopKeys.has(ch)) out[ch] = (out[ch] || 0) + (Number(r.a) || 0);
    }
    return out;
  }
  const shTy = shopTotals(from, to), shLy = shopTotals(lyFrom, lyTo);
  // choco = Excel ใช้ยอดจาก Choco POS (หน้าร้านพระราม 3 / Online) — ยังไม่ได้เชื่อม (2026-11-25) จึงแสดงยอดใบกำกับในระบบพร้อมหมายเหตุ
  const shops = cfg.shops.map((s) => row(s.label, shLy[s.channel] || 0, shTy[s.channel] || 0, s.choco ? { note: 'ยอดในระบบ — รอเชื่อม Choco POS' } : {}));

  // ---- 2) ห้างรายเจ้า (ยอดไม่รวมฝากขาย) ----
  // ไม่รวมเบเกอรี่ (Tops/เบเกอรี่, เดอะมอลล์/เบเกอรี่ …) และ TSS-NV — ตรงกับ Excel ฝ่ายขาย (เทียบ 1–23 พ.ย. 2569, 2026-11-25:
  // แม็คโคร/บิ๊กซี/Tops/เดอะมอลล์/โลตัส/อิออน/วิลล่า/ลอว์สัน/ตันตราภัณฑ์ ตรงทุกเจ้าเมื่อตัดสองส่วนนี้) · ตาราง 1 ยังรวมเบเกอรี่
  const execChain = dashboardExec(db).execPayload({ from, to, no_nv: '1', no_bakery: '1' }, null, { scopeAll: true, allGroups: true });
  const mallGroups = (execChain.groups || []).filter((g) => g.channel === 'mall' || g.channel === 'makro');
  const used = new Set();
  const norm = (s) => String(s || '').toLowerCase();
  const chainSections = cfg.chain_groups.map((sec) => {
    const rows = sec.chains.map((c) => {
      const hits = mallGroups.filter((g) => !used.has(g) && c.match.some((m) => norm(g.name).includes(norm(m))));
      hits.forEach((g) => used.add(g));
      // note = หมายเหตุสีแดงหน้าชื่อห้างแบบ Excel (เช่น "รอยอดฝากขายบางส่วน") · แสดงทุกเจ้าในรายการแม้ยอดเป็น 0 (Excel แสดงครบ)
      return row(c.label, hits.reduce((a, g) => a + g.ly_net, 0), hits.reduce((a, g) => a + g.ty_net, 0), { note: c.note || '', always: true });
    });
    return { title: sec.title, rest: !!sec.rest, rows };
  });
  // เครือห้างที่ไม่อยู่ในรายการ → แถว "อื่น ๆ" ของกลุ่มที่ตั้ง rest ไว้ (ยอดรวมทุกกลุ่มจึงครบเท่ายอดห้าง + แม็คโคร)
  const restSec = chainSections.find((s) => s.rest);
  const others = mallGroups.filter((g) => !used.has(g) && (Math.abs(g.ly_net) > 0.5 || Math.abs(g.ty_net) > 0.5));
  if (restSec && others.length) {
    restSec.rows.push(row(`อื่น ๆ (${others.length} เจ้า)`, others.reduce((a, g) => a + g.ly_net, 0), others.reduce((a, g) => a + g.ty_net, 0),
      { detail: others.map((g) => g.name).slice(0, 8).join(', ') }));
  }

  // ---- 3) + 4) ลูกค้าโรงงาน (Bplus) ----
  const names = new Map(db.prepare('SELECT code, name FROM bplus_customers').all().map((r) => [r.code, String(r.name || '').replace(/\s+/g, ' ').trim()]));
  const bp = (lo, hi) => new Map(db.prepare(`SELECT cust_code, SUM(amount) AS a FROM invoice_sales_daily
    WHERE company = 'BP-TGM' AND d >= ? AND d <= ? GROUP BY cust_code`).all(lo, hi).map((r) => [r.cust_code, Number(r.a) || 0]));
  const bpTy = bp(from, to), bpLy = bp(lyFrom, lyTo);
  const office = cfg.office_customers.map((code) => row(names.get(code) || code, bpLy.get(code) || 0, bpTy.get(code) || 0, { code }));

  // ห้าง/Makro ไม่อยู่ตารางนี้ (อยู่ตาราง 2 แล้ว และ Bplus ลงยอดห้างเป็นบิลสรุปสิ้นเดือน — ช่วงกลางเดือนยอดจะดูหายทั้งก้อน)
  const FACTORY_GROUP = { local_agent: 'เอเย่น', export_agent: 'เอเย่น', online: 'Online' };
  const FACTORY_SKIP = new Set(['mall', 'makro']);
  // รวมแถวตามชื่อเครือ (กติกาเดียวกับ Top 20) — คนเดียวกันหลายรหัส / สาขา Makro (ซีพี แอ็กซ์ตร้า) เป็นแถวเดียว
  const byGroup = new Map();
  for (const code of new Set([...bpTy.keys(), ...bpLy.keys()])) {
    if (skip.has(code) || FACTORY_SKIP.has(chOf(code))) continue;
    const ly = bpLy.get(code) || 0, ty = bpTy.get(code) || 0;
    if (Math.abs(ly) < 0.005 && Math.abs(ty) < 0.005) continue;
    const g = FACTORY_GROUP[chOf(code)] || 'ร้านค้า';
    const m = meta.get(code) || {};
    const name = groupNameOf({ corporate: m.corporate, name: names.get(code) || m.pname || m.name, code });
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const rows = byGroup.get(g);
    const cur = rows.get(name) || row(name, 0, 0, { codes: [] });
    cur.ly += ly; cur.ty += ty; cur.codes.push(code);
    rows.set(name, cur);
  }
  const ORDER = ['เอเย่น', 'ร้านค้า', 'Online'];
  const factory = [...byGroup.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))
    .map(([title, rows]) => ({ title, rows: [...rows.values()].sort((a, b) => (b.ty - b.ly) - (a.ty - a.ly)) }));
  // แบบ Excel (2026-11-25): ทุกรายรวมเป็นตารางเดียว เรียงตามยอดที่เพิ่มขึ้น มีคอลัมน์ชื่อกลุ่มลูกค้า
  const factoryRows = factory.flatMap((sec) => sec.rows.map((r) => ({ ...r, group: sec.title }))).sort((a, b) => (b.ty - b.ly) - (a.ty - a.ly));

  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    from, to, ly_from: lyFrom, ly_to: lyTo,
    label: thaiRange(from, to), ly_label: thaiRange(lyFrom, lyTo),
    last_d: exec.last_d,
    channels, channels_total: row('รวม', sum(channels, 'ly'), sum(channels, 'ty')),
    shops,
    chains: chainSections.map((s) => ({ title: s.title, rows: s.rows, total: row('รวม', sum(s.rows, 'ly'), sum(s.rows, 'ty')) })),
    office, office_total: row('รวม', sum(office, 'ly'), sum(office, 'ty')),
    factory, factory_rows: factoryRows, factory_total: row('รวม', factory.reduce((a, s) => a + sum(s.rows, 'ly'), 0), factory.reduce((a, s) => a + sum(s.rows, 'ty'), 0)),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { buildWeeklyReport, reportRange, thaiRange, loadConfig };
