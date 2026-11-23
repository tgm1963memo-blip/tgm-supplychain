const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');

// ราคากลางร้านค้า ฐาน A–G (2026-10-07, ใบเสนอราคา รอบ 1) — ตาราง price_tiers 1 แถวต่อรหัส (ดู db/schema.sql)
// เขียนเองแทน makeCrudRouter เพราะทุกการเปลี่ยนต้องเขียน price_tier_logs ในธุรกรรมเดียวกัน และการนำเข้า Excel
// ต้องแสดงผลต่างให้ดูก่อนบันทึก (preview → import) แบบเดียวกับตารางรหัสเอกสารของใบเคาะ (pdCodeMapImport)
// client อ่านไฟล์ด้วย SheetJS แล้วส่งแถวมาเป็น JSON — server ตรวจ/แปลงค่าเองทั้งหมด ไม่เชื่อค่าที่ client แปลงมา
const TIERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const col = t => `price_${t.toLowerCase()}`;
const PRICE_COLS = TIERS.map(col);
const TEXT_FIELDS = ['name_th', 'name_en', 'unit', 'note'];
const MAX_ROWS = 5000;

const normCode = v => String(v ?? '').trim();
const normText = v => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };

// ค่าราคาจากไฟล์: ตัวเลข → ปัดทศนิยม 2 ตำแหน่ง · ว่าง → null (ฐานนั้นไม่มีราคา) · ข้อความ "ยกเลิก…" → สินค้ายกเลิกขาย
// (ไฟล์จริงมี "ยกเลิกการขาย 6/3/2568" ในช่องราคา) · ข้อความอื่น/ติดลบ → invalid (คงราคาเดิม แจ้งในผลตรวจ)
function parsePrice(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? { value: Math.round(v * 100) / 100 } : { invalid: true };
  const s = String(v).trim();
  if (!s || s === '-') return { value: null };
  if (/ยกเลิก/.test(s)) return { value: null, cancelled: true };
  const n = Number(s.replace(/,/g, ''));
  if (Number.isFinite(n) && n >= 0) return { value: Math.round(n * 100) / 100 };
  return { invalid: true };
}

const same = (a, b) => (a ?? null) === (b ?? null);

// แปลงแถวจาก client → แผนการเปลี่ยน (ใช้ทั้ง preview และ import ให้ผลตรงกันเสมอ)
// rows: [{ row, code, name_th, name_en, unit, prices: { A: 135, ... } }] · tiers: ฐานที่มีคอลัมน์ในไฟล์
// (ไฟล์ "ไฟล์เสนอราคาฐาน A" มีราคาแค่ฐานเดียว → แก้เฉพาะฐานนั้น ฐานอื่นคงเดิม)
function buildPlan(db, body) {
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows) throw new Error('rows ต้องเป็น array');
  if (rows.length > MAX_ROWS) throw new Error(`ไฟล์มีเกิน ${MAX_ROWS} แถว`);
  const tiers = [...new Set((Array.isArray(body.tiers) ? body.tiers : []).map(t => String(t).toUpperCase()))].filter(t => TIERS.includes(t));
  if (!tiers.length) throw new Error('ไม่พบคอลัมน์ราคาฐาน A–G ในไฟล์');

  const existing = new Map(db.prepare('SELECT * FROM price_tiers').all().map(r => [r.code, r]));
  const known = new Set(db.prepare('SELECT code FROM products').all().map(r => r.code));
  const seen = new Map();
  const dup = [], invalid = [];
  for (const r of rows) {
    const code = normCode(r?.code);
    if (!code) continue;
    if (code.length > 40) { invalid.push({ row: r.row, code: code.slice(0, 40), tier: '', value: 'รหัสยาวเกิน 40 ตัวอักษร' }); continue; }
    if (seen.has(code)) dup.push(code);
    // คอลัมน์ "สถานะ" (ไฟล์ที่ส่งออกจากหน้าเว็บ) = "ยกเลิกการขาย" → ปิดใช้งานโดยคงราคาไว้
    const next = { code, name_th: normText(r.name_th), name_en: normText(r.name_en), unit: normText(r.unit), prices: {}, cancelled: /ยกเลิก/.test(String(r.status ?? '')), row: r.row };
    for (const t of tiers) {
      const p = parsePrice(r.prices ? r.prices[t] : null);
      if (p.invalid) { invalid.push({ row: r.row, code, tier: t, value: String(r.prices[t]).slice(0, 60) }); continue; }
      if (p.cancelled) next.cancelled = true;
      next.prices[t] = p.value;
    }
    seen.set(code, next); // รหัสซ้ำในไฟล์ = ใช้แถวล่างสุด (แจ้งใน dup)
  }

  const items = [];
  for (const n of seen.values()) {
    const old = existing.get(n.code);
    const set = {};
    // ชื่อ/หน่วย: ช่องว่างในไฟล์ไม่ลบค่าเดิม (ไฟล์บางแถวไม่มีชื่ออังกฤษ)
    for (const f of ['name_th', 'name_en', 'unit']) if (n[f] !== null && (!old || !same(old[f], n[f]))) set[f] = n[f];
    for (const t of tiers) if (t in n.prices && (!old || !same(old[col(t)], n.prices[t]))) set[col(t)] = n.prices[t];
    const active = n.cancelled ? 0 : 1;
    if (!old || old.is_active !== active) set.is_active = active;
    items.push({ code: n.code, row: n.row, isNew: !old, set, old: old || null });
  }
  const missing = [...existing.values()].filter(r => r.is_active && !seen.has(r.code)).map(r => r.code);
  return {
    tiers, items, missing, dup: [...new Set(dup)], invalid,
    unknown: [...seen.keys()].filter(c => !known.has(c)),
  };
}

