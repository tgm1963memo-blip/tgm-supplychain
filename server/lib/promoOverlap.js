'use strict';

// ช่วงเวลาโปรซ้อน (2026-10-06, ผู้ใช้ขอ) — ตรรกะเดียวกับ _draftCheckOverlapNow() ใน index.html แต่คำนวณที่ server
// เพื่อใช้กับขั้น "Sales ยกเลิกโปรเก่าที่ซ้อนก่อนส่งต่อผู้อนุมัติลำดับถัดไป" (lib/promoApproval.js)
// ซ้อน = SKU เดียวกัน + รหัสสาขาเดียวกัน + ช่วงวันที่ทับกับช่วงของหัวเอกสาร
//   · ใบโปรใน Express (promo_docs) — ระบบเขียน Express ไม่ได้ Sales ยืนยันการยกเลิกเอง (ติ๊กรายใบ)
//     ถ้าแก้วันสิ้นสุดใบเก่าใน Express จนไม่ทับแล้ว รอบ sync ถัดไปจะหลุดจากรายการเอง
//   · ใบเคาะในระบบที่ส่งอนุมัติ/อนุมัติแล้ว (ไม่นับร่าง/ไม่อนุมัติ/ยกเลิก และ SKU ที่ยกเลิกไปแล้ว) — ต้องยกเลิกจริงในระบบ
const ACTIVE_DRAFT = ['pending_approval', 'pending_exec_approval', 'approved', 'keyed_to_express'];
const pj = (v, d) => { if (v && typeof v !== 'string') return v; try { return JSON.parse(v || 'null') ?? d; } catch { return d; } };
const inList = n => Array.from({ length: n }, () => '?').join(',');

function overlapsFor(db, header) {
  const start = header.start_date, due = header.due_date;
  if (!start || !due) return [];
  const cancelled = new Set(pj(header.cancelled_skus_json, []));
  const lines = db.prepare('SELECT DISTINCT cust_code, sku FROM promo_drafts WHERE draft_no = ?').all(header.draft_no)
    .filter(l => l.cust_code && l.sku && !cancelled.has(l.sku));
  if (!lines.length) return [];
  const pairs = new Set(lines.map(l => `${l.cust_code}|${l.sku}`));
  const custs = [...new Set(lines.map(l => l.cust_code))], skus = [...new Set(lines.map(l => l.sku))];
  const out = new Map();
  const add = (key, base, cust, sku) => {
    const o = out.get(key) || { ...base, skus: [], branches: [] };
    if (!o.skus.includes(sku)) o.skus.push(sku);
    if (!o.branches.includes(cust)) o.branches.push(cust);
    out.set(key, o);
  };
  for (let i = 0; i < custs.length; i += 400) {
    const part = custs.slice(i, i + 400);
    db.prepare(`SELECT sonum, doc_ref, company, cust_code, sku, start_date, due_date FROM promo_docs
      WHERE cust_code IN (${inList(part.length)}) AND sku IN (${inList(skus.length)}) AND due_date >= ? AND start_date <= ?`)
      .all(...part, ...skus, start, due).forEach(r => {
        if (!pairs.has(`${r.cust_code}|${r.sku}`)) return;
        const ref = String(r.doc_ref || '').trim() || String(r.sonum || '').trim();
        add(`doc:${ref}|${r.start_date}|${r.due_date}`, { kind: 'express', ref, company: r.company || '', start: r.start_date, due: r.due_date }, r.cust_code, r.sku);
      });
    db.prepare(`SELECT d.draft_no, d.cust_code, d.sku, COALESCE(d.start_date, h.start_date) AS start_date, COALESCE(d.due_date, h.due_date) AS due_date,
        h.doc_no, h.promo_no, h.status, h.cancelled_skus_json
      FROM promo_drafts d JOIN promo_draft_headers h ON h.draft_no = d.draft_no
      WHERE d.draft_no <> ? AND h.status IN (${inList(ACTIVE_DRAFT.length)})
        AND d.cust_code IN (${inList(part.length)}) AND d.sku IN (${inList(skus.length)})`)
      .all(header.draft_no, ...ACTIVE_DRAFT, ...part, ...skus).forEach(r => {
        if (!pairs.has(`${r.cust_code}|${r.sku}`)) return;
        if (!r.start_date || !r.due_date || !(r.due_date >= start && r.start_date <= due)) return;
        if (pj(r.cancelled_skus_json, []).includes(r.sku)) return;
        add(`draft:${r.draft_no}`, { kind: 'draft', ref: r.promo_no || r.doc_no || r.draft_no, draft_no: r.draft_no, status: r.status, start: r.start_date, due: r.due_date }, r.cust_code, r.sku);
      });
  }
  return [...out.entries()].map(([key, o]) => ({ key, ...o })).sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

module.exports = { overlapsFor };
