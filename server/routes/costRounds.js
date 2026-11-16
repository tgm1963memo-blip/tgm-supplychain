const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { parseUnit, round4 } = require('../lib/skuCost');

// นำเข้าทุน 3 ช่องจากไฟล์ "Master SKU ...ทุน3ช่อง.xlsx" ของฝ่ายต้นทุน (2026-11-16) — ตาราง sku_cost_rounds
// client อ่าน Excel ด้วย SheetJS → preview → import แบบเดียวกับ routes/promoCosts.js แต่ไฟล์นี้ไม่ใช่แบบฟอร์มของระบบ
// จึงต้องกรองเอง (ตรวจจากไฟล์จริงรอบ 2–7 พ.ย. 69, 4,412 แถว):
//   - แถวคั่นหัวข้อ รหัส = 0 หรือว่าง → ข้าม
//   - ทุนรวมเป็น 0 / ว่าง / ข้อความสถานะ ("สินค้าไม่เคลื่อนไหว") → ข้าม ไม่ทับทุนเดิมในระบบ
//   - ค่าผิดพลาดของ Excel (#N/A, #VALUE!) → รายงานแยก ไม่นำเข้า (client ส่งมาเป็นข้อความขึ้นต้น #)
//   - รหัสซ้ำ → ใช้แถวแรกที่มีทุน (แถวซ้ำท้ายไฟล์อยู่ในหมวดสินค้าใหม่/ไม่เคลื่อนไหว ซึ่งทุนมักไม่ครบ)
//   - ทุนรวมต่ำกว่าครึ่งของทุนเก่า (ช่อง E) → "ทุนต่ำผิดปกติ" น่าจะยังไม่รวมวัตถุดิบ: ค่าเริ่มต้น = พักไว้ไม่นำเข้า
//     ส่ง suspect: 'import' = นำเข้าพร้อมติดธง suspect ให้หน้าจอขึ้นป้ายรอยืนยัน
const MAX_ROWS = 10000;
const SUSPECT_RATIO = 0.5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const normCode = v => String(v ?? '').trim();
const normText = v => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s && s !== '0' ? s.slice(0, 200) : null; };

