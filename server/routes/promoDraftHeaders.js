const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildWhere, buildOrderBy } = require('../lib/pgQuery');
const { genId } = require('../lib/crud');
const { validateChange } = require('../lib/promoApproval');

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
const JSON_FIELDS = ['other_costs_json', 'levels_json', 'approvers_json', 'item_type'];

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

// เลขที่ "ใบโปรโมชั่น" (2026-09-16) — ชุดเลขแยกจาก doc_no (PC-series) ออกให้ครั้งเดียวตอนอนุมัติผ่านขั้น
// สุดท้ายจริง (ไม่ใช่ตอนสร้างร่าง) เอกสารที่เคยมี promo_no แล้วจะไม่ออกซ้ำ (idempotent ต่อการ PATCH ซ้ำ)
// เหตุผลเดียวกับ nextDocNo() ข้างบน — single-writer node:sqlite connection ไม่มี race ระหว่าง SELECT MAX
// กับ UPDATE แม้ไม่ได้ห่อ BEGIN/COMMIT ชัดเจน
function nextPromoNo(db) {
  const year = new Date().getFullYear() + 543;
  const prefix = `PM${year}-`;
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(promo_no, LENGTH(?) + 1) AS INTEGER)) AS maxN
    FROM promo_draft_headers WHERE promo_no LIKE ?
  `).get(prefix, `${prefix}%`);
  const next = (row?.maxN || 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
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
      db.exec('COMMIT');
      res.status(201).json(saved);
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/', requireRole(...writeRoles), (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    if (!where) return res.status(400).json({ error: 'update requires at least one filter' });
    try {
      db.exec('BEGIN IMMEDIATE');
      const targets = db.prepare(`SELECT * FROM promo_draft_headers ${where}`).all(...params);
      const saved = [];
      for (const target of targets) {
        const body = { ...(req.body || {}), updated_by: req.user.uid, updated_at: new Date().toISOString() };
        validateChange(db, target, body, req.user);
        for (const f of JSON_FIELDS) if (body[f] !== undefined && typeof body[f] !== 'string') body[f] = JSON.stringify(body[f]);
        const cols = [...FIELDS.filter(f => body[f] !== undefined), 'updated_at'];
        if (body.status === 'approved' && !target.promo_no) {
          body.promo_no = nextPromoNo(db);
          cols.push('promo_no');
        }
        db.prepare(`UPDATE promo_draft_headers SET ${cols.map(c => `${c} = ?`).join(',')} WHERE draft_no = ?`)
          .run(...cols.map(c => body[c]), target.draft_no);
        saved.push(parseRow(db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no=?').get(target.draft_no)));
      }
      db.exec('COMMIT');
      res.json(saved);
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/', requireRole(...writeRoles), (req, res) => {
    const { where, params } = buildWhere(req.query, [...FIELDS, 'draft_no', 'doc_no', 'created_by']);
    if (!where) return res.status(400).json({ error: 'delete requires at least one filter' });
    db.prepare(`DELETE FROM promo_draft_headers ${where}`).run(...params);
    res.status(204).end();
  });

  return router;
};
