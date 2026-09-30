const express = require('express');
const { requireRole } = require('../middleware/auth');

// เป้าการขายรายพนักงานขาย × เดือน (2026-09-30) — กรอกที่ "จัดการกลุ่ม → 🎯 เป้าการขาย", เทียบใน Dashboard / Sales Overview
// slm_code = รหัส Sales ใน Express (SLMCOD) หรือรายการรหัส "อื่นๆ" ไม่ได้ — เป้าตั้งต่อรหัสจริงเท่านั้น
const YM_RE = /^\d{4}-\d{2}$/;
const WRITE_ROLES = ['superadmin', 'admin', 'manager', 'sales_manager'];

module.exports = function salesTargetsRoutes(db) {
  const router = express.Router();

  // GET ?year=2026 (หรือ ?from=YYYY-MM&to=YYYY-MM)
  router.get('/', (req, res) => {
    const year = String(req.query.year || '').trim();
    const from = /^\d{4}$/.test(year) ? `${year}-01` : String(req.query.from || '');
    const to = /^\d{4}$/.test(year) ? `${year}-12` : String(req.query.to || '');
    if (!YM_RE.test(from) || !YM_RE.test(to)) return res.status(400).json({ error: 'year หรือ from/to (YYYY-MM) is required' });
    res.json(db.prepare('SELECT slm_code, ym, amount, updated_by, updated_at FROM sales_targets WHERE ym >= ? AND ym <= ? ORDER BY slm_code, ym').all(from, to));
  });

  // PUT { rows: [{ slm_code, ym, amount }] } — amount ว่าง/null = ลบเป้าของเดือนนั้น
  router.put('/', requireRole(...WRITE_ROLES), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: 'rows is required' });
    if (rows.length > 5000) return res.status(400).json({ error: 'too many rows' });
    const up = db.prepare(`INSERT INTO sales_targets (slm_code, ym, amount, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slm_code, ym) DO UPDATE SET amount = excluded.amount, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    const del = db.prepare('DELETE FROM sales_targets WHERE slm_code = ? AND ym = ?');
    const now = new Date().toISOString();
    let saved = 0, removed = 0;
    try {
      db.exec('BEGIN');
      for (const r of rows) {
        const code = String(r?.slm_code || '').trim();
        const ym = String(r?.ym || '');
        if (!code || !YM_RE.test(ym)) throw new Error(`แถวไม่ถูกต้อง: ${code || '(ไม่มีรหัส)'} ${ym}`);
        const blank = r.amount === null || r.amount === undefined || r.amount === '';
        const amt = Number(r.amount);
        if (!blank && (!Number.isFinite(amt) || amt < 0)) throw new Error(`เป้าไม่ถูกต้อง: ${code} ${ym}`);
        if (blank) { removed += del.run(code, ym).changes; } else { up.run(code, ym, amt, req.user.uid, now); saved++; }
      }
      db.prepare('INSERT INTO audit_log (uid, role, action, target, detail) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.uid, req.user.role, 'SALES_TARGET_SAVE', 'sales_targets', JSON.stringify({ saved, removed }));
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      return res.status(400).json({ error: e.message });
    }
    res.json({ saved, removed });
  });

  return router;
};
