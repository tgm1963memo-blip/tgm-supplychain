const workflow = require('../../shared/approval-workflow');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
// เส้นทางอนุมัติหลายแบบ (2026-09-24): รายชื่อเส้นทางเก็บเป็นแถว entity_type='promo_draft_routes'
// (levels_json = [{id, name, match:{corps,item_types,npd,off_contract,marketing}}]) ส่วนขั้นอนุมัติของแต่ละเส้นทาง
// เก็บที่ entity_type='promo_draft@<id>' — เส้นทางมาตรฐานยังเป็น 'promo_draft' เหมือนเดิม (route_id ว่าง)
const ROUTES_ENTITY = 'promo_draft_routes';
const ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
function validateRoutes(routes) {
  if (!Array.isArray(routes)) return 'รูปแบบรายการเส้นทางอนุมัติไม่ถูกต้อง';
  const ids = new Set();
  for (const r of routes) {
    if (!r || typeof r.id !== 'string' || !ROUTE_ID_RE.test(r.id)) return 'รหัสเส้นทางอนุมัติไม่ถูกต้อง';
    if (ids.has(r.id)) return 'รหัสเส้นทางอนุมัติซ้ำกัน';
    ids.add(r.id);
    if (!String(r.name || '').trim()) return 'กรุณาตั้งชื่อเส้นทางอนุมัติทุกเส้นทาง';
  }
  return null;
}
function routeOf(db, routeId) {
  if (!routeId) return { entity: 'promo_draft', name: '' };
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type=?').get(ROUTES_ENTITY);
  let routes = [];
  try { routes = row ? parse(row.levels_json) || [] : []; } catch { routes = []; }
  const r = Array.isArray(routes) ? routes.find(x => x && x.id === routeId) : null;
  if (!r) throw new Error('ไม่พบเส้นทางอนุมัติที่เลือก — อาจถูกลบไปแล้ว กรุณาเลือกใหม่');
  return { entity: 'promo_draft@' + routeId, name: String(r.name || '') };
}
const needsExec = row => ['is_npd', 'has_off_contract_cost', 'has_marketing_cost'].some(k => Number(row[k]) === 1 || row[k] === true);
// picks (2026-09-24): ขั้นที่ตั้งค่า pick_by_creator = ผู้สร้างเอกสารเลือกผู้อนุมัติเองตอนส่งอนุมัติ
// { [levelId]: [uid,...] } — แทนที่รายชื่อ (ค่าแนะนำ) ในเทมเพลตของขั้นนั้น แล้วค่อย validate ทั้งเส้นทาง
function template(db, entity, allowEmpty = false, picks = null) {
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type=?').get(entity);
  const users = db.prepare('SELECT uid,name,role,is_active FROM sc_users').all();
  const levels = (row ? parse(row.levels_json) : []).map(lv => {
    if (!lv.pick_by_creator) return lv;
    const chosen = picks && Array.isArray(picks[lv.id]) ? [...new Set(picks[lv.id].map(String))] : null;
    if (!chosen || !chosen.length) {
      // ไม่ได้เลือก: ใช้รายชื่อแนะนำในเทมเพลตถ้ามี ไม่มีเลย = ต้องเลือกก่อนส่ง
      if (picks && !(lv.approvers || []).length) throw new Error(`กรุณาเลือกผู้อนุมัติของขั้น "${lv.label || lv.id}"`);
      return lv;
    }
    return { ...lv, approvers: chosen.map(uid => { const u = users.find(x => x.uid === uid); return { uid, name: u?.name || uid, role: u?.role || '' }; }) };
  });
  const error = workflow.validate(levels, users, allowEmpty);
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
  // ผลตรวจสอบ ขายได้/ขาดทุน รายบรรทัดสินค้า (2026-09-24) — กรอกได้เฉพาะผู้อนุมัติของขั้นที่ตั้ง audit_verdict
  // (ขั้น "ตรวจสอบ") และต้องครบทุก SKU ของเอกสารเมื่ออนุมัติขั้นนั้น เก็บลง approver entry
  // (line_verdicts: { [sku]: 'profit' | 'loss' })
  const lineVerdicts = change.approval_line_verdicts && typeof change.approval_line_verdicts === 'object' && !Array.isArray(change.approval_line_verdicts) ? change.approval_line_verdicts : null;
  delete change.approval_line_verdicts;
  // ผู้อนุมัติที่ผู้สร้างเลือกเองตอนส่งอนุมัติ (ไม่ใช่คอลัมน์)
  const picks = change.picked_approvers && typeof change.picked_approvers === 'object' ? change.picked_approvers : {};
  delete change.picked_approvers;
  // route_name เป็น snapshot ที่ server เขียนเองตอนส่งอนุมัติ — ไม่รับจาก client
  delete change.route_name;
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
  // route_id เปลี่ยนได้เฉพาะตอนส่งอนุมัติ (route_name ถูกลบทิ้งไปแล้วด้านบน — server เขียนเอง)
  if (change.route_id !== undefined && !(status === 'pending_approval' && ['draft', 'rejected'].includes(old.status))) {
    if (String(change.route_id || '') !== String(old.route_id || '')) throw new Error('เปลี่ยนเส้นทางอนุมัติได้เฉพาะตอนส่งอนุมัติ');
    delete change.route_id;
  }
  if (status === 'pending_approval' && ['draft', 'rejected'].includes(old.status)) {
    if (needsExec(next)) template(db, 'promo_draft_exec');
    const route = routeOf(db, String(change.route_id ?? old.route_id ?? '').trim());
    change.route_id = route.entity === 'promo_draft' ? null : route.entity.slice('promo_draft@'.length);
    change.route_name = route.name;
    const levels = template(db, route.entity, true, picks);
    // เส้นทางเพิ่มเติมต้องมีขั้นอนุมัติ — ถ้าว่างจะตกไปกรณี "ไม่มี route" ที่ผู้จัดการคนใดก็อนุมัติเองได้ (ข้ามผู้อนุมัติ)
    if (route.entity !== 'promo_draft' && !levels.length) throw new Error(`เส้นทาง "${route.name}" ยังไม่ได้ตั้งขั้นอนุมัติ กรุณาเลือกเส้นทางอื่นหรือให้แอดมินตั้งค่า`);
    assign(levels);
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
      const curLv = levels[old.current_level] || {};
      let verdicts = null;
      if (lineVerdicts && Object.keys(lineVerdicts).length) {
        if (!curLv.audit_verdict) throw new Error('ขั้นนี้ไม่ใช่ขั้นตรวจสอบ — เลือกผล ขายได้/ขาดทุน ไม่ได้');
        if (Object.values(lineVerdicts).some(v => !['profit', 'loss'].includes(v))) throw new Error('ผลตรวจสอบไม่ถูกต้อง');
      }
      if (curLv.audit_verdict && status !== 'rejected') {
        // ต้องครบทุก SKU ของเอกสาร (เอกสารนอกสัญญาไม่มีบรรทัดสินค้า = ไม่ต้องกรอก)
        const skus = db.prepare('SELECT DISTINCT sku FROM promo_drafts WHERE draft_no = ?').all(old.draft_no).map(r => r.sku).filter(Boolean);
        const missing = skus.filter(s => !['profit', 'loss'].includes(lineVerdicts?.[s]));
        if (missing.length) throw new Error(`ขั้นตรวจสอบ: กรุณาเลือกผล "ขายได้" หรือ "ขาดทุน" ให้ครบทุกรายการสินค้า (ยังขาด ${missing.join(', ')})`);
        verdicts = Object.fromEntries(skus.map(s => [s, lineVerdicts[s]]));
      }
      result = workflow.advance(levels, old.current_level, user.uid, status !== 'rejected', comment);
      stampSignature(db, result.levels, old.current_level, user.uid);
      if (verdicts) { const actor = result.levels[old.current_level]?.approvers?.find(a => a.uid === user.uid); if (actor) actor.line_verdicts = verdicts; }
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
module.exports = { validateChange, template, ROUTES_ENTITY, validateRoutes };
