'use strict';

// สำรวจ Choco Backoffice (mybusiness.chococrm.com) ก่อนเขียนตัวดึงยอด Shop พระรามสาม / Online (2026-11-25, ผู้ใช้เลือก "login เข้าไปดึง")
// Choco ไม่มี API สาธารณะ — หน้าเว็บเป็น SPA เรียก https://crmpos-bo-api.azurewebsites.net/backoffice/v1.0/*
// (Account/Login ต้องมี ProviderRef/BrandRef ที่รู้ได้หลังล็อกอินจริง) จึงล็อกอินผ่านหน้าเว็บด้วย Chrome headless
// แล้วบันทึก request/response ของ API ทั้งหมด (ตัด token/รหัสผ่านออก) ไว้ดูโครงสร้างข้อมูล
//
// ใช้: ใส่ CHOCO_EMAIL / CHOCO_PASSWORD ใน server/.env แล้ว  node scripts/choco-discover.js [from YYYY-MM-DD] [to YYYY-MM-DD]
// ผลลัพธ์: <โฟลเดอร์ฐานข้อมูล>/choco-discover/*.json (นอก repo — มีข้อมูลลูกค้า/ยอดขายจริง ห้าม commit)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { DB_PATH } = require('../db/init');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const API = 'crmpos-bo-api.azurewebsites.net';
// ข้าง DB จริงของ service (นอก repo) · ถ้า DB_PATH ไม่ได้ตั้ง (ชี้เข้า repo) ใช้ C:TGM-Datasupplychain-db แทน — ไฟล์มีข้อมูลจริง ห้ามอยู่ใน OneDrive/repo
const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.env.CHOCO_DISCOVER_DIR || (path.resolve(DB_PATH).startsWith(REPO)
  ? 'C:\TGM-Data\supplychain-db\choco-discover' : path.join(path.dirname(DB_PATH), 'choco-discover'));
const SECRET_KEYS = /token|password|authorization|secret|username|email/i;

function scrub(v, depth = 0) {
  if (depth > 12 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '***' : scrub(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 300) return v.slice(0, 300) + '…';
  return v;
}

(async () => {
  const email = process.env.CHOCO_EMAIL, password = process.env.CHOCO_PASSWORD;
  if (!email || !password) throw new Error('ใส่ CHOCO_EMAIL และ CHOCO_PASSWORD ใน server/.env ก่อน');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.REPORT_BROWSER_PATH || BROWSERS.find((b) => fs.existsSync(b)),
    headless: true, args: ['--no-sandbox'],
  });
  const log = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('response', async (res) => {
      const url = res.url();
      if (!url.includes(API)) return;
      const req = res.request();
      let body = null, payload = null;
      try { body = await res.json(); } catch { /* ไม่ใช่ JSON */ }
      try { payload = req.postData() ? JSON.parse(req.postData()) : null; } catch { payload = req.postData(); }
      log.push({ method: req.method(), url: url.replace(/access_token=[^&]+/i, 'access_token=***'), status: res.status(), payload: scrub(payload), body: scrub(body) });
    });
    await page.goto('https://mybusiness.chococrm.com/authentication/login', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('input[placeholder="อีเมล"]', email, { delay: 20 });
    await page.type('input[type="password"]', password, { delay: 20 });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}), page.click('button[type="submit"]')]);
    await new Promise((r) => setTimeout(r, 5000));
    console.log('หลังล็อกอิน:', page.url());
    await page.screenshot({ path: path.join(OUT, '1-after-login.png') });
    // บางบัญชีต้องเลือกแบรนด์/สาขาก่อน — บันทึกข้อความบนหน้าไว้ดู
    fs.writeFileSync(path.join(OUT, '1-after-login.txt'), await page.evaluate(() => document.body.innerText));
    // เปิดหน้ารายการขาย/รายงาน (path ตามชื่อ chunk ใน bundle — ไม่ตรงก็ไม่เป็นไร จะเห็นใน log)
    for (const p of ['/order', '/order/list', '/report', '/dashboard']) {
      try {
        await page.goto('https://mybusiness.chococrm.com' + p, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise((r) => setTimeout(r, 4000));
        await page.screenshot({ path: path.join(OUT, `2${p.replace(/\//g, '_')}.png`) });
      } catch (e) { console.log('เปิด', p, 'ไม่ได้:', e.message); }
    }
  } finally {
    fs.writeFileSync(path.join(OUT, 'api-log.json'), JSON.stringify(log, null, 1));
    await browser.close();
  }
  console.log(`บันทึก ${log.length} API calls → ${OUT}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
