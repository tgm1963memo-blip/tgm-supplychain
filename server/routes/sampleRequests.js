'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');
const { nextDocNo } = require('../lib/docNumber');

// ออกเลขที่เอกสารให้คำขอของตัวอย่าง (2026-10-05) — เรียกหลังบันทึกคำขอสถานะ "รออนุมัติ" แล้ว
// สินค้าเดิม = SE..., สินค้าใหม่ = SN... · ออกครั้งเดียว (มีเลขแล้วคืนเลขเดิม) · doc_no ไม่อยู่ใน fields ของ CRUD
// router ฝั่ง client จึงเขียนทับ/ปลอมเลขไม่ได้ · BEGIN IMMEDIATE กันสองคำขอที่ส่งพร้อมกันได้เลขซ้ำ
module.exports = (db, writeRoles) => {
  const router = express.Router();

  router.post('/:id/assign_no', requireRole(...writeRoles), (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT req_type, doc_no, status FROM sample_requests WHERE id = ?').get(id);
        if (!row) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบคำขอ' }); }
        if (row.doc_no) { db.exec('COMMIT'); return res.json({ doc_no: row.doc_no }); }
        if (row.status === 'draft') { db.exec('ROLLBACK'); return res.status(400).json({ error: 'ต้องส่งคำขอก่อนจึงออกเลขที่เอกสาร' }); }
        const docNo = nextDocNo(db, 'sample_requests', 'doc_no', row.req_type === 'new' ? 'SN' : 'SE');
        db.prepare('UPDATE sample_requests SET doc_no = ? WHERE id = ?').run(docNo, id);
        db.exec('COMMIT');
        return res.json({ doc_no: docNo });
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } catch (e) {
      console.error('[sampleRequests] assign_no failed:', e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