function isDate(s) {
  if (!DATE_RE.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ค่าในช่องทุน → { value } (> 0) | { zero } | { empty } | { text } (ข้อความสถานะ) | { error } (#N/A ฯลฯ) | { invalid } (ติดลบ)
function parseMoney(v) {
  if (v === null || v === undefined) return { empty: true };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { error: true };
    return v > 0 ? { value: round4(v) } : v === 0 ? { zero: true } : { invalid: true };
  }
  const s = String(v).trim();
  if (!s || s === '-') return { empty: true };
  if (s.startsWith('#')) return { error: true };
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return { text: true };
  return n > 0 ? { value: round4(n) } : n === 0 ? { zero: true } : { invalid: true };
}

const COST_FIELDS = ['cost_base', 'cost_depr', 'cost_total', 'unit', 'unit_grams', 'suspect'];
const same = (a, b) => (a ?? null) === (b ?? null);

// rows: [{ row, code, name, unit, old, base, depr, total, group, std_group, status }] (old = ช่อง E ใช้ตรวจทุนต่ำผิดปกติเท่านั้น)
function buildPlan(db, body) {
  const effDate = String(body?.eff_date || '');
  if (!isDate(effDate)) throw new Error('ต้องระบุวันที่เริ่มมีผลของทุน (YYYY-MM-DD)');
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows) throw new Error('rows ต้องเป็น array');
  if (rows.length > MAX_ROWS) throw new Error(`ไฟล์มีเกิน ${MAX_ROWS} แถว`);
  const importSuspect = body?.suspect === 'import';

  const known = new Set(db.prepare('SELECT code FROM products').all().map(r => r.code));
  for (const r of db.prepare('SELECT code FROM bplus_skus').all()) known.add(r.code);
  const inEffect = db.prepare('SELECT * FROM sku_cost_rounds WHERE sku = ? AND eff_date <= ? ORDER BY eff_date DESC LIMIT 1');

  const seen = new Map();
  const skipped = { separator: 0, inactive: 0 };
  const errors = [], invalid = [], dup = [];
  for (const r of rows) {
    const code = normCode(r?.code);
    if (!code || code === '0') { skipped.separator++; continue; }
    if (code.length > 40) { invalid.push({ row: r.row, code: code.slice(0, 40), reason: 'รหัสยาวเกิน 40 ตัวอักษร' }); continue; }
    // ไฟล์จริงมีช่องรหัสที่เป็นข้อความ เช่น "(หมู Free Range)" ซ้ำ 10 แถว และชื่อสินค้าไทย — รหัสสินค้าทุกแบบขึ้นต้นด้วยตัวเลข/อังกฤษ
    if (!/^[A-Za-z0-9]/.test(code)) { invalid.push({ row: r.row, code, reason: 'ช่องรหัสไม่ใช่รหัสสินค้า' }); continue; }
    const t = parseMoney(r.total);
    if (t.error) { errors.push({ row: r.row, code, value: String(r.total).slice(0, 20) }); continue; }
    if (t.invalid) { invalid.push({ row: r.row, code, reason: `ทุนรวมติดลบ: ${String(r.total).slice(0, 30)}` }); continue; }
    if (!('value' in t)) { skipped.inactive++; continue; }
    if (seen.has(code)) { dup.push({ code, row: r.row, kept_row: seen.get(code).row }); continue; }
    const b = parseMoney(r.base), d = parseMoney(r.depr), e = parseMoney(r.old);
    const u = parseUnit(r.unit);
    seen.set(code, {
      code, row: r.row, name: normText(r.name),
      next: {
        cost_base: 'value' in b ? b.value : null, cost_depr: 'value' in d ? d.value : null, cost_total: t.value,
        unit: u.unit, unit_raw: u.raw ? u.raw.slice(0, 60) : null, unit_grams: u.grams,
        product_group: normText(r.group), std_group: normText(r.std_group), status: normText(r.status),
        suspect: 'value' in e && t.value < e.value * SUSPECT_RATIO ? 1 : 0,
      },
      old_cost: 'value' in e ? e.value : null,
    });
  }

  const items = [], held = [];
  for (const n of seen.values()) {
    if (n.next.suspect && !importSuspect) { held.push(n); continue; }
    const cur = inEffect.get(n.code, effDate) || null;
    const changed = !cur || COST_FIELDS.some(f => !same(cur[f], n.next[f]));
    items.push({ ...n, cur, isNew: !cur, changed, sameDate: !!cur && cur.eff_date === effDate });
  }
  return { effDate, items, held, skipped, errors, invalid, dup, importSuspect, unknown: [...seen.keys()].filter(c => !known.has(c)) };
}

function summarize(plan) {
  const fmt = i => ({
    code: i.code, row: i.row, name: i.name, unit: i.next.unit_raw, suspect: !!i.next.suspect,
    base: i.next.cost_base, depr: i.next.cost_depr, total: i.next.cost_total,
    prev_total: i.cur ? i.cur.cost_total : null, prev_date: i.cur ? i.cur.eff_date : null,
  });
  const changed = plan.items.filter(i => !i.isNew && i.changed);
  const noUnit = plan.items.filter(i => !i.next.unit);
  return {
    eff_date: plan.effDate,
    new_count: plan.items.filter(i => i.isNew).length,
    changed_count: changed.length,
    unchanged_count: plan.items.filter(i => !i.changed).length,
    suspect_count: plan.importSuspect ? plan.items.filter(i => i.next.suspect).length : plan.held.length,
    suspect_mode: plan.importSuspect ? 'import' : 'hold',
    skipped: plan.skipped,
    error_count: plan.errors.length, invalid_count: plan.invalid.length, dup_count: plan.dup.length,
    unknown_count: plan.unknown.length, no_unit_count: noUnit.length,
    new_items: plan.items.filter(i => i.isNew).slice(0, 200).map(fmt),
    changed: changed.sort((a, b) => Math.abs(b.next.cost_total / b.cur.cost_total - 1) - Math.abs(a.next.cost_total / a.cur.cost_total - 1)).slice(0, 300).map(fmt),
    suspects: (plan.importSuspect ? plan.items.filter(i => i.next.suspect) : plan.held).slice(0, 300).map(i => ({ ...fmt(i), old_cost: i.old_cost })),
    errors: plan.errors.slice(0, 100), invalid: plan.invalid.slice(0, 100), dup: plan.dup.slice(0, 100),
    unknown: plan.unknown.slice(0, 300), no_unit: noUnit.slice(0, 100).map(i => i.code),
  };
}

const str = v => (v === null || v === undefined ? null : String(v));
const WRITE_COLS = ['cost_base', 'cost_depr', 'cost_total', 'unit', 'unit_raw', 'unit_grams', 'product_group', 'std_group', 'status', 'suspect'];

// เขียนแถวเดียว + log — ผู้เรียกต้องอยู่ใน transaction · คืน 'created' | 'updated'
function applyItem(db, i, effDate, uploadId, uid) {
  const now = new Date().toISOString();
  if (i.sameDate) {
    db.prepare(`UPDATE sku_cost_rounds SET ${WRITE_COLS.map(c => `${c} = ?`).join(',')}, upload_id = ?, updated_by = ?, updated_at = ? WHERE sku = ? AND eff_date = ?`)
      .run(...WRITE_COLS.map(c => i.next[c]), uploadId, uid, now, i.code, effDate);
  } else {
    db.prepare(`INSERT INTO sku_cost_rounds (sku, eff_date, ${WRITE_COLS.join(',')}, upload_id, updated_by, updated_at) VALUES (?, ?, ${WRITE_COLS.map(() => '?').join(',')}, ?, ?, ?)`)
      .run(i.code, effDate, ...WRITE_COLS.map(c => i.next[c]), uploadId, uid, now);
  }
  const log = db.prepare('INSERT INTO sku_cost_round_logs (sku, eff_date, field, old_value, new_value, upload_id, by_uid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  if (i.isNew) log.run(i.code, effDate, '*', null, 'created', uploadId, uid);
  for (const f of COST_FIELDS) if (i.isNew ? i.next[f] != null : !same(i.cur[f], i.next[f])) log.run(i.code, effDate, f, i.cur ? str(i.cur[f]) : null, str(i.next[f]), uploadId, uid);
  return i.isNew ? 'created' : 'updated';
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = function costRoundsRoutes(db, roles) {
  const router = express.Router();
  router.use(requireAuth(db), requireRole(...roles));

  // ทุนที่มีผล ณ วันที่ (?date=YYYY-MM-DD, ไม่ระบุ = ล่าสุดของแต่ละ SKU)
  router.get('/', (req, res) => {
    try {
      const date = isDate(req.query.date) ? req.query.date : '9999-12-31';
      res.json(db.prepare(`SELECT c.*, p.name FROM sku_cost_rounds c
        JOIN (SELECT sku, MAX(eff_date) AS d FROM sku_cost_rounds WHERE eff_date <= ? GROUP BY sku) l ON l.sku = c.sku AND l.d = c.eff_date
        LEFT JOIN products p ON p.code = c.sku ORDER BY c.sku`).all(date));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/uploads', (req, res) => {
    try {
      res.json({
        uploads: db.prepare('SELECT * FROM sku_cost_round_uploads ORDER BY uploaded_at DESC LIMIT 50').all(),
        rounds: db.prepare('SELECT eff_date, COUNT(*) AS n, SUM(suspect) AS suspect FROM sku_cost_rounds GROUP BY eff_date ORDER BY eff_date DESC').all(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/logs', (req, res) => {
    try {
      const sku = normCode(req.query.sku);
      if (!sku) return res.status(400).json({ error: 'ต้องระบุ sku' });
      res.json(db.prepare('SELECT * FROM sku_cost_round_logs WHERE sku = ? ORDER BY id DESC LIMIT 300').all(sku));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/import/preview', (req, res) => {
    try { res.json(summarize(buildPlan(db, req.body))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/import', (req, res) => {
    const id = genId('SCR');
    const file = normText(req.body?.file);
    const rmLabel = normText(req.body?.rm_label);
    try {
      const out = tx(db, () => {
        let plan;
        try { plan = buildPlan(db, req.body); } catch (e) { throw Object.assign(e, { status: 400 }); }
        let created = 0, updated = 0, unchanged = 0;
        for (const i of plan.items) {
          if (!i.changed) { unchanged++; continue; }
          applyItem(db, i, plan.effDate, id, req.user.uid) === 'created' ? created++ : updated++;
        }
        db.prepare('INSERT INTO sku_cost_round_uploads (id, file_name, eff_date, rm_label, created, updated, unchanged, held, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, file, plan.effDate, rmLabel, created, updated, unchanged, plan.held.length, req.user.uid);
        db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
          .run(req.user.uid, req.user.role, 'IMPORT_COST_ROUND', `${id} ${file || ''} มีผล ${plan.effDate} ใหม่ ${created} แก้ ${updated} พัก ${plan.held.length}`.slice(0, 500));
        return { upload_id: id, eff_date: plan.effDate, created, updated, unchanged, held: plan.held.length };
      });
      res.json(out);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  return router;
};

module.exports.parseMoney = parseMoney;
module.exports.buildPlan = buildPlan;
module.exports.summarize = summarize;
module.exports.applyItem = applyItem;
module.exports.tx = tx;