function summarize(plan) {
  const changed = plan.items.filter(i => !i.isNew && Object.keys(i.set).length);
  const fmt = i => ({ code: i.code, row: i.row, changes: Object.entries(i.set).map(([f, v]) => ({ field: f, old: i.old ? i.old[f] ?? null : null, new: v })) });
  return {
    tiers: plan.tiers,
    total: plan.items.length,
    new_count: plan.items.filter(i => i.isNew).length,
    changed_count: changed.length,
    unchanged_count: plan.items.filter(i => !i.isNew && !Object.keys(i.set).length).length,
    cancelled: plan.items.filter(i => i.set.is_active === 0).map(i => i.code),
    new_items: plan.items.filter(i => i.isNew).slice(0, 300).map(fmt),
    changed: changed.slice(0, 300).map(fmt),
    missing: plan.missing, dup: plan.dup, invalid: plan.invalid.slice(0, 300), unknown: plan.unknown,
  };
}

function logChange(db, code, field, oldV, newV, source, batch, uid) {
  db.prepare('INSERT INTO price_tier_logs (code, field, old_value, new_value, source, batch_id, by_uid) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(code, field, oldV === null || oldV === undefined ? null : String(oldV), newV === null || newV === undefined ? null : String(newV), source, batch, uid);
}

// เขียนแถวเดียว (insert หรือ update เฉพาะฟิลด์ที่เปลี่ยน) + log — ผู้เรียกต้องอยู่ใน transaction
function applyRow(db, code, set, old, source, batch, uid) {
  const fields = Object.keys(set);
  if (!fields.length) return false;
  const now = new Date().toISOString();
  if (!old) {
    const cols = ['code', ...fields, 'updated_by', 'updated_at'];
    db.prepare(`INSERT INTO price_tiers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(code, ...fields.map(f => set[f]), uid, now);
    logChange(db, code, '*', null, 'created', source, batch, uid);
  } else {
    db.prepare(`UPDATE price_tiers SET ${fields.map(f => `${f} = ?`).join(',')}, updated_by = ?, updated_at = ? WHERE code = ?`)
      .run(...fields.map(f => set[f]), uid, now, code);
  }
  for (const f of fields) if (old) logChange(db, code, f, old[f], set[f], source, batch, uid);
  return true;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = function priceTiersRoutes(db, readRoles, writeRoles) {
  const router = express.Router();
  router.use(requireAuth(db), requireRole(...readRoles));
  const canWrite = requireRole(...writeRoles);

  router.get('/', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM price_tiers ${req.query.active === '1' ? 'WHERE is_active = 1' : ''} ORDER BY code`).all();
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/logs', (req, res) => {
    try {
      const code = normCode(req.query.code);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
      const rows = code
        ? db.prepare('SELECT * FROM price_tier_logs WHERE code = ? ORDER BY id DESC LIMIT ?').all(code, limit)
        : db.prepare('SELECT * FROM price_tier_logs ORDER BY id DESC LIMIT ?').all(limit);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/import/preview', canWrite, (req, res) => {
    try { res.json(summarize(buildPlan(db, req.body))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // deactivate_missing: ปิดใช้งานรหัสที่มีในระบบแต่ไม่อยู่ในไฟล์ (ผู้นำเข้าติ๊กเลือกเอง — ค่าเริ่มต้นไม่แตะ)
  router.post('/import', canWrite, (req, res) => {
    const batch = genId('PTI');
    const file = normText(req.body.file);
    try {
      const out = tx(db, () => {
        // คำนวณแผนภายใน transaction (อ่านค่าเดิมหลัง BEGIN IMMEDIATE) — log ค่าเดิมตรงกับที่ถูกเขียนทับจริง
        let plan;
        try { plan = buildPlan(db, req.body); } catch (e) { throw Object.assign(e, { status: 400 }); }
        let created = 0, updated = 0, deactivated = 0;
        for (const i of plan.items) {
          if (applyRow(db, i.code, i.set, i.old, 'import', batch, req.user.uid)) i.isNew ? created++ : updated++;
        }
        if (req.body.deactivate_missing === true) {
          for (const code of plan.missing) {
            const old = db.prepare('SELECT * FROM price_tiers WHERE code = ?').get(code);
            if (applyRow(db, code, { is_active: 0 }, old, 'import', batch, req.user.uid)) deactivated++;
          }
        }
        db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
          .run(req.user.uid, req.user.role, 'IMPORT_PRICE_TIERS', `${batch} ${file || ''} ฐาน ${plan.tiers.join('')} ใหม่ ${created} แก้ ${updated} ปิด ${deactivated}`.slice(0, 500));
        return { batch_id: batch, created, updated, deactivated };
      });
      res.json(out);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // แก้/เพิ่มรายตัวจากหน้าเว็บ — ส่งเฉพาะฟิลด์ที่จะแก้ · ราคา null = ล้างราคาฐานนั้น
  router.put('/:code', canWrite, (req, res) => {
    const code = normCode(req.params.code);
    if (!code || code.length > 40) return res.status(400).json({ error: 'รหัสไม่ถูกต้อง' });
    const b = req.body || {};
    const set = {};
    try {
      for (const f of TEXT_FIELDS) if (f in b) set[f] = normText(b[f]);
      for (const c of PRICE_COLS) if (c in b) {
        const p = parsePrice(b[c]);
        if (p.invalid || p.cancelled) throw new Error(`ราคา ${c.slice(-1).toUpperCase()} ไม่ถูกต้อง`);
        set[c] = p.value;
      }
      if ('is_active' in b) set.is_active = b.is_active ? 1 : 0;
    } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const row = tx(db, () => {
        const old = db.prepare('SELECT * FROM price_tiers WHERE code = ?').get(code) || null;
        if (!old && !set.name_th) throw Object.assign(new Error('สินค้าใหม่ต้องมีชื่อสินค้า'), { status: 400 });
        const diff = {};
        for (const [f, v] of Object.entries(set)) if (!old || !same(old[f], v)) diff[f] = v;
        applyRow(db, code, diff, old, 'manual', null, req.user.uid);
        return db.prepare('SELECT * FROM price_tiers WHERE code = ?').get(code);
      });
      res.json(row);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  return router;
};

module.exports.parsePrice = parsePrice;
module.exports.TIERS = TIERS;
