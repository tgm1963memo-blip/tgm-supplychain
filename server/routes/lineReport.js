'use strict';

// รายงาน LINE รายสัปดาห์ (2026-11-13) — 3 ส่วน:
//   webhookRouter  POST /api/line/webhook            (ไม่ต้องล็อกอิน · ตรวจลายเซ็น LINE) บันทึกกลุ่มที่บอทถูกเชิญเข้า/ออก
//   publicImage    GET  /public/line-reports/:token/:n.png  (ไม่ต้องล็อกอิน · token สุ่ม 128 บิต) ให้ LINE ดึงรูป
//   adminRouter    /api/line_report/*                (admin/superadmin) ดูตัวอย่าง / ส่งทดสอบ / เปิด-ปิดกลุ่ม / ประวัติ

const express = require('express');
const fs = require('fs');
const line = require('../lib/lineMessaging');
const { buildWeeklyReport, reportRange } = require('../lib/weeklySalesReport');
const { reportHtml } = require('../lib/renderReportImage');
const { sendWeeklyReport, imagePath } = require('../lib/lineWeeklyReport');

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function webhookRouter(db) {
  const router = express.Router();
  // ต้องได้ body ดิบไว้ตรวจลายเซ็น — mount ก่อน express.json() ใน app.js
  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!line.verifySignature(req.body, req.headers['x-line-signature'])) return res.status(401).json({ error: 'bad signature' });
    let events = [];
    try { events = JSON.parse(req.body.toString('utf8')).events || []; } catch { return res.status(400).json({ error: 'bad json' }); }
    res.json({ ok: true }); // ตอบ LINE ทันที (ต้องตอบภายในไม่กี่วินาที)
    for (const ev of events) {
      const src = ev.source || {};
      const id = src.groupId || src.roomId;
      if (!id) continue;
      try {
        if (ev.type === 'join') {
          const name = src.groupId ? await line.groupName(src.groupId) : '';
          // เข้ากลุ่มใหม่ = ยังไม่ส่ง (active = 0) จนกว่า admin จะเปิดในหน้าตั้งค่า
          db.prepare(`INSERT INTO line_targets (target_id, kind, name, active) VALUES (?, ?, ?, 0)
            ON CONFLICT(target_id) DO UPDATE SET name = excluded.name, left_at = NULL`).run(id, src.groupId ? 'group' : 'room', name);
          console.log(`[line] bot joined ${id} ${name}`);
        } else if (ev.type === 'leave') {
          db.prepare(`UPDATE line_targets SET active = 0, left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE target_id = ?`).run(id);
          console.log(`[line] bot left ${id}`);
        }
      } catch (e) {
        console.error('[line] webhook event failed:', e.message);
      }
    }
  });
  return router;
}

function publicImage(req, res) {
  const p = imagePath(req.params.token, req.params.n);
  if (!p || !fs.existsSync(p)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('png').sendFile(p);
}

function adminRouter(db) {
  const router = express.Router();
  const range = (q) => {
    if (q.from || q.to) {
      const from = String(q.from || ''), to = String(q.to || '');
      if (!YMD_RE.test(from) || !YMD_RE.test(to) || from > to || from.slice(0, 4) !== to.slice(0, 4)) {
        throw Object.assign(new Error('from/to ต้องเป็น YYYY-MM-DD ปีเดียวกัน และ from ≤ to'), { status: 400 });
      }
      return { from, to };
    }
    return reportRange(new Date());
  };
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

  // ช่วงที่จะส่งรอบถัดไป + สถานะการตั้งค่า
  router.get('/status', (req, res) => {
    res.json({
      configured: line.lineConfigured(),
      enabled: process.env.WEEKLY_LINE_REPORT_ENABLED === '1',
      cron: process.env.WEEKLY_LINE_REPORT_CRON || '30 8 * * 1',
      next_range: reportRange(new Date()),
      public_url_set: !!process.env.PUBLIC_API_URL,
    });
  });

  // ตัวอย่างรายงานเป็นหน้า HTML (ตารางเดียวกับรูปที่ส่ง)
  router.get('/preview', (req, res) => {
    try {
      const rep = buildWeeklyReport(db, range(req.query));
      if (req.query.format === 'json') return res.json(rep);
      res.type('html').send(reportHtml(rep));
    } catch (e) { fail(res, e); }
  });

  router.get('/targets', (req, res) => {
    res.json({ rows: db.prepare('SELECT * FROM line_targets ORDER BY left_at IS NOT NULL, joined_at DESC').all() });
  });
  router.patch('/targets/:id', (req, res) => {
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
    if (typeof b.name === 'string') { sets.push('name = ?'); vals.push(b.name.trim().slice(0, 100)); }
    if (!sets.length) return res.status(400).json({ error: 'ไม่มีค่าที่จะแก้' });
    const r = db.prepare(`UPDATE line_targets SET ${sets.join(', ')}, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE target_id = ?`).run(...vals, req.user?.uid || null, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'ไม่พบกลุ่มนี้' });
    res.json({ ok: true });
  });

  // ส่งทันที (ทดสอบ) — body { from?, to?, target_id? } · target_id = ส่งเข้ากลุ่มเดียว (แม้ยังไม่เปิดใช้งาน)
  router.post('/send', async (req, res) => {
    try {
      const b = req.body || {};
      const r = range(b);
      let targets = null;
      if (b.target_id) {
        if (!db.prepare('SELECT 1 FROM line_targets WHERE target_id = ? AND left_at IS NULL').get(b.target_id)) return res.status(404).json({ error: 'ไม่พบกลุ่มนี้' });
        targets = [b.target_id];
      }
      res.json(await sendWeeklyReport(db, { ...r, trigger: 'manual', user: req.user?.uid || null, targets }));
    } catch (e) { fail(res, e); }
  });

  router.get('/runs', (req, res) => {
    res.json({ rows: db.prepare('SELECT id, period_from, period_to, trigger, targets, status, error, created_by, created_at FROM line_report_runs ORDER BY id DESC LIMIT 30').all() });
  });

  return router;
}

module.exports = { webhookRouter, publicImage, adminRouter };
