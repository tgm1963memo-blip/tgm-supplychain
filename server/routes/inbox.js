'use strict';

const express = require('express');
const promoRoles = require('../lib/promoRoles');

// Inbox แจ้งเตือน (2026-10-12, ผู้ใช้ขอ) — กระดิ่งมุมขวาบนของแอป
//   ต้องทำ (actionable): ใบเคาะรอฉันอนุมัติ · คำขอยกเลิก/เปลี่ยนวันที่ที่เลือกฉัน · ใบเสนอราคารอฉันอนุมัติ · ใบอนุมัติแล้วรอคีย์ Express (ผู้มีสิทธิ์คีย์)
//   แจ้งผล (14 วันล่าสุด): ผลอนุมัติ/ไม่อนุมัติ/ยกเลิก/เปลี่ยนวันที่/คีย์แล้ว ของใบที่ฉันสร้าง (หรือเลขาที่สร้างแทน) — ไม่นับที่ฉันทำเอง
// อ่านแล้ว/ยังไม่อ่าน เก็บฝั่ง client (เวลาที่เปิดดูล่าสุด) — server คืนรายการพร้อม ts
const RESULT_ACTIONS = {
  approved_final: '✅ อนุมัติครบ', reject: '❌ ไม่อนุมัติ', recall: '↩️ ถูกเรียกกลับ', keyed: '⌨️ คีย์เข้า Express แล้ว',
  cancel_approve: '🚫 อนุมัติยกเลิก', cancel_reject: '❌ ไม่อนุมัติการยกเลิก',
  date_change_approve: '📅 อนุมัติเปลี่ยนวันที่', date_change_reject: '❌ ไม่อนุมัติเปลี่ยนวันที่',
};
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

function buildInbox(db, user) {
  const uid = user.uid;
  const items = [];
  const docNo = h => h.promo_no || h.doc_no || h.draft_no;
  const heads = db.prepare(`SELECT draft_no, doc_no, promo_no, promo_name, status, levels_json, current_level, cancel_request_json,
    created_by, created_by_actual, updated_at, keyed_at FROM promo_draft_headers WHERE status <> 'cancelled' OR cancel_request_json IS NOT NULL`).all();
  const nameOf = db.prepare('SELECT name FROM sc_users WHERE uid = ?');
  for (const h of heads) {
    if (['pending_approval', 'pending_exec_approval'].includes(h.status)) {
      const lv = (parse(h.levels_json) || [])[h.current_level || 0];
      if ((lv?.approvers || []).some(a => a.uid === uid && a.status === 'pending')) {
        items.push({ kind: 'promo_approve', key: `pa:${h.draft_no}:${h.current_level || 0}`, actionable: true, ts: h.updated_at,
          title: `รออนุมัติใบเคาะ ${docNo(h)}`, sub: `${h.promo_name || ''} · ${lv.label || `ขั้นที่ ${(h.current_level || 0) + 1}`}${h.status === 'pending_exec_approval' ? ' (ผู้บริหาร)' : ''} · ผู้สร้าง ${nameOf.get(h.created_by)?.name || h.created_by || '—'}`,
          draft_no: h.draft_no });
      }
    }
    const rq = parse(h.cancel_request_json);
    if (rq && rq.approver_uid === uid) {
      items.push({ kind: 'promo_cancel', key: `pc:${rq.id || h.draft_no}`, actionable: true, ts: rq.requested_at,
        title: `${rq.scope === 'dates' ? 'ขอเปลี่ยนวันที่' : 'ขอยกเลิก'} ${docNo(h)}`, sub: `${h.promo_name || ''} · ผู้ขอ ${rq.requested_by_name || rq.requested_by} · ${rq.reason || ''}`,
        draft_no: h.draft_no });
    }
  }
  if (promoRoles.isKeyer(db, user)) {
    for (const h of heads.filter(x => x.status === 'approved')) {
      items.push({ kind: 'promo_key', key: `pk:${h.draft_no}`, actionable: true, ts: h.updated_at,
        title: `อนุมัติแล้ว รอคีย์ Express ${docNo(h)}`, sub: h.promo_name || '', draft_no: h.draft_no });
    }
  }
  try {
    db.prepare(`SELECT id, doc_no, customer_name, submitted_at, updated_at, sales_name FROM quotation_headers WHERE status = 'pending_approval' AND approver_uid = ?`)
      .all(uid).forEach(q => items.push({ kind: 'quotation_approve', key: `qa:${q.id}:${q.submitted_at || ''}`, actionable: true, ts: q.submitted_at || q.updated_at,
        title: `รออนุมัติใบเสนอราคา ${q.doc_no || ''}`.trim(), sub: `${q.customer_name || ''}${q.sales_name ? ' · ' + q.sales_name : ''}`, quotation_id: q.id }));
  } catch { /* ยังไม่มีตารางใบเสนอราคา */ }
  // พัฒนาสินค้าใหม่ (NPD, 2026-11-25) — ขั้นปัจจุบันเป็นหน้าที่ของฉัน (หัวหน้า/พี่หลิน/คุณโอ/RD/บัญชี/Sales เจ้าของงาน)
  try {
    const { awaitingFor, STATUS } = require('./npdProjects');
    for (const p of awaitingFor(db, uid)) {
      const names = (parse(p.items_json) || []).map(it => it.name).filter(Boolean).join(', ');
      items.push({ kind: 'npd_step', key: `npd:${p.id}:${p.status}:${p.status_at}`, actionable: true, ts: p.status_at,
        title: `NPD ${p.doc_no || p.legacy_no || ''} · ${STATUS[p.status] || p.status}`.replace(/\s+/g, ' '), sub: `${p.cust_name || ''}${names ? ' · ' + names : ''} · ผู้ขอ ${p.created_by_name || p.created_by}`,
        npd_id: p.id });
    }
  } catch { /* ยังไม่มีตาราง NPD */ }

  // ผลของใบที่ฉันสร้าง (หรือสร้างแทน) 14 วันล่าสุด
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const mine = new Map(heads.filter(h => h.created_by === uid || h.created_by_actual === uid).map(h => [h.draft_no, h]));
  if (mine.size) {
    db.prepare(`SELECT id, draft_no, action, uid, name, detail_json, ts FROM promo_draft_logs
      WHERE ts >= ? AND action IN (${Object.keys(RESULT_ACTIONS).map(() => '?').join(',')}) AND draft_no IN (SELECT value FROM json_each(?))
      ORDER BY ts DESC LIMIT 100`).all(since, ...Object.keys(RESULT_ACTIONS), JSON.stringify([...mine.keys()]))
      .filter(l => l.uid !== uid)
      .forEach(l => {
        const h = mine.get(l.draft_no);
        const d = parse(l.detail_json) || {};
        items.push({ kind: 'promo_result', key: `pr:${l.id}`, actionable: false, ts: l.ts,
          title: `${RESULT_ACTIONS[l.action]} — ${docNo(h)}`, sub: `${h.promo_name || ''}${l.name ? ' · โดย ' + l.name : ''}${d.comment || d.note ? ' · ' + (d.comment || d.note) : ''}`,
          draft_no: l.draft_no });
      });
  }
  items.sort((a, b) => (b.actionable - a.actionable) || String(b.ts || '').localeCompare(String(a.ts || '')));
  return { items, actionable: items.filter(i => i.actionable).length };
}

module.exports = function inboxRoutes(db) {
  const router = express.Router();
  router.get('/', (req, res) => {
    try { res.json(buildInbox(db, req.user)); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return router;
};
module.exports.buildInbox = buildInbox;
