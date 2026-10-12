const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWhere, buildOrderBy } = require('../lib/pgQuery');
const { genId } = require('../lib/crud');
const { validateChange, holdOf, completeAfterHold } = require('../lib/promoApproval');
const { overlapsFor } = require('../lib/promoOverlap');
const cs = require('../lib/customerScope');
const promoMail = require('../lib/promoApprovalMail');
const promoNo = require('../lib/promoNumber');
const { nextPromoNoFor, nextDocNoFor, docCustCodes, ruleForCodes, loadCodeMap, docNoBase } = promoNo;
const { logDraft, logHeaderChange } = require('../lib/promoLog');

// เอกสาร "ใบเคาะราคา" ระดับหัว (1 แถวต่อ 1 เอกสาร, draft_no เป็น PK) — ไม่ใช้ makeCrudRouter ทั่วไปเพราะ
// ต้องคำนวณ doc_no (เลขที่เอกสารแบบรัน) แบบอะตอมมิกฝั่ง server และ derive created_by จาก session เสมอ
// (เหตุผลเดียวกับ audit_log's POST fix ใน app.js — ห้ามเชื่อค่าที่ client ส่งมาสำหรับฟิลด์ที่บ่งบอกตัวตน/
// ลำดับเอกสาร) — ต่างจาก audit_log ตรงที่เอกสารนี้ต้องแก้ไข/ลบได้ (ไม่ใช่ log ที่ต้อง immutable) จึงเขียน
// PATCH/DELETE เองด้วยแทนที่จะพึ่ง makeCrudRouter's readOnly:true (ซึ่งปิดทั้ง POST/PATCH/DELETE พร้อมกัน
// ต่อ router เดียว — ต่อ middleware เพิ่มทีหลังแทรกก่อน handler เดิมไม่ได้ เพราะ Express รันตามลำดับที่ .post/
// .patch ถูกเรียกจริง ไม่ใช่ตามที่ import/mount)
const FIELDS = [
  'promo_name', 'purpose', 'condition_type', 'item_type', 'note', 'equipment', 'discount_scope',
  'cost_start_date', 'cost_end_date', 'start_date', 'due_date',
  'is_npd', 'has_off_contract_cost', 'has_marketing_cost', 'other_costs_json',
  'has_compensate', 'special_distribution', 'form_extra_json',
  // เส้นทางอนุมัติที่เลือกตอนส่ง (2026-09-24) — route_name เป็น snapshot ที่ validateChange เขียนเอง
  'route_id', 'route_name',
  // approval_history_json ถูกเขียนโดย validateChange เท่านั้น (client ส่งมาก็ถูก reject — ดู promoApproval.js)
  'approval_history_json',
  // overlap_hold_json (2026-10-06) — เขียนโดย validateChange เท่านั้น (client ส่งมาถูก reject)
  'overlap_hold_json',
  'levels_json', 'current_level', 'approvers_json', 'status', 'keyed_by', 'keyed_at',
  // updated_by ยังรับจาก client ได้ (client ส่ง UID ของตัวเองมาบอกว่า "ฉันเป็นคนแก้ไขล่าสุด") ต่างจาก
  // created_by/doc_no ที่ห้ามเชื่อ เพราะ updated_by ไม่ใช่ช่องทางปลอมตัวเป็นคนอื่น (แค่บันทึกว่าใครกดล่าสุด
  // ซึ่งควรจะเป็น uid ของ session นี้เองอยู่แล้ว แต่ไม่ใช่ช่องโหว่ความปลอดภัยเทียบเท่า created_by)
  'updated_by',
];
// item_type added (2026-09-16): "ลักษณะรายการ" changed from single-select to multi-select checkboxes
// per user request — client now sends/reads an array here even though the column itself is a plain
// TEXT (no schema change needed, node:sqlite doesn't care), same JSON-in-a-TEXT-column convention
// already used for other_costs_json/levels_json/approvers_json below.
const JSON_FIELDS = ['other_costs_json', 'levels_json', 'approvers_json', 'item_type', 'approval_history_json', 'form_extra_json',
  // ยกเลิก (2026-09-30) — parse ตอนอ่านเท่านั้น (ไม่อยู่ใน FIELDS → PATCH ปกติเขียนไม่ได้ ต้องผ่าน endpoint ยกเลิก)
  'cancel_request_json', 'cancel_history_json', 'cancelled_skus_json', 'overlap_hold_json'];

// FIXED (2026-09-13, /code-review): used to redefine its own copy of lib/crud.js's genId here —
// same algorithm, byte-for-byte, kept in sync by hand across 3 files. Import it instead.
function genDraftNo() {
  return genId('PMD');
}

