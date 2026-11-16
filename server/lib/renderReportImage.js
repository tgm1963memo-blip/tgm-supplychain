'use strict';

// วาดรายงานยอดขายรายสัปดาห์ (lib/weeklySalesReport.js) เป็นรูป PNG 4 รูปสำหรับส่ง LINE (2026-11-13)
// หน้าตาตามตาราง Excel เดิมของทีม (mockup ที่ผู้ใช้อนุมัติ) — HTML → PNG ด้วย Edge/Chrome ที่ติดตั้งในเครื่อง ผ่าน puppeteer-core
// (ไม่ดาวน์โหลด Chromium) · ตั้ง path เองได้ด้วย REPORT_BROWSER_PATH · ฟอนต์ไทยใช้ Leelawadee UI / Tahoma ที่มากับ Windows

const fs = require('fs');

// Chrome ก่อน (2026-11-16): Edge บนเครื่อง DB PC เปิดแบบ headless แล้วตัว launcher ออกทันที ทิ้ง process ลูกค้างไว้
// puppeteer จึงรายงาน "Failed to launch the browser process!" ทุกครั้ง (ทดสอบจริง) — Chrome เปิดได้ปกติ
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
function browserPath() {
  const p = process.env.REPORT_BROWSER_PATH || BROWSER_CANDIDATES.find((x) => fs.existsSync(x));
  if (!p) throw new Error('ไม่พบ Edge/Chrome สำหรับวาดรูปรายงาน — ตั้ง REPORT_BROWSER_PATH ใน .env');
  return p;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, dp) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const num = (v, dp = 0) => (Math.abs(v) < 0.005 ? '–' : v < 0 ? `<span class="neg">(${fmt(v, dp)})</span>` : fmt(v, dp));
