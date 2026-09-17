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
function validateChange(db, old, change, user) {
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
    return;
  }
  if (active && (status || change.levels_json !== undefined || change.current_level !== undefined || change.approvers_json !== undefined)) {
    const levels = parse(old.levels_json);
    let result;
    if (!levels.length && old.status === 'pending_approval') {
      if (!['manager', 'sales_manager', 'admin', 'superadmin'].includes(user.role)) throw new Error('คุณไม่มีสิทธิ์อนุมัติ');
      result = { levels: [], current: 0, complete: true, rejected: status === 'rejected' };
    } else {
      const error = workflow.validate(levels, db.prepare('SELECT uid,is_active FROM sc_users').all());
      if (error) throw new Error(error);
      result = workflow.advance(levels, old.current_level, user.uid, status !== 'rejected');
    }
    assign(result.levels, result.current);
    if (result.rejected) change.status = 'rejected';
    else if (!result.complete) change.status = old.status;
    else if (old.status === 'pending_approval' && needsExec(old)) {
      assign(template(db, 'promo_draft_exec'));
      change.status = 'pending_exec_approval';
    } else change.status = 'approved';
    return;
  }
  if (status && status !== old.status && !(old.status === 'approved' && status === 'keyed_to_express') && !(old.status === 'rejected' && status === 'draft')) throw new Error('ไม่สามารถเปลี่ยนสถานะข้ามขั้นอนุมัติ');
  if (['levels_json', 'current_level', 'approvers_json'].some(k => change[k] !== undefined)) throw new Error('ไม่สามารถแก้ข้อมูลขั้นอนุมัติโดยตรง');
}
module.exports = { validateChange, template };