// เลขที่ใบเคาะ (doc_no) ตามรหัสลูกค้า — ดู lib/promoNumber.js (2026-10-03: 1LTA69-10001, ไม่เข้ากฎ = PC<พ.ศ.>-0001)

// เลขที่ "ใบโปรโมชั่น" — ออกให้ครั้งเดียวตอนอนุมัติผ่านขั้นสุดท้ายจริง เอกสารที่เคยมี promo_no แล้วไม่ออกซ้ำ
// (idempotent ต่อการ PATCH ซ้ำ) · 2026-09-24: แยกตามลูกค้า ต่อเลขชุดเดิมใน Express (LT-0149 → LT-0150) —
// ดู lib/promoNumber.js · single-writer node:sqlite ไม่มี race ระหว่างหาเลขสูงสุดกับ UPDATE

// ใช้ร่วมกันระหว่าง PATCH ปกติ และการอนุมัติผ่านลิงก์อีเมล (routes/promoEmailApprove.js) — ต้องเรียกภายใน
// transaction ของผู้เรียก, validateChange เป็นตัวคำนวณผลอนุมัติจริงเสมอ
function applyHeaderChange(db, target, input, user, opts = {}) {
  const body = { ...input, updated_by: user.uid, updated_at: new Date().toISOString() };
  validateChange(db, target, body, user);
  for (const f of JSON_FIELDS) if (body[f] !== undefined && typeof body[f] !== 'string') body[f] = JSON.stringify(body[f]);
  const cols = [...FIELDS.filter(f => body[f] !== undefined), 'updated_at'];
  if (body.status === 'approved' && !target.promo_no) {
    body.promo_no = nextPromoNoFor(db, target);  // ใบโปรตามรหัสลูกค้า เช่น LTA69-10001
    cols.push('promo_no');
  }
  db.prepare(`UPDATE promo_draft_headers SET ${cols.map(c => `${c} = ?`).join(',')} WHERE draft_no = ?`)
    .run(...cols.map(c => body[c]), target.draft_no);
  const saved = parseRow(db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no=?').get(target.draft_no));
  logHeaderChange(db, target, saved, user, opts.channel || 'system');
  return saved;
}
// URL สาธารณะของ server (ใช้สร้างลิงก์อนุมัติในอีเมล) — PUBLIC_API_URL ถ้าตั้งไว้ ไม่งั้นใช้ host ที่ request
// เข้ามา (ผ่าน tunnel จะได้ URL ของ tunnel เอง)
function publicBaseUrl(req) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function parseRow(row) {
  if (!row) return row;
  for (const f of JSON_FIELDS) {
    if (typeof row[f] === 'string') {
      try { row[f] = JSON.parse(row[f]); } catch { /* leave as-is */ }
    }
  }
  return row;
}

module.exports = function promoDraftHeadersRoutes(db, writeRoles) {
  const router = express.Router();
  router.use(requireAuth(db));
  // สิทธิ์การเห็นใบเคาะ (2026-10-06, lib/customerScope.js): ผู้สร้าง/ผู้อนุมัติ/ผู้เกี่ยวข้องการยกเลิก หรือมีสาขาที่มองเห็น
  // ผู้ที่ไม่จำกัด (admin/ผู้บริหาร/ฝ่ายแผน ฯลฯ) เห็นทั้งหมด · ใบที่มองไม่เห็น = 404 สำหรับ endpoint ราย draft_no
  const visibleSet = req => { const nos = cs.visibleDraftNos(db, cs.resolveScope(db, req.user), req.user.uid); return nos ? new Set(nos) : null; };
  router.param('draftNo', (req, res, next, no) => {
    const vis = visibleSet(req);
    if (vis && !vis.has(no) && db.prepare('SELECT 1 FROM promo_draft_headers WHERE draft_no = ?').get(no)) return res.status(404).json({ error: 'ไม่พบเอกสาร หรือไม่มีสิทธิ์เห็นเอกสารนี้' });
    next();
  });

  // ── ตารางรหัสเอกสารตามรหัสลูกค้า (2026-10-03) — นำเข้าจาก Excel ในหน้าตั้งค่า ─────────────────────────
  const MAP_ADMIN = ['admin', 'superadmin'];
  router.get('/code-map', (req, res) => res.json(loadCodeMap(db)));
  // client ส่งแถวดิบจาก Excel ({row, A..M}) → server แปลงเป็นกฎ (ตัวอ่านเดียว) — preview ไม่บันทึก
  router.post('/code-map/preview', (req, res) => res.json(promoNo.parseCodeMap(req.body?.rows)));
  router.put('/code-map', requireRole(...MAP_ADMIN), (req, res) => {
    const { rules, skipped } = promoNo.parseCodeMap(req.body?.rows);
    if (!rules.length) return res.status(400).json({ error: 'ไม่พบแถวรหัสที่ใช้ได้ในไฟล์ (ต้องเป็นชีต "รหัสใบโปรโมชั่น")' });
    const v = JSON.stringify({ rules, skipped, file: String(req.body?.file || '').slice(0, 200), imported_by: req.user.uid, imported_at: new Date().toISOString() });
    db.prepare(`INSERT INTO approval_workflow_templates (entity_type, levels_json, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(promoNo.CODE_MAP_ENTITY, v, req.user.uid);
    res.json(loadCodeMap(db));
  });
  // ทดสอบ: ?codes=30-NU-0005,30-NU-0006 → กฎ + เลขถัดไป
  router.get('/code-map/test', (req, res) => {
    const codes = String(req.query.codes || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean).slice(0, 500);
    res.json(promoNo.previewForCodes(db, codes));
  });
  // ออกเลขใหม่ให้เอกสารทั้งหมดตามตาราง — GET = ตัวอย่าง, POST = บันทึก (admin) + log เลขเดิม
  router.get('/renumber-all', (req, res) => res.json(promoNo.planRenumberAll(db)));
  router.post('/renumber-all', requireRole(...MAP_ADMIN), (req, res) => {
    try {
      db.exec('BEGIN IMMEDIATE');
      const plan = promoNo.planRenumberAll(db).filter(p => p.new_doc_no !== p.old_doc_no || p.new_promo_no !== p.old_promo_no);
      // ย้ายเลขเดิมออกก่อน (doc_no / promo_no เป็น unique — กันชนระหว่างสลับเลข) แล้วค่อยใส่เลขใหม่
      const tmp = db.prepare("UPDATE promo_draft_headers SET doc_no = 'TMP-' || draft_no, promo_no = NULL WHERE draft_no = ?");
      plan.forEach(p => tmp.run(p.draft_no));
      const up = db.prepare('UPDATE promo_draft_headers SET doc_no = ?, promo_no = ? WHERE draft_no = ?');
      plan.forEach(p => {
        up.run(p.new_doc_no, p.new_promo_no, p.draft_no);
        logDraft(db, p.draft_no, 'renumber', req.user, { from_doc_no: p.old_doc_no, to_doc_no: p.new_doc_no, from_promo_no: p.old_promo_no, to_promo_no: p.new_promo_no, reason: 'ออกเลขใหม่ตามตารางรหัสเอกสาร' });
      });
      db.exec('COMMIT');
      res.json({ changed: plan.length, plan });
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); res.status(400).json({ error: e.message }); }
  });

  router.get('/', (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    const orderClause = buildOrderBy(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by', 'created_at'], 'created_at');
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const vis = visibleSet(req);
    const visSql = vis ? `${where ? ' AND' : 'WHERE'} draft_no IN (SELECT value FROM json_each(?))` : '';
    const rows = db.prepare(`SELECT * FROM promo_draft_headers ${where}${visSql} ${orderClause} LIMIT ? OFFSET ?`)
      .all(...params, ...(vis ? [JSON.stringify([...vis])] : []), limit, offset).map(parseRow);
    // old_nos: เลขที่เดิมก่อนออกเลขใหม่ (log renumber) — ให้ค้นด้วยเลขเดิมได้ (2026-10-03)
    const old = new Map();
    db.prepare("SELECT draft_no, detail_json FROM promo_draft_logs WHERE action = 'renumber'").all().forEach(l => {
      const d = (() => { try { return JSON.parse(l.detail_json || '{}'); } catch { return {}; } })();
      const a = old.get(l.draft_no) || [];
      [d.from_doc_no, d.from_promo_no].forEach(x => { if (x && !a.includes(x)) a.push(x); });
      old.set(l.draft_no, a);
    });
    rows.forEach(r => { r.old_nos = old.get(r.draft_no) || []; });
    res.json(rows);
  });

  router.post('/', requireRole(...writeRoles), (req, res) => {
    const body = req.body || {};
    const draftNo = genDraftNo();
    try {
      db.exec('BEGIN IMMEDIATE');
      const docNo = nextDocNoFor(db, Array.isArray(body._branch_codes) ? body._branch_codes.map(String).slice(0, 5000) : []);
      const row = { ...body };
      validateChange(db, null, row, req.user);
      for (const f of JSON_FIELDS) if (row[f] !== undefined && typeof row[f] !== 'string') row[f] = JSON.stringify(row[f]);
      const cols = ['draft_no', 'doc_no', 'created_by', ...FIELDS.filter((f) => row[f] !== undefined)];
      const vals = cols.map((c) => {
        if (c === 'draft_no') return draftNo;
        if (c === 'doc_no') return docNo;
        if (c === 'created_by') return req.user.uid; // never trust client body for this — same reasoning as audit_log
        return row[c];
      });
      db.prepare(`INSERT INTO promo_draft_headers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
      const saved = parseRow(db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no = ?').get(draftNo));
      logDraft(db, draftNo, 'create', req.user, { doc_no: docNo, ...(body._copied_from ? { copied_from: String(body._copied_from).slice(0, 40) } : {}) });
      db.exec('COMMIT');
      res.status(201).json(saved);
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      res.status(400).json({ error: e.message });
    }
  });

  // (2026-09-23) เลือกผู้อนุมัติได้ทุกคนในระบบแล้ว — ผู้ที่ไม่มี role ฝ่ายขาย (writeRoles) PATCH ได้เฉพาะ
  // "การอนุมัติ/ไม่อนุมัติ" ของเอกสารที่ตัวเองเป็นผู้อนุมัติในขั้นปัจจุบันเท่านั้น (แก้ข้อมูลอื่นไม่ได้)
  // validateChange ยังเป็นตัวคำนวณผลอนุมัติจริงเสมอ (ไม่เชื่อ levels_json ที่ client ส่งมา)
  const APPROVAL_KEYS = new Set(['status', 'updated_by', 'levels_json', 'current_level', 'approvers_json', 'approval_comment', 'approval_line_verdicts', 'approval_line_verdict_notes']);
  const writerOrCurrentApprover = (req, res, next) => {
    if (writeRoles.includes(req.user.role)) return next();
    const deny = () => res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขเอกสารนี้' });
    if (Object.keys(req.body || {}).some(k => !APPROVAL_KEYS.has(k))) return deny();
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    if (!where) return deny();
    const targets = db.prepare(`SELECT status, levels_json, current_level FROM promo_draft_headers ${where}`).all(...params);
    const isApprover = t => {
      if (!['pending_approval', 'pending_exec_approval'].includes(t.status)) return false;
      let levels = [];
      try { levels = JSON.parse(t.levels_json || '[]'); } catch { return false; }
      return (levels[t.current_level || 0]?.approvers || []).some(a => a.uid === req.user.uid && a.status === 'pending');
    };
    return targets.length && targets.every(isApprover) ? next() : deny();
  };

  router.patch('/', writerOrCurrentApprover, (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    if (!where) return res.status(400).json({ error: 'update requires at least one filter' });
    try {
      db.exec('BEGIN IMMEDIATE');
      const vis = visibleSet(req);
      const targets = db.prepare(`SELECT * FROM promo_draft_headers ${where}`).all(...params).filter(t => !vis || vis.has(t.draft_no));
      if (!targets.length) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบเอกสาร หรือไม่มีสิทธิ์เห็นเอกสารนี้' }); }
      const saved = targets.map(target => applyHeaderChange(db, target, req.body || {}, req.user));
      db.exec('COMMIT');
      // แจ้งอีเมลผู้อนุมัติขั้นถัดไป / ผู้จัดทำเมื่อจบ (หลัง COMMIT, ไม่บล็อก response)
      const baseUrl = publicBaseUrl(req);
      targets.forEach((t, i) => promoMail.afterChange(db, parseRow({ ...t }), saved[i], baseUrl).catch(e => console.warn('[promoMail]', e.message)));
      res.json(saved);
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/', requireRole(...writeRoles), (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    if (!where) return res.status(400).json({ error: 'delete requires at least one filter' });
    const vis = visibleSet(req);
    const del = db.prepare(`SELECT draft_no, doc_no, promo_name, status FROM promo_draft_headers ${where}`).all(...params).filter(t => !vis || vis.has(t.draft_no));
    del.forEach(t => logDraft(db, t.draft_no, 'delete', req.user, { doc_no: t.doc_no, name: t.promo_name, status: t.status }));
    const delNo = db.prepare('DELETE FROM promo_draft_headers WHERE draft_no = ?');
    del.forEach(t => delNo.run(t.draft_no));
    res.status(204).end();
  });

  // ── ประวัติการดำเนินการ ──────────────────────────────────────────────────────────────
  router.get('/:draftNo/logs', (req, res) => {
    res.json(db.prepare('SELECT id, action, uid, name, detail_json, ts FROM promo_draft_logs WHERE draft_no = ? ORDER BY ts DESC, id DESC')
      .all(req.params.draftNo).map(r => ({ ...r, detail: (() => { try { return JSON.parse(r.detail_json || '{}'); } catch { return {}; } })() })));
  });

  const getRaw = no => db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no = ?').get(no);
  const pj = v => { try { return JSON.parse(v || 'null'); } catch { return null; } };
  const userName = uid => db.prepare('SELECT name FROM sc_users WHERE uid = ?').get(uid)?.name || uid;
  const mailLater = p => p.catch(e => console.warn('[promoMail]', e.message));

  // ── เรียกเอกสารกลับเพื่อแก้ไข (2026-09-30) — ผู้ส่งอนุมัติ/admin ตอนยังอนุมัติไม่ครบ → กลับเป็นร่าง ส่งใหม่เริ่มขั้น 1
  router.post('/:draftNo/recall', requireRole(...writeRoles), (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    if (t.created_by !== req.user.uid && !['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'เรียกกลับได้เฉพาะผู้ส่งอนุมัติ' });
    if (!['pending_approval', 'pending_exec_approval'].includes(t.status)) return res.status(400).json({ error: 'เรียกกลับได้เฉพาะเอกสารที่ยังรออนุมัติ' });
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    const levels = pj(t.levels_json) || [];
    const done = [...(pj(t.approval_history_json) || []), ...levels].flatMap((lv, i) => (lv.approvers || []).filter(a => a.ts)
      .map(a => ({ level: lv.label || `ขั้นที่ ${i + 1}`, name: a.name || a.uid, status: a.status, ts: a.ts })));
    const pendingUids = (levels[t.current_level || 0]?.approvers || []).filter(a => a.status === 'pending').map(a => a.uid);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE promo_draft_headers SET status = 'draft', levels_json = '[]', current_level = 0, approvers_json = '[]',
        approval_history_json = '[]', overlap_hold_json = NULL, updated_by = ?, updated_at = ? WHERE draft_no = ?`).run(req.user.uid, new Date().toISOString(), t.draft_no);
      logDraft(db, t.draft_no, 'recall', req.user, { note, from_status: t.status, approvals_done: done });
      db.exec('COMMIT');
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    mailLater(promoMail.notifyRecall(db, t, pendingUids, userName(req.user.uid), note));
    res.json(parseRow(getRaw(t.draft_no)));
  });

  // ── โปรซ้อน: Sales ยืนยันยกเลิกโปรเก่าครบ → เดินขั้นถัดไป (2026-10-06, ผู้ใช้ขอ) ───────────────────────────
  // GET = รายการซ้อนปัจจุบัน (คำนวณใหม่) · POST {confirm:[key], note} — ใบเคาะในระบบต้องยกเลิกจริงแล้ว,
  // ใบ Express ต้องติ๊กยืนยันครบทุกใบ (ระบบเขียน Express ไม่ได้) · ผู้สร้างเอกสาร หรือ admin เท่านั้น
  router.get('/:draftNo/overlap', (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    res.json({ hold: holdOf(t), current: overlapsFor(db, t) });
  });
  router.post('/:draftNo/overlap_clear', (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    if (t.created_by !== req.user.uid && !['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'ยืนยันได้เฉพาะผู้สร้างเอกสาร (Sales)' });
    const h = holdOf(t);
    if (!h || h.cleared_at) return res.status(400).json({ error: 'เอกสารนี้ไม่ได้รอยกเลิกโปรเก่าที่ซ้อน' });
    if (!['pending_approval', 'pending_exec_approval'].includes(t.status)) return res.status(400).json({ error: 'เอกสารไม่ได้อยู่ระหว่างรออนุมัติ' });
    const now = overlapsFor(db, t);
    const drafts = now.filter(o => o.kind === 'draft');
    if (drafts.length) return res.status(400).json({ error: `ยังมีใบเคาะในระบบที่ช่วงซ้อนและยังไม่ถูกยกเลิก: ${drafts.map(o => o.ref).join(', ')} — กรุณาขอยกเลิกให้อนุมัติก่อน`, current: now });
    const confirm = new Set((Array.isArray(req.body?.confirm) ? req.body.confirm : []).map(String));
    const missing = now.filter(o => o.kind === 'express' && !confirm.has(o.key));
    if (missing.length) return res.status(400).json({ error: `กรุณาติ๊กยืนยันว่ายกเลิกใน Express แล้วทุกใบ (ยังขาด ${missing.map(o => o.ref).join(', ')})`, current: now });
    const at = new Date().toISOString();
    const hold = { ...h, current_at_clear: now, confirmed: Object.fromEntries(now.map(o => [o.key, { by: req.user.uid, by_name: userName(req.user.uid), at, ref: o.ref }])),
      cleared_at: at, cleared_by: req.user.uid, cleared_by_name: userName(req.user.uid), note: String(req.body?.note || '').trim().slice(0, 1000) };
    let saved;
    try {
      db.exec('BEGIN IMMEDIATE');
      const fin = completeAfterHold(db, t);
      const set = { overlap_hold_json: JSON.stringify(hold), ...fin, updated_by: req.user.uid, updated_at: at };
      if (set.status === 'approved' && !t.promo_no) set.promo_no = nextPromoNoFor(db, t);
      const cols = Object.keys(set);
      db.prepare(`UPDATE promo_draft_headers SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE draft_no = ?`).run(...cols.map(c => set[c]), t.draft_no);
      logDraft(db, t.draft_no, 'overlap_clear', req.user, { docs: now.map(o => o.ref), note: hold.note, status_after: set.status || t.status });
      db.exec('COMMIT');
      saved = parseRow(getRaw(t.draft_no));
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    // แจ้งผู้อนุมัติลำดับถัดไป (หรือผู้จัดทำเมื่ออนุมัติครบ / ผู้บริหารเมื่อเข้าขั้นผู้บริหาร)
    const before = parseRow({ ...t });
    if (saved.status !== t.status) mailLater(promoMail.afterChange(db, before, saved, publicBaseUrl(req)));
    else mailLater(promoMail.notifyCurrentApprovers(db, saved, publicBaseUrl(req)));
    res.json(saved);
  });

  // ออกเลขใบเคาะใหม่เมื่อสาขาเปลี่ยนเป็นลูกค้าคนละรหัส (2026-10-03, ผู้ใช้ยืนยัน) — เฉพาะร่างที่ยังไม่เคยส่งอนุมัติ
  // client เรียกหลังบันทึกบรรทัดสินค้า · รหัสเดิมตรงกับกฎปัจจุบันอยู่แล้ว = ไม่ทำอะไร
  router.post('/:draftNo/renumber', requireRole(...writeRoles), (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const submitted = t.status !== 'draft' || db.prepare("SELECT 1 FROM promo_draft_logs WHERE draft_no = ? AND action = 'submit' LIMIT 1").get(t.draft_no);
    if (submitted) return res.json({ changed: false, doc_no: t.doc_no });
    const rule = ruleForCodes(loadCodeMap(db).rules, docCustCodes(db, t));
    const want = rule ? rule.kc : '', have = docNoBase(t.doc_no);
    if (want === have) return res.json({ changed: false, doc_no: t.doc_no });
    try {
      db.exec('BEGIN IMMEDIATE');
      const docNo = nextDocNoFor(db, docCustCodes(db, t), t.created_at);
      db.prepare('UPDATE promo_draft_headers SET doc_no = ? WHERE draft_no = ?').run(docNo, t.draft_no);
      logDraft(db, t.draft_no, 'renumber', req.user, { from_doc_no: t.doc_no, to_doc_no: docNo, reason: 'สาขาเปลี่ยนเป็นลูกค้าคนละรหัส' });
      db.exec('COMMIT');
      res.json({ changed: true, from: t.doc_no, doc_no: docNo });
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); res.status(400).json({ error: e.message }); }
  });

  // ── ยกเลิกทั้งใบ / รายสินค้า (2026-09-30) — Sales ขอ (หมายเหตุบังคับ) เลือกผู้อนุมัติเอง → manager ตัดสิน ────
  const CANCELABLE = ['pending_approval', 'pending_exec_approval', 'approved', 'keyed_to_express'];
  const CANCEL_APPROVER_ROLES = ['sales_manager', 'manager', 'admin', 'superadmin'];
  const DATE_FIELDS = ['start_date', 'due_date', 'cost_start_date', 'cost_end_date'];
  router.get('/cancel-approvers/list', (req, res) => {
    res.json(db.prepare(`SELECT uid, name, role, department, position FROM sc_users WHERE is_active = 1 AND role IN (${CANCEL_APPROVER_ROLES.map(() => '?').join(',')}) ORDER BY name`).all(...CANCEL_APPROVER_ROLES));
  });
  router.post('/:draftNo/cancel-request', requireRole(...writeRoles), (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    // เฉพาะเจ้าของเอกสาร (ผู้ส่งอนุมัติ) และ admin (2026-10-09, ผู้ใช้ขอ — เหมือน recall)
    if (t.created_by !== req.user.uid && !['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'ขอยกเลิกได้เฉพาะผู้ส่งอนุมัติ หรือ admin' });
    if (!CANCELABLE.includes(t.status)) return res.status(400).json({ error: 'ขอยกเลิกได้เฉพาะเอกสารที่ส่งอนุมัติแล้ว (ร่าง/ไม่อนุมัติ แก้ไขหรือลบได้เลย)' });
    if (pj(t.cancel_request_json)) return res.status(400).json({ error: 'มีคำขอยกเลิกที่รออนุมัติอยู่แล้ว' });
    const body = req.body || {};
    const reason = String(body.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ error: 'กรุณากรอกหมายเหตุการยกเลิก' });
    const scope = ['lines', 'all', 'dates'].includes(body.scope) ? body.scope : null;
    if (!scope) return res.status(400).json({ error: 'กรุณาเลือกยกเลิกทั้งใบ รายสินค้า หรือเปลี่ยนแปลงวันที่' });
    // เปลี่ยนแปลงวันที่ (2026-10-12, ผู้ใช้ขอ) — อนุมัติแล้วแก้วันที่ในเอกสารเดิม (เลขเดิม) เก็บเดิม→ใหม่ไว้ในประวัติ
    let datesFrom = null, datesTo = null, overlaps = [];
    if (scope === 'dates') {
      const inD = body.dates && typeof body.dates === 'object' ? body.dates : {};
      datesFrom = Object.fromEntries(DATE_FIELDS.map(f => [f, t[f] || null]));
      datesTo = { ...datesFrom };
      for (const f of DATE_FIELDS) {
        if (inD[f] === undefined) continue;
        const v = inD[f] === null || inD[f] === '' ? null : String(inD[f]).slice(0, 10);
        if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
        datesTo[f] = v;
      }
      if (!datesTo.start_date || !datesTo.due_date) return res.status(400).json({ error: 'กรุณาระบุวันเริ่มและวันสิ้นสุดโปร' });
      if (datesTo.start_date > datesTo.due_date) return res.status(400).json({ error: 'วันเริ่มโปรต้องไม่เกินวันสิ้นสุดโปร' });
      if (datesTo.cost_start_date && datesTo.cost_end_date && datesTo.cost_start_date > datesTo.cost_end_date) return res.status(400).json({ error: 'วันเริ่มทุนต้องไม่เกินวันสิ้นสุดทุน' });
      if (datesTo.cost_start_date && datesTo.cost_start_date > datesTo.start_date) return res.status(400).json({ error: 'วันที่เริ่มทุนต้องไม่หลังวันที่เริ่มโปร' });
      if (DATE_FIELDS.every(f => datesTo[f] === datesFrom[f])) return res.status(400).json({ error: 'วันที่ใหม่เหมือนวันที่เดิม — ไม่มีอะไรเปลี่ยน' });
      // โปรซ้อนในช่วงใหม่ — แสดงเตือนผู้อนุมัติเท่านั้น (ไม่บล็อก)
      overlaps = overlapsFor(db, { ...t, ...datesTo }).map(o => ({ kind: o.kind, ref: o.ref, start: o.start, due: o.due }));
    }
    const cancelled = new Set(pj(t.cancelled_skus_json) || []);
    const docSkus = [...new Set(db.prepare('SELECT sku FROM promo_drafts WHERE draft_no = ?').all(t.draft_no).map(r => r.sku).filter(Boolean))];
    let skus = [];
    if (scope === 'lines') {
      skus = [...new Set((Array.isArray(body.skus) ? body.skus : []).map(String))];
      if (!skus.length) return res.status(400).json({ error: 'กรุณาเลือกสินค้าที่ต้องการยกเลิก' });
      const bad = skus.filter(x => !docSkus.includes(x) || cancelled.has(x));
      if (bad.length) return res.status(400).json({ error: `สินค้าไม่อยู่ในเอกสารหรือยกเลิกไปแล้ว: ${bad.join(', ')}` });
    }
    const ap = db.prepare('SELECT uid, name, role, is_active FROM sc_users WHERE uid = ?').get(String(body.approver_uid || ''));
    if (!ap || !ap.is_active || !CANCEL_APPROVER_ROLES.includes(ap.role)) return res.status(400).json({ error: 'กรุณาเลือกผู้อนุมัติการยกเลิก (Sales Manager ขึ้นไป)' });
    if (ap.uid === req.user.uid) return res.status(400).json({ error: 'ผู้ขอยกเลิกเป็นผู้อนุมัติเองไม่ได้' });
    const rq = { id: genId('PCX'), scope, skus, reason, requested_by: req.user.uid, requested_by_name: userName(req.user.uid),
      requested_at: new Date().toISOString(), approver_uid: ap.uid, approver_name: ap.name || ap.uid, status_at_request: t.status,
      ...(scope === 'dates' ? { dates_from: datesFrom, dates_to: datesTo, overlaps } : {}) };
    db.prepare('UPDATE promo_draft_headers SET cancel_request_json = ?, updated_at = ? WHERE draft_no = ?').run(JSON.stringify(rq), rq.requested_at, t.draft_no);
    logDraft(db, t.draft_no, scope === 'dates' ? 'date_change_request' : 'cancel_request', req.user,
      { scope, skus, reason, approver: rq.approver_name, ...(scope === 'dates' ? { dates_from: datesFrom, dates_to: datesTo } : {}) });
    mailLater(promoMail.notifyCancelRequest(db, t, rq));
    res.json(parseRow(getRaw(t.draft_no)));
  });
  router.post('/:draftNo/cancel-decision', (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const rq = pj(t.cancel_request_json);
    if (!rq) return res.status(400).json({ error: 'ไม่มีคำขอยกเลิกที่รออนุมัติ' });
    if (req.user.uid !== rq.approver_uid && req.user.role !== 'superadmin') return res.status(403).json({ error: 'คุณไม่ใช่ผู้อนุมัติการยกเลิกของเอกสารนี้' });
    const approve = req.body?.approve === true || req.body?.approve === 'true';
    const now = new Date().toISOString();
    const d = { ...rq, result: approve ? 'approved' : 'rejected', decided_by: req.user.uid, decided_by_name: userName(req.user.uid),
      decided_at: now, manager_note: String(req.body?.note || '').trim().slice(0, 1000) };
    let status = t.status;
    let cancelled = pj(t.cancelled_skus_json) || [];
    const isDates = rq.scope === 'dates';
    if (approve && !isDates) {
      if (rq.scope === 'all') status = 'cancelled';
      else {
        cancelled = [...new Set([...cancelled, ...rq.skus])];
        const docSkus = [...new Set(db.prepare('SELECT sku FROM promo_drafts WHERE draft_no = ?').all(t.draft_no).map(r => r.sku).filter(Boolean))];
        if (docSkus.length && docSkus.every(x => cancelled.includes(x))) status = 'cancelled';
      }
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`UPDATE promo_draft_headers SET status = ?, cancel_request_json = NULL, cancel_history_json = ?, cancelled_skus_json = ?,
        updated_by = ?, updated_at = ? WHERE draft_no = ?`).run(status, JSON.stringify([...(pj(t.cancel_history_json) || []), d]),
        JSON.stringify(cancelled), req.user.uid, now, t.draft_no);
      // เปลี่ยนวันที่: หัวเอกสาร + ทุกบรรทัด (บรรทัดใช้ช่วงวันที่ของหัวเอกสารเสมอ) · สถานะ/เลขเอกสารไม่เปลี่ยน
      if (approve && isDates && rq.dates_to) {
        const to = rq.dates_to;
        db.prepare(`UPDATE promo_draft_headers SET ${DATE_FIELDS.map(f => `${f} = ?`).join(', ')} WHERE draft_no = ?`).run(...DATE_FIELDS.map(f => to[f] ?? null), t.draft_no);
        db.prepare('UPDATE promo_drafts SET start_date = ?, due_date = ?, updated_at = ? WHERE draft_no = ?').run(to.start_date, to.due_date, now, t.draft_no);
      }
      logDraft(db, t.draft_no, isDates ? (approve ? 'date_change_approve' : 'date_change_reject') : (approve ? 'cancel_approve' : 'cancel_reject'), req.user,
        { scope: rq.scope, skus: rq.skus, note: d.manager_note, status_after: status, ...(isDates ? { dates_from: rq.dates_from, dates_to: rq.dates_to } : {}) });
      db.exec('COMMIT');
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    mailLater(promoMail.notifyCancelDecision(db, t, d));
    res.json(parseRow(getRaw(t.draft_no)));
  });
  router.post('/:draftNo/cancel-withdraw', (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const rq = pj(t.cancel_request_json);
    if (!rq) return res.status(400).json({ error: 'ไม่มีคำขอยกเลิกที่รออนุมัติ' });
    if (req.user.uid !== rq.requested_by && req.user.role !== 'superadmin') return res.status(403).json({ error: 'ถอนคำขอได้เฉพาะผู้ขอ' });
    const now = new Date().toISOString();
    db.prepare('UPDATE promo_draft_headers SET cancel_request_json = NULL, cancel_history_json = ?, updated_at = ? WHERE draft_no = ?')
      .run(JSON.stringify([...(pj(t.cancel_history_json) || []), { ...rq, result: 'withdrawn', decided_by: req.user.uid, decided_at: now }]), now, t.draft_no);
    logDraft(db, t.draft_no, rq.scope === 'dates' ? 'date_change_withdraw' : 'cancel_withdraw', req.user, { scope: rq.scope, skus: rq.skus });
    res.json(parseRow(getRaw(t.draft_no)));
  });

  return router;
};
module.exports.applyHeaderChange = applyHeaderChange;
module.exports.parseRow = parseRow;
module.exports.publicBaseUrl = publicBaseUrl;
