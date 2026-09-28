// ยอด Express ที่ tgm-wms "freeze" ไว้รายวัน (เดิมอยู่ในตาราง express_stock_snapshots บน Supabase ของ tgm-wms —
// ย้ายลงมาที่นี่ 2026-09-28 ตามที่ผู้ใช้ขอ เพราะตารางนี้กินพื้นที่ 244 MB / 87% ของฐานข้อมูล Supabase ทั้งหมด
// และเป็นข้อมูลที่คำนวณมาจาก Express อยู่แล้ว หน้าที่ใช้ก็ต้องพึ่งเซิร์ฟเวอร์นี้อยู่แล้ว)
//
// อ่าน: session ปกติ (บัญชี WMSAPI ที่ tgm-wms ใช้อ่านข้อมูล Express อยู่แล้ว)
// เขียน/ลบ: ต้องมี session ด้วย และต้องแนบ access token ของผู้ใช้ tgm-wms ที่ล็อกอินอยู่ (header X-WMS-Token)
//   เพราะรหัสบัญชี WMSAPI ฝังอยู่ใน bundle หน้าเว็บ ใครก็เอาไปใช้ได้ — ตรวจ token กับ Supabase Auth ของ
//   tgm-wms แล้วเช็ค role จากตาราง users (คนขับ DRIVER เขียนไม่ได้ เหมือน RLS เดิมบน Supabase)
const express = require('express');

const TOKEN_CACHE_MS = 5 * 60 * 1000;
const tokenCache = new Map(); // token -> { ok, role, until }

async function verifyWmsToken(token) {
  const url = (process.env.WMS_SUPABASE_URL || '').replace(/\/$/, '');
  const anon = process.env.WMS_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('WMS_SUPABASE_URL/WMS_SUPABASE_ANON_KEY not configured');
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit;
  const headers = { apikey: anon, Authorization: `Bearer ${token}` };
  const u = await fetch(`${url}/auth/v1/user`, { headers });
  let result = { ok: false, role: null };
  if (u.ok) {
    const user = await u.json();
    const r = await fetch(`${url}/rest/v1/users?select=role,is_active&id=eq.${encodeURIComponent(user.id)}`, { headers });
    const row = r.ok ? (await r.json())[0] : null;
    if (row && row.is_active !== false && row.role !== 'DRIVER') result = { ok: true, role: row.role };
  }
  result.until = Date.now() + (result.ok ? TOKEN_CACHE_MS : 30 * 1000);
  tokenCache.set(token, result);
  if (tokenCache.size > 500) for (const [k, v] of tokenCache) if (v.until < Date.now()) tokenCache.delete(k);
  return result;
}

function requireWmsUser(req, res, next) {
  const token = req.headers['x-wms-token'];
  if (!token) return res.status(401).json({ error: 'missing X-WMS-Token' });
  // tss-wms running on the local backend (wms/): its tokens are verified here, no Supabase round trip
  const local = req.app.locals.wms;
  const claims = local?.auth.verifyAccess(token);
  if (claims) {
    const p = local.auth.profile(claims.sub);
    if (p.is_active && p.role !== 'DRIVER') { req.wmsRole = p.role; return next(); }
    return res.status(403).json({ error: 'forbidden' });
  }
  verifyWmsToken(token)
    .then((v) => (v.ok ? (req.wmsRole = v.role, next()) : res.status(403).json({ error: 'forbidden' })))
    .catch((e) => res.status(503).json({ error: e.message }));
}

const SOURCES = new Set(['auto', 'manual', 'csv']);

module.exports = function expressSnapshotsRouter(db, wms) {
  const router = express.Router();
  router.use((req, res, next) => { req.app.locals.wms = wms; next(); });

  // GET ?date=YYYY-MM-DD&kind=net_no10[&userSet=1]  -> [{sku_code, qty, unit, source}]
  router.get('/', (req, res) => {
    const { date, kind } = req.query;
    if (!date || !kind) return res.status(400).json({ error: 'date and kind are required' });
    const userSetOnly = req.query.userSet === '1';
    const rows = db.prepare(
      `SELECT sku_code, qty, unit, source FROM express_stock_snapshots
       WHERE snapshot_date = ? AND kind = ? ${userSetOnly ? "AND source <> 'auto'" : ''}`
    ).all(date, kind);
    res.json(rows);
  });

  router.use(requireWmsUser);

  // POST /freeze {date, kind, source, onlyMissing, rows:[{sku_code, qty, unit}]}
  // onlyMissing = เติมเฉพาะ SKU ที่ยังไม่มีแถว ไม่ทับของเดิม (ใช้กับการ freeze อัตโนมัติตอนเปิดดู —
  // กันกรณีอ่าน snapshot ล้มชั่วคราวแล้วไปเขียนทับยอดที่คนกรอกเอง)
  router.post('/freeze', (req, res) => {
    const { date, kind, rows } = req.body || {};
    const source = req.body?.source || 'auto';
    if (!date || !kind || !Array.isArray(rows)) return res.status(400).json({ error: 'date, kind, rows are required' });
    if (!SOURCES.has(source)) return res.status(400).json({ error: 'bad source' });
    const conflict = req.body.onlyMissing
      ? 'DO NOTHING'
      : 'DO UPDATE SET qty = excluded.qty, unit = excluded.unit, source = excluded.source';
    const stmt = db.prepare(
      `INSERT INTO express_stock_snapshots (sku_code, snapshot_date, kind, qty, unit, source)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(snapshot_date, kind, sku_code) ${conflict}`
    );
    try {
      db.exec('BEGIN');
      for (const r of rows) stmt.run(String(r.sku_code), date, kind, Number(r.qty) || 0, r.unit ?? null, source);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true, count: rows.length });
  });

  // DELETE ?date=&kind=[&source=auto]  หรือ  ?all=1 (ล้างทั้งตาราง — ADMIN/SUPER_ADMIN เท่านั้น)
  router.delete('/', (req, res) => {
    if (req.query.all === '1') {
      if (!['ADMIN', 'SUPER_ADMIN'].includes(req.wmsRole)) return res.status(403).json({ error: 'forbidden' });
      const info = db.prepare('DELETE FROM express_stock_snapshots').run();
      return res.json({ ok: true, deleted: info.changes });
    }
    const { date, kind, source } = req.query;
    if (!date || !kind) return res.status(400).json({ error: 'date and kind are required' });
    if (source && !SOURCES.has(source)) return res.status(400).json({ error: 'bad source' });
    const info = source
      ? db.prepare('DELETE FROM express_stock_snapshots WHERE snapshot_date = ? AND kind = ? AND source = ?').run(date, kind, source)
      : db.prepare('DELETE FROM express_stock_snapshots WHERE snapshot_date = ? AND kind = ?').run(date, kind);
    res.json({ ok: true, deleted: info.changes });
  });

  return router;
};

module.exports.verifyWmsToken = verifyWmsToken;
