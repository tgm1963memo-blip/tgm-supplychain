const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { evaluate, latestSnapshot } = require('../lib/promoEval');

// ผลวิเคราะห์ใบเคาะราคา (2026-10-27, เฟส 2) — มีทุนผลิต/margin จึงเปิดเฉพาะ role ที่ app.js ส่งมา (ตอนนี้ admin/superadmin)
// GET /:draftNo → { live, snapshot } · live = คำนวณใหม่ตอนนี้ · snapshot = ผล ณ ตอนส่งอนุมัติรอบล่าสุด (ถ้ามี)
module.exports = function promoEvalRoutes(db, roles) {
  const router = express.Router();
  router.use(requireAuth(db), requireRole(...roles));

  router.get('/:draftNo', (req, res) => {
    try {
      const live = evaluate(db, String(req.params.draftNo));
      if (!live) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
      res.json({ live, snapshot: latestSnapshot(db, String(req.params.draftNo)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
