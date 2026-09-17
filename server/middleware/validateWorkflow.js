const { validate } = require('../../shared/approval-workflow');
module.exports = function validateWorkflow(db) {
  return (req, res, next) => {
    if (!['POST', 'PATCH'].includes(req.method)) return next();
    try {
      for (const row of Array.isArray(req.body) ? req.body : [req.body || {}]) {
        if (row.levels_json === undefined) continue;
        const levels = typeof row.levels_json === 'string' ? JSON.parse(row.levels_json) : row.levels_json;
        const error = validate(levels, db.prepare('SELECT uid,is_active FROM sc_users').all(), true);
        if (error) return res.status(400).json({ error });
      }
      next();
    } catch { res.status(400).json({ error: 'รูปแบบเส้นทางอนุมัติไม่ถูกต้อง' }); }
  };
};