const pct = (ly, ty) => {
  if (Math.abs(ly) < 0.005 && ty > 0) return '<span class="new">ใหม่</span>';
  if (ly <= 0) return '–';
  const p = (ty - ly) / ly * 100;
  return p < 0 ? `<span class="neg">(${Math.abs(p).toFixed(2)}%)</span>` : `${p.toFixed(2)}%`;
};
const share = (v, total) => (total > 0 ? `${(v / total * 100).toFixed(1)}%` : '–');
const visible = (r) => Math.abs(r.ly) >= 0.005 || Math.abs(r.ty) >= 0.005;

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #fff; }
.sheet { background: #fff; color: #111; font-family: "Leelawadee UI", "Leelawadee", Tahoma, sans-serif; width: 760px; padding: 20px 20px 14px; font-size: 15px; }
h2 { margin: 0 0 2px; font-size: 19px; font-weight: 700; }
.sub { margin: 0 0 10px; font-size: 14px; color: #555; }
h3 { margin: 16px 0 6px; font-size: 16px; font-weight: 700; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid #8a8a8a; padding: 5px 8px; }
th { background: #e2efda; font-weight: 700; text-align: center; font-size: 14px; }
td.n { text-align: right; white-space: nowrap; }
td.d { background: #fce4d6; }
th.d { background: #f8cbad; }
tr.tot td { background: #a9d08e; font-weight: 700; }
tr.tot td.d { background: #ffe699; }
tr.grp td { background: #f2f2f2; font-weight: 700; }
.neg { color: #c00000; }
.new { color: #1f5fbf; font-weight: 700; }
.small { font-size: 12px; color: #666; display: block; }
.foot { margin-top: 8px; font-size: 12px; color: #666; display: flex; justify-content: space-between; gap: 8px; }
`;

function sheets(rep) {
  const P = rep.ly_label, T = rep.label;
  const stamp = new Date(rep.generated_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  const foot = `<div class="foot"><span>ที่มา: ระบบ TSS Supply Chain (Express + Bplus)</span><span>สร้างเมื่อ ${esc(stamp)}</span></div>`;
  const diffCells = (r, dp = 0) => `<td class="n d">${num(r.ty - r.ly, dp)}</td><td class="n d">${pct(r.ly, r.ty)}</td>`;

  // 1) ช่องทาง
  const tot = rep.channels_total;
  const s1 = `<h2>สรุปยอดขาย ${esc(T)} ไม่รวมฝากขายสุทธิ</h2><p class="sub">เทียบ ${esc(P)}</p>
    <table><tr><th>ช่องทาง</th><th>${esc(P)}</th><th>สัดส่วน</th><th>${esc(T)}</th><th class="d">+/- บาท</th><th class="d">+/- %</th><th>สัดส่วน</th></tr>
    ${rep.channels.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${num(r.ly)}</td><td class="n">${share(r.ly, tot.ly)}</td><td class="n">${num(r.ty)}</td>${diffCells(r)}<td class="n">${share(r.ty, tot.ty)}</td></tr>`).join('')}
    <tr class="tot"><td>รวม</td><td class="n">${num(tot.ly)}</td><td class="n">100%</td><td class="n">${num(tot.ty)}</td>${diffCells(tot)}<td class="n">100%</td></tr></table>
    <h3>Shop และ Online</h3>
    <table><tr><th></th><th>${esc(P)}</th><th>${esc(T)}</th><th class="d">+/- บาท</th><th class="d">% เพิ่ม/ลด</th></tr>
    ${rep.shops.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${num(r.ly)}</td><td class="n">${num(r.ty)}</td>${diffCells(r)}</tr>`).join('')}</table>${foot}`;

  // 2) ห้างรายเจ้า
  const s2 = `<h2>ยอดขายห้างรายเจ้า (ไม่รวมฝากขาย)</h2><p class="sub">${esc(T)} เทียบ ${esc(P)}</p>
    ${rep.chains.map((sec) => `<h3>${esc(sec.title)}</h3>
      <table><tr><th style="width:38%">ห้าง</th><th>${esc(P)}</th><th>${esc(T)}</th><th class="d">+/- บาท</th><th class="d">% เพิ่ม/ลด</th></tr>
      ${sec.rows.filter(visible).map((r) => `<tr><td>${esc(r.label)}${r.detail ? `<span class="small">${esc(r.detail)}</span>` : ''}</td><td class="n">${num(r.ly)}</td><td class="n">${num(r.ty)}</td>${diffCells(r)}</tr>`).join('')}
      <tr class="tot"><td>รวม</td><td class="n">${num(sec.total.ly)}</td><td class="n">${num(sec.total.ty)}</td>${diffCells(sec.total)}</tr></table>`).join('')}${foot}`;

  // 3) ลูกค้ารับโอนจากออฟฟิศ
  const ot = rep.office_total;
  const s3 = `<h2>สรุปยอดขายสินค้าสุทธิ กลุ่มลูกค้ารับโอนจากออฟฟิศ</h2><p class="sub">โรงงาน TGM · ${esc(T)} เทียบ ${esc(P)}</p>
    <table><tr><th>#</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>${esc(P)}</th><th>${esc(T)}</th><th class="d">+/- บาท</th><th class="d">%</th></tr>
    ${rep.office.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${esc(r.code)}</td><td>${esc(r.label)}</td><td class="n">${num(r.ly, 2)}</td><td class="n">${num(r.ty, 2)}</td>${diffCells(r, 2)}</tr>`).join('')}
    <tr class="tot"><td colspan="3">รวมรายได้จากการขายสินค้าสุทธิ</td><td class="n">${num(ot.ly, 2)}</td><td class="n">${num(ot.ty, 2)}</td>${diffCells(ot, 2)}</tr></table>${foot}`;

  // 4) ลูกค้าโรงงานทั้งหมด
  const ft = rep.factory_total;
  const s4 = `<h2>สรุปยอดขายสินค้าแยกตามกลุ่มลูกค้า</h2><p class="sub">โรงงาน TGM · ${esc(T)} เทียบ ${esc(P)} · เรียงตามยอดที่เพิ่มขึ้น</p>
    <table><tr><th style="width:42%">ลูกค้า</th><th>${esc(P)}</th><th>${esc(T)}</th><th class="d">+/- บาท</th><th class="d">%</th></tr>
    ${rep.factory.map((sec) => `<tr class="grp"><td colspan="5">${esc(sec.title)} (${sec.rows.length} ราย)</td></tr>
      ${sec.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${num(r.ly, 2)}</td><td class="n">${num(r.ty, 2)}</td>${diffCells(r, 2)}</tr>`).join('')}`).join('')}
    <tr class="tot"><td>รวม</td><td class="n">${num(ft.ly, 2)}</td><td class="n">${num(ft.ty, 2)}</td>${diffCells(ft, 2)}</tr></table>${foot}`;

  return [s1, s2, s3, s4];
}

// หน้า HTML เดียวที่มีทั้ง 4 ตาราง (ใช้ดูตัวอย่างในเว็บ และเป็นต้นแบบตอนถ่ายรูป)
function reportHtml(rep) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>รายงานยอดขาย ${esc(rep.label)}</title><style>${CSS}
    body { background: #e9eef3; padding: 16px; } .sheet { margin: 0 auto 16px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }</style></head>
    <body>${sheets(rep).map((s) => `<div class="sheet">${s}</div>`).join('')}</body></html>`;
}

// เปิดเบราว์เซอร์สำหรับวาดรูป
// FIXED (2026-11-16, ผู้ใช้แจ้ง "ส่งไม่สำเร็จ: Failed to launch the browser process!" ตอนกดส่งทดสอบจากหน้าเว็บ):
// เซิร์ฟเวอร์จริงรันเป็น Windows service ใต้บัญชี LocalSystem (session 0) — Edge/Chrome ไม่มีโปรไฟล์ผู้ใช้ให้เขียน
// และ sandbox ของ Chromium เปิดไม่ได้ใต้ SYSTEM จึงเปิดไม่ขึ้น (รันจาก terminal ของผู้ใช้ไม่เจอ)
// → ชี้ userDataDir ไปโฟลเดอร์ temp ของ process เอง + --no-sandbox (วาดเฉพาะ HTML ที่ระบบสร้างเอง ไม่เปิดเว็บภายนอก)
// และลองทุกเบราว์เซอร์ที่มีในเครื่องตามลำดับ (Edge บางรุ่นไม่ยอมรันใต้ SYSTEM แต่ Chrome รันได้) · ข้อความ error บอกทุกตัวที่ลอง
async function launchBrowser() {
  const os = require('os');
  const path = require('path');
  const puppeteer = require('puppeteer-core');
  const list = process.env.REPORT_BROWSER_PATH ? [process.env.REPORT_BROWSER_PATH] : BROWSER_CANDIDATES.filter((x) => fs.existsSync(x));
  if (!list.length) browserPath(); // โยน error "ไม่พบ Edge/Chrome"
  const errors = [];
  for (const executablePath of list) {
    // โฟลเดอร์โปรไฟล์ใหม่ทุกครั้ง แยกต่อเบราว์เซอร์ — ใช้โฟลเดอร์เดียวร่วมกัน Edge/Chrome แล้วเปิดไม่ขึ้น ("Settings version is not 1")
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgm-report-'));
    const cleanup = () => { try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ลบไม่ได้ไม่เป็นไร */ } };
    try {
      const browser = await puppeteer.launch({
        executablePath, headless: true, userDataDir,
        args: ['--no-first-run', '--disable-gpu', '--no-sandbox', '--disable-extensions', '--no-default-browser-check'],
      });
      // ลบหลังปิด 3 วินาที — ตอน disconnected Chrome ยังล็อกไฟล์ในโปรไฟล์อยู่ ลบทันทีไม่ออก
      browser.once('disconnected', () => setTimeout(cleanup, 3000).unref());
      return browser;
    } catch (e) {
      cleanup();
      errors.push(`${path.basename(executablePath)}: ${String(e.message || e).split('\n').slice(0, 6).join(' | ').slice(0, 500)}`);
    }
  }
  throw new Error(`เปิดเบราว์เซอร์สำหรับวาดรูปรายงานไม่ได้ — ${errors.join(' ; ')}`);
}

// คืน Buffer PNG 4 รูป ตามลำดับตาราง
async function renderReportPngs(rep) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    const out = [];
    for (const s of sheets(rep)) {
      await page.setContent(`<!doctype html><html lang="th"><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="sheet">${s}</div></body></html>`, { waitUntil: 'load' });
      const el = await page.$('.sheet');
      out.push(Buffer.from(await el.screenshot({ type: 'png' })));
    }
    return out;
  } finally {
    await browser.close();
  }
}

module.exports = { reportHtml, renderReportPngs, launchBrowser };
