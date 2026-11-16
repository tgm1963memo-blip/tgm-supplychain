'use strict';

// รายงานยอดขายส่ง LINE ทุกวันจันทร์ (2026-11-13, ผู้ใช้ขอ — แทนตาราง Excel ที่ทำด้วยมือ)
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

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftYear = (s) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;

// ช่วงของรายงานที่ส่งวัน `today` (ตามเวลาเครื่อง): วันที่ 1 ของเดือน → วันอาทิตย์ล่าสุดก่อน today
// ถ้าสัปดาห์ที่แล้ว (จันทร์–อาทิตย์) เริ่มในเดือนก่อน = ส่งยอดเต็มเดือนก่อน (เช่น จันทร์ 3 พ.ย. → 1–31 ต.ค.)
function reportRange(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const back = d.getDay() === 0 ? 7 : d.getDay(); // วันอาทิตย์ล่าสุดก่อนวันนี้
  const sun = new Date(d); sun.setDate(d.getDate() - back);
  const mon = new Date(sun); mon.setDate(sun.getDate() - 6);
  if (mon.getMonth() !== sun.getMonth()) {
    const end = new Date(sun.getFullYear(), sun.getMonth(), 0); // วันสุดท้ายของเดือนก่อน
    return { from: ymd(new Date(end.getFullYear(), end.getMonth(), 1)), to: ymd(end) };
  }
  return { from: ymd(new Date(sun.getFullYear(), sun.getMonth(), 1)), to: ymd(sun) };
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
  const exec = dashboardExec(db).execPayload({ from, to }, null, { scopeAll: true, allGroups: true });
  const lyFrom = shiftYear(from), lyTo = shiftYear(to);

  // ---- 1) ช่องทาง ----
  const chMap = new Map(exec.channels.map((c) => [c.key, c]));
  const channels = cfg.channels.map((c) => row(c.label,
    c.keys.reduce((a, k) => a + (chMap.get(k)?.ly_net || 0), 0),
    c.keys.reduce((a, k) => a + (chMap.get(k)?.ty_net || 0), 0)));

  // Shop ของบริษัทถูกตัดออกจากยอดขาย (lib/nonSales.js) จึงรวมยอดเองจากใบกำกับรายวัน — ไม่รวมฝากขาย
  const meta = execCh.customerMeta(db);
  const consiCodes = new Set(db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE company = 'CONSI'`).all().map((r) => r.cust_code));
  const chCache = new Map();
  const chOf = (code) => {
    if (!chCache.has(code)) chCache.set(code, execCh.channelOf(meta, code, consiCodes.has(code)));
    return chCache.get(code);
  };
  const shopKeys = new Set(cfg.shops.map((s) => s.channel));
  function shopTotals(lo, hi) {
    const src = dashboardExec.yearSources(Number(lo.slice(0, 4)));
    const cos = Object.keys(src).filter((c) => src[c] !== 'CONSI');
    const out = {};
    for (const r of db.prepare(`SELECT cust_code, SUM(amount) AS a FROM invoice_sales_daily
      WHERE company IN (SELECT value FROM json_each(?)) AND d >= ? AND d <= ? GROUP BY cust_code`).all(JSON.stringify(cos), lo, hi)) {
      const ch = chOf(r.cust_code);
      if (shopKeys.has(ch)) out[ch] = (out[ch] || 0) + (Number(r.a) || 0);
    }
    return out;
  }
  const shTy = shopTotals(from, to), shLy = shopTotals(lyFrom, lyTo);
  const shops = cfg.shops.map((s) => row(s.label, shLy[s.channel] || 0, shTy[s.channel] || 0));

  // ---- 2) ห้างรายเจ้า (ยอดไม่รวมฝากขาย) ----
  const mallGroups = (exec.groups || []).filter((g) => g.channel === 'mall' || g.channel === 'makro');
  const used = new Set();
  const norm = (s) => String(s || '').toLowerCase();
  const chainSections = cfg.chain_groups.map((sec) => {
    const rows = sec.chains.map((c) => {
      const hits = mallGroups.filter((g) => !used.has(g) && c.match.some((m) => norm(g.name).includes(norm(m))));
      hits.forEach((g) => used.add(g));
      return row(c.label, hits.reduce((a, g) => a + g.ly_net, 0), hits.reduce((a, g) => a + g.ty_net, 0));
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
  const skip = nonSales.nonSalesCodes(db);
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

  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    from, to, ly_from: lyFrom, ly_to: lyTo,
    label: thaiRange(from, to), ly_label: thaiRange(lyFrom, lyTo),
    last_d: exec.last_d,
    channels, channels_total: row('รวม', sum(channels, 'ly'), sum(channels, 'ty')),
    shops,
    chains: chainSections.map((s) => ({ title: s.title, rows: s.rows, total: row('รวม', sum(s.rows, 'ly'), sum(s.rows, 'ty')) })),
    office, office_total: row('รวม', sum(office, 'ly'), sum(office, 'ty')),
    factory, factory_total: row('รวม', factory.reduce((a, s) => a + sum(s.rows, 'ly'), 0), factory.reduce((a, s) => a + sum(s.rows, 'ty'), 0)),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { buildWeeklyReport, reportRange, thaiRange, loadConfig };
