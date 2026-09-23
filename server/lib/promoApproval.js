const workflow = require('../../shared/approval-workflow');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const needsExec = row => ['is_npd', 'has_off_contract_cost', 'has_marketing_cost'].some(k => Number(row[k]) === 1 || row[k] === true);
function template(db, entity, allowEmpty = false) {
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type=?').get(entity);
  const levels = row ? parse(row.levels_json) : [];
  const error = workflow.validate(levels, db.prepare('SELECT uid,is_active FROM sc_users').all(), allowEmpty);
  if (error) throw new Error(error + ' กรุณาให้แอดมินตั้งค่าที่เมนูตั้งค่าเส้นทางอนุมัติ');
  return levels.map(lv => ({ ...lv, approvers: lv.approvers.map(a => ({ ...a, status: 'pending', comment: '', ts: null })) }));
}
// ลายเซ็นประจำตัว (user_signatures) ของผู้อนุมัติ ณ ตอนกด — snapshot ลง approver entry ไม่ผูกกับรูปปัจจุบัน
function signatureOf(db, uid) {
  try { return db.prepare('SELECT image FROM user_signatures WHERE uid=?').get(uid)?.image || null; }
  catch { return null; }
}
function stampSignature(db, levels, current, uid) {
  const actor = levels[current]?.approvers?.find(a => a.uid === uid);
  if (actor && actor.status === 'approved') actor.signature = signatureOf(db, uid);
}
function history(old) {
  try { return parse(old.approval_history_json || '[]') || []; } catch { return []; }
}
function validateChange(db, old, change, user) {
  // ประวัติขั้นอนุมัติเขียนโดย server เท่านั้น
  if (change.approval_history_json !== undefined) throw new Error('ไม่สามารถแก้ข้อมูลขั้นอนุมัติโดยตรง');
  // ความเห็นผู้อนุมัติ (ไม่ใช่คอลัมน์ — เก็บลง approver entry ผ่าน workflow.advance)
  const comment = String(change.approval_comment || '').slice(0, 1000);
  delete change.approval_comment;
  const next = { ...old, ...change };
  const assign = (levels, current = 0) => Object.assign(change, { levels_json: JSON.stringify(levels), current_level: current, approvers_json: JSON.stringify(levels.flatMap(l => l.approvers)) });
  if (!old) {
    if (next.status && next.status !== 'draft') throw new Error('ต้องบันทึกร่างก่อนส่งอนุมัติ');
    assign([]);
    return;
  }
  const status = change.status;
  const active = ['pending_approval', 'pending_exec_approval'].includes(old.status);
  if (active && ['is_npd','has_off_contract_cost','has_marketing_cost'].some(k => change[k] !== undefined && Number(change[k]) !== Number(old[k]))) throw new Error('ไม่สามารถเปลี่ยนเงื่อนไขระหว่างรออนุมัติ');
  if (status === 'pending_approval' && ['draft', 'rejected'].includes(old.status)) {
    if (needsExec(next)) template(db, 'promo_draft_exec');
    assign(template(db, 'promo_draft', true));
    change.approval_history_json = '[]'; // ส่งอนุมัติรอบใหม่ เริ่มประวัติใหม่
    return;
  }
  if (active && (status || change.levels_json !== undefined || change.current_level !== undefined || change.approvers_json !== undefined)) {
    const levels = parse(old.levels_json);
    let result;
    if (!levels.length && old.status === 'pending_approval') {
      if (!['manager', 'sales_manager', 'admin', 'superadmin'].includes(user.role)) throw new Error('คุณไม่มีสิทธิ์อนุมัติ');
      result = { levels: [], current: 0, complete: true, rejected: status === 'rejected' };
      // ไม่มี route: บันทึกผู้กดอนุมัติไว้ในประวัติ ให้เอกสารยังแสดงชื่อ/เวลา/ลายเซ็นได้
      if (!result.rejected) {
        const name = db.prepare('SELECT name FROM sc_users WHERE uid=?').get(user.uid)?.name || user.name || user.uid;
        change.approval_history_json = JSON.stringify([...history(old), { label: 'ผู้อนุมัติ', mode: 'any',
          approvers: [{ uid: user.uid, name, status: 'approved', comment, ts: new Date().toISOString(), signature: signatureOf(db, user.uid) }] }]);
      }
    } else {
      const error = workflow.validate(levels, db.prepare('SELECT uid,is_active FROM sc_users').all());
      if (error) throw new Error(error);
      result = workflow.advance(levels, old.current_level, user.uid, status !== 'rejected', comment);
      stampSignature(db, result.levels, old.current_level, user.uid);
    }
    assign(result.levels, result.current);
    if (result.rejected) change.status = 'rejected';
    else if (!result.complete) change.status = old.status;
    else if (old.status === 'pending_approval' && needsExec(old)) {
      // เก็บขั้นปกติที่ผ่านแล้ว (ชื่อ/เวลา/ลายเซ็น) ไว้ก่อนแทนที่ levels_json ด้วยขั้นผู้บริหาร
      change.approval_history_json = JSON.stringify([...(change.approval_history_json ? parse(change.approval_history_json) : history(old)), ...result.levels]);
      assign(template(db, 'promo_draft_exec'));
      change.status = 'pending_exec_approval';
    } else change.status = 'approved';
    return;
  }
  if (status && status !== old.status && !(old.status === 'approved' && status === 'keyed_to_express') && !(old.status === 'rejected' && status === 'draft')) throw new Error('ไม่สามารถเปลี่ยนสถานะข้ามขั้นอนุมัติ');
  if (['levels_json', 'current_level', 'approvers_json'].some(k => change[k] !== undefined)) throw new Error('ไม่สามารถแก้ข้อมูลขั้นอนุมัติโดยตรง');
}
module.exports = { validateChange, template };
