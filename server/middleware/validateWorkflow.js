const { validate } = require('../../shared/approval-workflow');
const { ROUTES_ENTITY, validateRoutes } = require('../lib/promoApproval');
module.exports = function validateWorkflow(db) {
  return (req, res, next) => {
    if (!['POST', 'PATCH'].includes(req.method)) return next();
    try {
      for (const row of Array.isArray(req.body) ? req.body : [req.body || {}]) {
        if (row.levels_json === undefined) continue;
        const levels = typeof row.levels_json === 'string' ? JSON.parse(row.levels_json) : row.levels_json;
        // รายการเส้นทางอนุมัติใบเคาะราคา (2026-09-24) — levels_json ของแถวนี้คือรายชื่อเส้นทาง ไม่ใช่ขั้นอนุมัติ
        if (row.entity_type === ROUTES_ENTITY) {
          const error = validateRoutes(levels);
          if (error) return res.status(400).json({ error });
          continue;
        }
        // ขั้น "ผู้สร้างเลือกผู้อนุมัติเอง" ปล่อยรายชื่อว่างได้ (ผู้สร้างเลือกตอนส่ง — ตรวจอีกครั้งใน promoApproval.template)
        // FIXED (2026-09-24): เดิมตรวจทุกขั้นรวมขั้นนี้ด้วย ทำให้บันทึกเส้นทางที่มีขั้นเลือกเองแบบว่างไม่ได้ (400)
        // ยกเว้นให้เฉพาะเส้นทางปกติของใบเคาะราคา ('promo_draft' / 'promo_draft@<id>') — ขั้นผู้บริหาร/entity อื่นไม่มีการเลือกเอง
        // และขั้นที่ข้ามไปยังต้องเลือกเงื่อนไข any/all
        const pickable = /^promo_draft(@|$)/.test(String(row.entity_type || ''));
        const isOpenPick = lv => pickable && lv && lv.pick_by_creator && !(lv.approvers || []).length;
        if (Array.isArray(levels) && levels.some(lv => isOpenPick(lv) && !['any', 'all'].includes(lv.mode))) return res.status(400).json({ error: 'แต่ละขั้นต้องเลือกเงื่อนไข any/all' });
        const fixed = Array.isArray(levels) ? levels.filter(lv => !isOpenPick(lv)) : levels;
        const error = validate(fixed, db.prepare('SELECT uid,is_active FROM sc_users').all(), true);
        if (error) return res.status(400).json({ error });
      }
      next();
    } catch { res.status(400).json({ error: 'รูปแบบเส้นทางอนุมัติไม่ถูกต้อง' }); }
  };
};
