const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { isMonth, DEFAULT_SETTINGS, SETTING_KEYS, getSettings } = require('../lib/promoCost');

// ทุนสินค้า + ราคาหมูหน้าฟาร์ม + เกณฑ์พิจารณาโปร (2026-10-22, เฟส 1) — ข้อมูลอ่อนไหว (ทุนผลิต) สิทธิ์กำหนดใน app.js (ปัจจุบัน admin/superadmin)
// ทุน: client อ่าน Excel ด้วย SheetJS → preview แสดงผลต่าง → import (แบบเดียวกับ routes/priceTiers.js) ทีละเดือน
// ราคาหมู: แก้ทีละช่อง (เดือน × จริง/คาดการณ์) · ทุกการเปลี่ยนเขียน log ในธุรกรรมเดียวกัน
const MAX_ROWS = 5000;
const normCode = v => String(v ?? '').trim();
const normText = v => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };

// ทุน: ตัวเลข > 0 ปัด 4 ตำแหน่ง · ว่าง = ข้ามแถว · อื่นๆ = invalid
function parseCost(v) {
  if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '-') return { empty: true };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? { value: Math.round(n * 10000) / 10000 } : { invalid: true };
}
// %เนื้อหมู: เก็บเป็นสัดส่วน 0–1 · Excel ช่องเปอร์เซ็นต์ส่งมาเป็น 0.6 · พิมพ์ 60 หรือ "60%" = 0.6 · ว่าง = null (ไม่รู้)
function parsePct(v) {
  if (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '-') return { value: null };
  const s = String(v).trim();
  let n = typeof v === 'number' ? v : Number(s.replace(/[%,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return { invalid: true };
  if (typeof v !== 'number' && /%/.test(s)) n /= 100;
  else if (n > 1) n /= 100;
  return n <= 1 ? { value: Math.round(n * 10000) / 10000 } : { invalid: true };
}

const same = (a, b) => (a ?? null) === (b ?? null);

// แถวจาก client → แผน (ใช้ทั้ง preview และ import) · rows: [{ row, code, name, unit, cost, pork_pct }]
// %เนื้อหมูว่างในไฟล์ = คงค่าเดิมของเดือนนี้ หรือยกค่าล่าสุดของเดือนก่อนมา (ฝ่ายต้นทุนมักส่งแค่ทุนทุกเดือน)
function buildPlan(db, body) {
  const month = String(body?.month || '');
  if (!isMonth(month)) throw new Error('ต้องระบุเดือนของทุน (YYYY-MM)');
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows) throw new Error('rows ต้องเป็น array');
  if (rows.length > MAX_ROWS) throw new Error(`ไฟล์มีเกิน ${MAX_ROWS} แถว`);

  const existing = new Map(db.prepare('SELECT * FROM sku_costs WHERE month = ?').all(month).map(r => [r.sku, r]));
  const prevPork = db.prepare('SELECT pork_pct FROM sku_costs WHERE sku = ? AND month < ? AND pork_pct IS NOT NULL ORDER BY month DESC LIMIT 1');
  const known = new Set(db.prepare('SELECT code FROM products').all().map(r => r.code));
  const seen = new Map();
  const dup = [], invalid = [], carried = [];
  for (const r of rows) {
    const code = normCode(r?.code);
    if (!code) continue;
    if (code.length > 40) { invalid.push({ row: r.row, code: code.slice(0, 40), field: 'code', value: 'รหัสยาวเกิน 40 ตัวอักษร' }); continue; }
    const c = parseCost(r.cost);
    if (c.empty) continue;
    if (c.invalid) { invalid.push({ row: r.row, code, field: 'cost', value: String(r.cost).slice(0, 60) }); continue; }
    const p = parsePct(r.pork_pct);
    if (p.invalid) { invalid.push({ row: r.row, code, field: 'pork_pct', value: String(r.pork_pct).slice(0, 60) }); continue; }
    if (seen.has(code)) dup.push(code);
    seen.set(code, { code, row: r.row, name: normText(r.name), cost: c.value, unit: normText(r.unit), pork_pct: p.value });
  }
  const items = [];
  for (const n of seen.values()) {
    const old = existing.get(n.code) || null;
    let pork = n.pork_pct;
    if (pork === null) {
      pork = old ? old.pork_pct : (prevPork.get(n.code, month)?.pork_pct ?? null);
      if (pork !== null) carried.push(n.code);
    }
    const next = { cost: n.cost, unit: n.unit ?? old?.unit ?? null, pork_pct: pork };
    const set = {};
    for (const f of ['cost', 'unit', 'pork_pct']) if (!old || !same(old[f], next[f])) set[f] = next[f];
    items.push({ code: n.code, row: n.row, name: n.name, isNew: !old, set, old });
  }
  return { month, items, dup: [...new Set(dup)], invalid, carried, unknown: [...seen.keys()].filter(c => !known.has(c)) };
}

function summarize(plan) {
  const changed = plan.items.filter(i => !i.isNew && Object.keys(i.set).length);
  const fmt = i => ({ code: i.code, row: i.row, name: i.name, changes: Object.entries(i.set).map(([f, v]) => ({ field: f, old: i.old ? i.old[f] ?? null : null, new: v })) });
  return {
    month: plan.month,
    total: plan.items.length,
    new_count: plan.items.filter(i => i.isNew).length,
    changed_count: changed.length,
    unchanged_count: plan.items.filter(i => !i.isNew && !Object.keys(i.set).length).length,
    no_pork: plan.items.filter(i => (i.isNew ? i.set.pork_pct : ('pork_pct' in i.set ? i.set.pork_pct : i.old.pork_pct)) == null).map(i => i.code),
    new_items: plan.items.filter(i => i.isNew).slice(0, 300).map(fmt),
    changed: changed.slice(0, 300).map(fmt),
    carried: plan.carried, dup: plan.dup, invalid: plan.invalid.slice(0, 300), unknown: plan.unknown,
  };
}

const str = v => (v === null || v === undefined ? null : String(v));

// เขียนแถวเดียว + log — ผู้เรียกต้องอยู่ใน transaction
function applyRow(db, sku, month, set, old, uploadId, uid) {
  const fields = Object.keys(set);
  if (!fields.length) return false;
  const now = new Date().toISOString();
  if (!old) {
    db.prepare('INSERT INTO sku_costs (sku, month, cost, unit, pork_pct, upload_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sku, month, set.cost, set.unit ?? null, set.pork_pct ?? null, uploadId, uid, now);
  } else {
    db.prepare(`UPDATE sku_costs SET ${fields.map(f => `${f} = ?`).join(',')}, upload_id = ?, updated_by = ?, updated_at = ? WHERE sku = ? AND month = ?`)
      .run(...fields.map(f => set[f]), uploadId, uid, now, sku, month);
  }
  const log = db.prepare('INSERT INTO sku_cost_logs (sku, month, field, old_value, new_value, upload_id, by_uid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  if (!old) log.run(sku, month, '*', null, 'created', uploadId, uid);
  for (const f of fields) log.run(sku, month, f, old ? str(old[f]) : null, str(set[f]), uploadId, uid);
  return true;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = function promoCostsRoutes(db, readRoles, writeRoles, settingsRoles) {
  const router = express.Router();
  router.use(requireAuth(db), requireRole(...readRoles));
  const canWrite = requireRole(...writeRoles);
  const canSettings = requireRole(...settingsRoles);

  // ── ทุนสินค้า ───────────────────────────────────────────────────────
  // ?month=YYYY-MM = ทุนของเดือนนั้น · ไม่ระบุ = ทุนล่าสุดของแต่ละ SKU
  router.get('/sku', (req, res) => {
    try {
      const month = String(req.query.month || '');
      const rows = isMonth(month)
        ? db.prepare('SELECT c.*, p.name FROM sku_costs c LEFT JOIN products p ON p.code = c.sku WHERE c.month = ? ORDER BY c.sku').all(month)
        : db.prepare(`SELECT c.*, p.name FROM sku_costs c
            JOIN (SELECT sku, MAX(month) AS m FROM sku_costs GROUP BY sku) l ON l.sku = c.sku AND l.m = c.month
            LEFT JOIN products p ON p.code = c.sku ORDER BY c.sku`).all();
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/sku/months', (req, res) => {
    try {
      res.json({
        months: db.prepare('SELECT month, COUNT(*) AS n, SUM(pork_pct IS NULL) AS no_pork FROM sku_costs GROUP BY month ORDER BY month DESC').all(),
        uploads: db.prepare('SELECT * FROM sku_cost_uploads ORDER BY uploaded_at DESC LIMIT 50').all(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/sku/logs', (req, res) => {
    try {
      const sku = normCode(req.query.sku);
      if (!sku) return res.status(400).json({ error: 'ต้องระบุ sku' });
      res.json(db.prepare('SELECT * FROM sku_cost_logs WHERE sku = ? ORDER BY id DESC LIMIT 300').all(sku));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/sku/import/preview', canWrite, (req, res) => {
    try { res.json(summarize(buildPlan(db, req.body))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/sku/import', canWrite, (req, res) => {
    const id = genId('SCU');
    const file = normText(req.body?.file);
    try {
      const out = tx(db, () => {
        let plan;
        try { plan = buildPlan(db, req.body); } catch (e) { throw Object.assign(e, { status: 400 }); }
        let created = 0, updated = 0;
        for (const i of plan.items) if (applyRow(db, i.code, plan.month, i.set, i.old, id, req.user.uid)) i.isNew ? created++ : updated++;
        db.prepare('INSERT INTO sku_cost_uploads (id, file_name, month, created, updated, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, file, plan.month, created, updated, req.user.uid);
        db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
          .run(req.user.uid, req.user.role, 'IMPORT_SKU_COSTS', `${id} ${file || ''} เดือน ${plan.month} ใหม่ ${created} แก้ ${updated}`.slice(0, 500));
        return { upload_id: id, month: plan.month, created, updated };
      });
      res.json(out);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // แก้รายตัวบนเว็บ (ส่วนใหญ่ใช้เติม %เนื้อหมูทีหลัง) — body: { month, cost?, unit?, pork_pct? }
  router.put('/sku/:sku', canWrite, (req, res) => {
    const sku = normCode(req.params.sku);
    const b = req.body || {};
    if (!sku || sku.length > 40) return res.status(400).json({ error: 'รหัสไม่ถูกต้อง' });
    if (!isMonth(b.month)) return res.status(400).json({ error: 'ต้องระบุเดือน (YYYY-MM)' });
    const set = {};
    if ('cost' in b) { const c = parseCost(b.cost); if (c.empty || c.invalid) return res.status(400).json({ error: 'ทุนต้องเป็นตัวเลขมากกว่า 0' }); set.cost = c.value; }
    if ('pork_pct' in b) { const p = parsePct(b.pork_pct); if (p.invalid) return res.status(400).json({ error: '%เนื้อหมูต้องอยู่ระหว่าง 0–100' }); set.pork_pct = p.value; }
    if ('unit' in b) set.unit = normText(b.unit);
    try {
      const row = tx(db, () => {
        const old = db.prepare('SELECT * FROM sku_costs WHERE sku = ? AND month = ?').get(sku, b.month) || null;
        if (!old && set.cost === undefined) throw Object.assign(new Error('ทุนของเดือนใหม่ต้องระบุราคาทุน'), { status: 400 });
        const diff = {};
        for (const [f, v] of Object.entries(set)) if (!old || !same(old[f], v)) diff[f] = v;
        applyRow(db, sku, b.month, diff, old, null, req.user.uid);
        return db.prepare('SELECT c.*, p.name FROM sku_costs c LEFT JOIN products p ON p.code = c.sku WHERE c.sku = ? AND c.month = ?').get(sku, b.month);
      });
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── ราคาหมูหน้าฟาร์ม ────────────────────────────────────────────────
  router.get('/pig', (req, res) => {
    try { res.json(db.prepare('SELECT * FROM pig_prices ORDER BY month, kind').all()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/pig/logs', (req, res) => {
    try { res.json(db.prepare('SELECT * FROM pig_price_logs ORDER BY id DESC LIMIT 300').all()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // body: { month, kind: actual|forecast, price_per_kg: ตัวเลข | null (= ลบ), note? }
  router.put('/pig', canWrite, (req, res) => {
    const b = req.body || {};
    if (!isMonth(b.month)) return res.status(400).json({ error: 'ต้องระบุเดือน (YYYY-MM)' });
    if (!['actual', 'forecast'].includes(b.kind)) return res.status(400).json({ error: 'kind ต้องเป็น actual หรือ forecast' });
    let price = null;
    if (b.price_per_kg !== null && b.price_per_kg !== undefined && String(b.price_per_kg).trim() !== '') {
      price = Number(String(b.price_per_kg).replace(/,/g, ''));
      if (!Number.isFinite(price) || price <= 0 || price > 1000) return res.status(400).json({ error: 'ราคาหมูต้องเป็นตัวเลข 0–1,000 บาท/กก.' });
      price = Math.round(price * 100) / 100;
    }
    try {
      const row = tx(db, () => {
        const old = db.prepare('SELECT * FROM pig_prices WHERE month = ? AND kind = ?').get(b.month, b.kind) || null;
        if (same(old?.price_per_kg, price) && (price === null || !('note' in b) || same(old?.note, normText(b.note)))) return old;
        if (price === null) db.prepare('DELETE FROM pig_prices WHERE month = ? AND kind = ?').run(b.month, b.kind);
        else db.prepare(`INSERT INTO pig_prices (month, kind, price_per_kg, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (month, kind) DO UPDATE SET price_per_kg = excluded.price_per_kg, note = COALESCE(excluded.note, pig_prices.note),
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(b.month, b.kind, price, 'note' in b ? normText(b.note) : null, req.user.uid, new Date().toISOString());
        if (!same(old?.price_per_kg, price)) db.prepare('INSERT INTO pig_price_logs (month, kind, old_value, new_value, by_uid) VALUES (?, ?, ?, ?, ?)')
          .run(b.month, b.kind, old?.price_per_kg ?? null, price, req.user.uid);
        return db.prepare('SELECT * FROM pig_prices WHERE month = ? AND kind = ?').get(b.month, b.kind) || null;
      });
      res.json(row || { month: b.month, kind: b.kind, price_per_kg: null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── เกณฑ์พิจารณาโปร ─────────────────────────────────────────────────
  router.get('/settings', (req, res) => {
    try { res.json({ values: getSettings(db), defaults: DEFAULT_SETTINGS }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // body: { key: number | null (= กลับค่าเริ่มต้น) }
  router.put('/settings', canSettings, (req, res) => {
    const b = req.body || {};
    const keys = Object.keys(b).filter(k => SETTING_KEYS.includes(k));
    if (!keys.length) return res.status(400).json({ error: 'ไม่มีค่าที่แก้ได้' });
    for (const k of keys) {
      if (b[k] === null) continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ error: `ค่า ${k} ไม่ถูกต้อง` });
    }
    try {
      tx(db, () => {
        for (const k of keys) {
          if (b[k] === null) db.prepare('DELETE FROM promo_eval_settings WHERE key = ?').run(k);
          else db.prepare(`INSERT INTO promo_eval_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
            .run(k, JSON.stringify(Number(b[k])), req.user.uid, new Date().toISOString());
        }
        db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
          .run(req.user.uid, req.user.role, 'UPDATE_PROMO_EVAL_SETTINGS', JSON.stringify(Object.fromEntries(keys.map(k => [k, b[k]]))).slice(0, 500));
      });
      res.json({ values: getSettings(db), defaults: DEFAULT_SETTINGS });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};

module.exports.parseCost = parseCost;
module.exports.parsePct = parsePct;
