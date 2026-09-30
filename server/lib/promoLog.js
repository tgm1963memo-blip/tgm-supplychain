// ประวัติการดำเนินการของใบเคาะราคา/ใบโปร (2026-09-30, ผู้ใช้ขอ "ทุกการดำเนินการให้เก็บเป็น log")
// เขียนฝั่ง server เท่านั้น (client ส่ง log เองไม่ได้) — promo_draft_logs เก็บต่อเอกสาร (ไม่มี FK: เอกสารถูกลบแล้ว log ยังอยู่)
// + เขียน audit_log เดิมคู่กัน (action PROMO_<ACTION>) ให้หน้า Audit Log รวมเห็นด้วย
const parse = v => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return null; } };

function nameOf(db, uid) {
  try { return db.prepare('SELECT name FROM sc_users WHERE uid = ?').get(uid)?.name || uid; } catch { return uid; }
}

function logDraft(db, draftNo, action, user, detail = {}) {
  const uid = user?.uid || 'system';
  const detailJson = JSON.stringify(detail || {});
  db.prepare('INSERT INTO promo_draft_logs (draft_no, action, uid, name, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(draftNo, action, uid, user?.name || nameOf(db, uid), detailJson);
  try {
    db.prepare('INSERT INTO audit_log (uid, role, action, target, detail) VALUES (?, ?, ?, ?, ?)')
      .run(uid, user?.role || null, 'PROMO_' + action.toUpperCase(), draftNo, detailJson);
  } catch (_) { /* audit_log เป็นส่วนเสริม — ไม่ให้ล้มการบันทึกหลัก */ }
}

// ฟิลด์ที่ผู้ใช้แก้ในเอกสาร (สำหรับ log "แก้ไข") — ตัดฟิลด์ระบบ/ขั้นอนุมัติออก
const SYSTEM_FIELDS = new Set(['updated_by', 'updated_at', 'levels_json', 'current_level', 'approvers_json', 'approval_history_json', 'status', 'promo_no', 'route_name']);
function changedFields(before, after) {
  return Object.keys(after || {}).filter(k => !SYSTEM_FIELDS.has(k) && k in (before || {}) &&
    JSON.stringify(parse(before[k]) ?? before[k] ?? null) !== JSON.stringify(parse(after[k]) ?? after[k] ?? null));
}

// สรุป log จากการเปลี่ยนหัวเอกสาร 1 ครั้ง (PATCH ปกติ / อนุมัติผ่านอีเมล) — before/after = row ก่อน/หลัง (parse แล้วหรือไม่ก็ได้)
function logHeaderChange(db, before, after, user, channel = 'system') {
  const b = before || {}, a = after || {};
  const bl = parse(b.levels_json) || [], al = parse(a.levels_json) || [];
  const pending = ['pending_approval', 'pending_exec_approval'];
  if (['draft', 'rejected'].includes(b.status || 'draft') && a.status === 'pending_approval') {
    logDraft(db, a.draft_no, 'submit', user, { route: a.route_name || 'มาตรฐาน', levels: al.map(l => l.label || '') });
    return;
  }
  if (pending.includes(b.status)) {
    // ผลการอนุมัติของผู้ใช้คนนี้ = approver entry ที่มี ts ใหม่ (ไม่มีใน before) — หาทั้ง levels และ history
    // (ผ่านขั้นปกติครบแล้วขึ้นขั้นผู้บริหาร ขั้นปกติถูกย้ายไป approval_history_json)
    const idx = b.current_level || 0;
    const entries = x => [...(parse(x.approval_history_json) || []), ...(parse(x.levels_json) || [])]
      .flatMap(lv => (lv.approvers || []).map(ap => ({ lv, ap })));
    const seen = new Set(entries(b).filter(e => e.ap.ts).map(e => `${e.ap.uid}|${e.ap.ts}`));
    const hit = entries(a).find(e => e.ap.uid === user?.uid && e.ap.ts && !seen.has(`${e.ap.uid}|${e.ap.ts}`));
    const actor = hit?.ap, lvAfter = hit?.lv;
    if (actor && actor.status !== 'pending') {
      const verdicts = actor.line_verdicts ? Object.values(actor.line_verdicts) : [];
      logDraft(db, a.draft_no, actor.status === 'approved' ? 'approve' : 'reject', user, {
        stage: b.status === 'pending_exec_approval' ? 'ผู้บริหาร' : 'ปกติ', level: idx + 1, label: lvAfter?.label || '',
        comment: actor.comment || '', channel,
        ...(verdicts.length ? { verdicts: { profit: verdicts.filter(v => v === 'profit').length, loss: verdicts.filter(v => v === 'loss').length } } : {}),
      });
    }
    // ขั้นที่ถูกข้าม (เฉพาะเมื่อมีรายการขาดทุน แต่ไม่มีขาดทุน)
    al.forEach((lv, i) => { if (lv.skipped && !bl[i]?.skipped) logDraft(db, a.draft_no, 'skip_level', { uid: 'system', name: 'ระบบ' }, { level: i + 1, label: lv.label || '', reason: 'ไม่มีรายการขาดทุน' }); });
    if (b.status === 'pending_approval' && a.status === 'pending_exec_approval') logDraft(db, a.draft_no, 'escalate_exec', { uid: 'system', name: 'ระบบ' }, {});
    if (a.status === 'approved' && b.status !== 'approved') logDraft(db, a.draft_no, 'approved_final', { uid: 'system', name: 'ระบบ' }, { promo_no: a.promo_no || '' });
    return;
  }
  if (b.status === 'approved' && a.status === 'keyed_to_express') { logDraft(db, a.draft_no, 'keyed', user, {}); return; }
  if (b.status === 'rejected' && a.status === 'draft') { logDraft(db, a.draft_no, 'reopen', user, {}); }
  const fields = changedFields(b, a);
  if (fields.length) logDraft(db, a.draft_no, 'edit', user, { fields });
}

module.exports = { logDraft, logHeaderChange, changedFields };
