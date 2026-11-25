'use strict';

// ส่งรายงานยอดขายรายสัปดาห์เข้ากลุ่ม LINE (2026-11-13, ผู้ใช้ขอ — ทุกวันจันทร์ ยอดรวมบิลลงวันจันทร์นั้น ตั้งแต่ 2026-11-25)
// ลำดับ: สร้างข้อมูล (lib/weeklySalesReport.js) → วาดรูป 4 รูป (lib/renderReportImage.js) → เก็บรูปไว้ให้ LINE ดึงทาง
// GET /public/line-reports/<token>/<n>.png → push ข้อความสรุป + รูป 4 รูป (รวม 5 ข้อความ = เพดานต่อครั้งของ LINE)
// เข้าทุกกลุ่มที่ line_targets.active = 1 · บันทึกผลใน line_report_runs

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB_PATH } = require('../db/init');
const { buildWeeklyReport } = require('./weeklySalesReport');
const { applyChocoToReport } = require('./chocoPos');
const { renderReportPngs } = require('./renderReportImage');
const line = require('./lineMessaging');
const { publicBaseUrl } = require('./publicUrl');

// เก็บรูปไว้นอก repo (ข้างไฟล์ฐานข้อมูล) — โฟลเดอร์ repo อยู่ใน OneDrive · ลบรูปที่เก่ากว่า 120 วัน
const IMAGE_DIR = process.env.LINE_REPORT_IMAGE_DIR || path.join(path.dirname(DB_PATH), 'line-reports');
const KEEP_DAYS = 120;
const TOKEN_RE = /^[a-f0-9]{32}$/;

function imagePath(token, n) {
  if (!TOKEN_RE.test(String(token)) || !/^[1-4]$/.test(String(n))) return null;
  return path.join(IMAGE_DIR, `${token}-${n}.png`);
}

function cleanupOldImages() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(IMAGE_DIR)) {
      const p = path.join(IMAGE_DIR, f);
      if (/\.png$/.test(f) && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* ยังไม่มีโฟลเดอร์ */ }
}

const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pctText = (ly, ty) => (ly > 0 ? `${ty >= ly ? '+' : '−'}${Math.abs((ty - ly) / ly * 100).toFixed(2)}%` : 'ใหม่');

function summaryText(rep) {
  const t = rep.channels_total;
  const d = t.ty - t.ly;
  const lines = [
    `📊 สรุปยอดขาย ${rep.label}`,
    `เทียบ ${rep.ly_label} (ไม่รวมฝากขาย)`,
    `${fmt(t.ty)} บาท`,
    `${d >= 0 ? '▲' : '▼'} ${fmt(Math.abs(d))} (${pctText(t.ly, t.ty)})`,
    '',
    ...rep.channels.map((c) => `${c.label} ${pctText(c.ly, c.ty)}`),
  ];
  const app = (process.env.APP_PUBLIC_URL || 'https://tss-supplychain.vercel.app').replace(/\/+$/, '');
  lines.push('', `ดูรายละเอียดในระบบ (Dashboard ผู้บริหาร): ${app}`);
  return lines.join('\n');
}

// สร้างรูปและข้อความ (ไม่ส่ง) — คืน { rep, token, messages }
async function prepare(db, { from, to }) {
  const rep = await applyChocoToReport(buildWeeklyReport(db, { from, to }));
  const pngs = await renderReportPngs(rep);
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  cleanupOldImages();
  const token = crypto.randomBytes(16).toString('hex');
  pngs.forEach((buf, i) => fs.writeFileSync(imagePath(token, i + 1), buf));
  const base = publicBaseUrl();
  const messages = [{ type: 'text', text: summaryText(rep) }].concat(pngs.map((buf, i) => {
    const url = `${base}/public/line-reports/${token}/${i + 1}.png`;
    // preview ต้อง ≤ 1MB — รูปเราราว 150–300KB จึงใช้ไฟล์เดียวกัน
    return { type: 'image', originalContentUrl: url, previewImageUrl: url };
  }));
  return { rep, token, messages };
}

// ส่งรายงาน — targets ไม่ระบุ = ทุกกลุ่มที่เปิดใช้งาน · คืนสรุปผลต่อกลุ่ม
async function sendWeeklyReport(db, { from, to, trigger = 'manual', user = null, targets = null }) {
  if (!line.lineConfigured()) throw new Error('ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET ใน .env');
  const list = targets || db.prepare('SELECT target_id FROM line_targets WHERE active = 1 AND left_at IS NULL').all().map((r) => r.target_id);
  if (!list.length) throw new Error('ยังไม่มีกลุ่มไลน์ที่เปิดรับรายงาน — เชิญบอทเข้ากลุ่ม แล้วเปิดใช้งานในหน้าตั้งค่า');
  const { token, messages } = await prepare(db, { from, to });
  const results = [];
  for (const to of list) {
    try { await line.pushMessages(to, messages); results.push({ target: to, ok: true }); }
    catch (e) { results.push({ target: to, ok: false, error: e.message }); }
  }
  const failed = results.filter((r) => !r.ok);
  db.prepare(`INSERT INTO line_report_runs (period_from, period_to, token, trigger, targets, status, error, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(from, to, token, trigger, JSON.stringify(results),
    failed.length === 0 ? 'sent' : failed.length === results.length ? 'failed' : 'partial',
    failed.map((r) => `${r.target}: ${r.error}`).join('\n') || null, user);
  if (failed.length === results.length) throw new Error(`ส่งไม่สำเร็จ: ${failed[0].error}`);
  return { from, to, token, results };
}

module.exports = { prepare, sendWeeklyReport, imagePath, IMAGE_DIR };
