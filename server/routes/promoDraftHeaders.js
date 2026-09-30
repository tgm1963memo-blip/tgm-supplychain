const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWhere, buildOrderBy } = require('../lib/pgQuery');
const { genId } = require('../lib/crud');
const { validateChange } = require('../lib/promoApproval');
const promoMail = require('../lib/promoApprovalMail');
const { nextPromoNoFor, previewForCorp } = require('../lib/promoNumber');
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
  'cancel_request_json', 'cancel_history_json', 'cancelled_skus_json'];

// FIXED (2026-09-13, /code-review): used to redefine its own copy of lib/crud.js's genId here —
// same algorithm, byte-for-byte, kept in sync by hand across 3 files. Import it instead.
function genDraftNo() {
  return genId('PMD');
}

// พ.ศ. ปัจจุบัน + เลขวิ่ง 4 หลักต่อปี เช่น PC2569-0001 — คำนวณจาก MAX ของเลขวิ่งปีเดียวกันที่มีอยู่ +1
// ภายใน request เดียวกับ insert; node:sqlite (DatabaseSync) เขียนได้ทีละ connection อยู่แล้ว (single
// writer เสมอ ไม่มี concurrent write จริงจากหลาย process) จึงไม่มี race ระหว่าง SELECT MAX กับ INSERT
// แม้ไม่ได้ห่อ BEGIN/COMMIT ชัดเจน — ปลอดภัยกว่าการทำ sequence table แยกที่ซับซ้อนเกินจำเป็นสำหรับเคสนี้
function nextDocNo(db) {
  const year = new Date().getFullYear() + 543;
  const prefix = `PC${year}-`;
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(doc_no, LENGTH(?) + 1) AS INTEGER)) AS maxN
    FROM promo_draft_headers WHERE doc_no LIKE ?
  `).get(prefix, `${prefix}%`);
  const next = (row?.maxN || 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

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
    body.promo_no = nextPromoNoFor(db, target);
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

  // ตัวอย่างเลขที่ใบโปรถัดไปของกลุ่มลูกค้า (หน้าตั้งค่า) — ?corp=โลตัส → { prefix, source, next }
  router.get('/promo-no-preview', (req, res) => {
    const corps = [].concat(req.query.corp || []).map(String).filter(Boolean).slice(0, 50);
    res.json(corps.map(c => previewForCorp(db, c)));
  });

  router.get('/', (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    const orderClause = buildOrderBy(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by', 'created_at'], 'created_at');
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const rows = db.prepare(`SELECT * FROM promo_draft_headers ${where} ${orderClause} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(parseRow);
    res.json(rows);
  });

  router.post('/', requireRole(...writeRoles), (req, res) => {
    const body = req.body || {};
    const draftNo = genDraftNo();
    try {
      db.exec('BEGIN IMMEDIATE');
      const docNo = nextDocNo(db);
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
  const APPROVAL_KEYS = new Set(['status', 'updated_by', 'levels_json', 'current_level', 'approvers_json', 'approval_comment', 'approval_line_verdicts']);
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
      const targets = db.prepare(`SELECT * FROM promo_draft_headers ${where}`).all(...params);
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
    db.prepare(`SELECT draft_no, doc_no, promo_name, status FROM promo_draft_headers ${where}`).all(...params)
      .forEach(t => logDraft(db, t.draft_no, 'delete', req.user, { doc_no: t.doc_no, name: t.promo_name, status: t.status }));
    db.prepare(`DELETE FROM promo_draft_headers ${where}`).run(...params);
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
        approval_history_json = '[]', updated_by = ?, updated_at = ? WHERE draft_no = ?`).run(req.user.uid, new Date().toISOString(), t.draft_no);
      logDraft(db, t.draft_no, 'recall', req.user, { note, from_status: t.status, approvals_done: done });
      db.exec('COMMIT');
    } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); return res.status(400).json({ error: e.message }); }
    mailLater(promoMail.notifyRecall(db, t, pendingUids, userName(req.user.uid), note));
    res.json(parseRow(getRaw(t.draft_no)));
  });

  // ── ยกเลิกทั้งใบ / รายสินค้า (2026-09-30) — Sales ขอ (หมายเหตุบังคับ) เลือกผู้อนุมัติเอง → manager ตัดสิน ────
  const CANCELABLE = ['pending_approval', 'pending_exec_approval', 'approved', 'keyed_to_express'];
  const CANCEL_APPROVER_ROLES = ['sales_manager', 'manager', 'admin', 'superadmin'];
  router.get('/cancel-approvers/list', (req, res) => {
    res.json(db.prepare(`SELECT uid, name, role, department, position FROM sc_users WHERE is_active = 1 AND role IN (${CANCEL_APPROVER_ROLES.map(() => '?').join(',')}) ORDER BY name`).all(...CANCEL_APPROVER_ROLES));
  });
  router.post('/:draftNo/cancel-request', requireRole(...writeRoles), (req, res) => {
    const t = getRaw(req.params.draftNo);
    if (!t) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    if (!CANCELABLE.includes(t.status)) return res.status(400).json({ error: 'ขอยกเลิกได้เฉพาะเอกสารที่ส่งอนุมัติแล้ว (ร่าง/ไม่อนุมัติ แก้ไขหรือลบได้เลย)' });
    if (pj(t.cancel_request_json)) return res.status(400).json({ error: 'มีคำขอยกเลิกที่รออนุมัติอยู่แล้ว' });
    const body = req.body || {};
    const reason = String(body.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ error: 'กรุณากรอกหมายเหตุการยกเลิก' });
    const scope = body.scope === 'lines' ? 'lines' : body.scope === 'all' ? 'all' : null;
    if (!scope) return res.status(400).json({ error: 'กรุณาเลือกยกเลิกทั้งใบ หรือรายสินค้า' });
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
      requested_at: new Date().toISOString(), approver_uid: ap.uid, approver_name: ap.name || ap.uid, status_at_request: t.status };
    db.prepare('UPDATE promo_draft_headers SET cancel_request_json = ?, updated_at = ? WHERE draft_no = ?').run(JSON.stringify(rq), rq.requested_at, t.draft_no);
    logDraft(db, t.draft_no, 'cancel_request', req.user, { scope, skus, reason, approver: rq.approver_name });
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
    if (approve) {
      if (rq.scope === 'all') status = 'cancelled';
      else {
        cancelled = [...new Set([...cancelled, ...rq.skus])];
        const docSkus = [...new Set(db.prepare('SELECT sku FROM promo_drafts WHERE draft_no = ?').all(t.draft_no).map(r => r.sku).filter(Boolean))];
        if (docSkus.length && docSkus.every(x => cancelled.includes(x))) status = 'cancelled';
      }
    }
    db.prepare(`UPDATE promo_draft_headers SET status = ?, cancel_request_json = NULL, cancel_history_json = ?, cancelled_skus_json = ?,
      updated_by = ?, updated_at = ? WHERE draft_no = ?`).run(status, JSON.stringify([...(pj(t.cancel_history_json) || []), d]),
      JSON.stringify(cancelled), req.user.uid, now, t.draft_no);
    logDraft(db, t.draft_no, approve ? 'cancel_approve' : 'cancel_reject', req.user, { scope: rq.scope, skus: rq.skus, note: d.manager_note, status_after: status });
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
    logDraft(db, t.draft_no, 'cancel_withdraw', req.user, { scope: rq.scope, skus: rq.skus });
    res.json(parseRow(getRaw(t.draft_no)));
  });

  return router;
};
module.exports.applyHeaderChange = applyHeaderChange;
module.exports.parseRow = parseRow;
module.exports.publicBaseUrl = publicBaseUrl;
