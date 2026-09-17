(function (root) {
  'use strict';
  function validate(levels, users, allowEmpty = false) {
    if (!Array.isArray(levels) || (!allowEmpty && !levels.length)) return 'ยังไม่ได้ตั้งค่าเส้นทางอนุมัติผู้บริหาร';
    for (const lv of levels) {
      if (!lv || !['any', 'all'].includes(lv.mode) || !Array.isArray(lv.approvers) || !lv.approvers.length) return 'แต่ละขั้นต้องมีผู้อนุมัติและเลือกเงื่อนไข any/all';
      const seen = new Set();
      for (const a of lv.approvers) {
        if (!a?.uid || seen.has(a.uid)) return 'รายชื่อผู้อนุมัติไม่ถูกต้องหรือซ้ำกัน';
        seen.add(a.uid);
        if (users && !users.some(u => u.uid === a.uid && u.is_active !== false && u.is_active !== 0 && u.active !== false)) return 'ผู้อนุมัติไม่มีอยู่หรือถูกปิดใช้งาน';
      }
    }
    return null;
  }
  function advance(levels, current, uid, approved, comment = '', timestamp = new Date().toISOString()) {
    const copy = JSON.parse(JSON.stringify(levels));
    const lv = copy[current];
    if (!lv || !Array.isArray(lv.approvers) || !lv.approvers.length) throw new Error('ไม่พบขั้นตอนอนุมัติ');
    const actor = lv.approvers.find(a => a.uid === uid);
    if (!actor) throw new Error('คุณไม่มีสิทธิ์อนุมัติในขั้นตอนนี้');
    actor.status = approved ? 'approved' : 'rejected';
    actor.comment = comment;
    actor.ts = timestamp;
    const done = approved && (lv.mode === 'any' ? lv.approvers.some(a => a.status === 'approved') : lv.approvers.every(a => a.status === 'approved'));
    return { levels: copy, current: done && current + 1 < copy.length ? current + 1 : current,
      complete: done && current + 1 === copy.length, levelDone: done, rejected: !approved };
  }
  const api = { validate, advance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ApprovalWorkflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
