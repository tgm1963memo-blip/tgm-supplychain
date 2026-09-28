const express = require('express');

// รายละเอียดใบกำกับของลูกค้า 1 สาขา (2026-09-28) — Sales Overview แบบยอดใบกำกับ (invoice_sales_monthly) ไม่มีมิติสินค้า
// จึงดึงรายการสินค้าจาก invoice_lines (STCRD) ผูกกับหัวใบกำกับ invoices (ARTRN: cust_code/slm_code) ด้วย doc_num
// หมายเหตุ: invoices (หัวใบ) sync ย้อนหลังได้ไม่ครบเท่า invoice_lines — ช่วงก่อน coverage_from จะไม่มีรายละเอียด
//   ใบลดหนี้ (RECTYP 5) ไม่มีบรรทัดสินค้า — client แสดงเป็นแถวส่วนต่างกับยอดรวมของสาขา
const COMPANY = 'TSS'; // ตรงกับ invoice_sales_monthly ที่ Sales Overview ใช้
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invoiceDetailRoutes(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const cust = String(req.query.cust || '').trim();
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!cust || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'cust, from, to (YYYY-MM-DD) are required' });
    }
    const slms = [...new Set(String(req.query.slm || '').split(',').map(s => s.trim()).filter(Boolean))];
    const where = ['i.cust_code = ?', 'i.doc_date >= ?', 'i.doc_date <= ?'];
    const params = [cust, from, to];
    if (slms.length) {
      // "(ไม่ระบุ)" = ใบที่ไม่มี SLMCOD (แถวเดียวกับกลุ่ม "ไม่ระบุพนักงานขาย" ในแท็บรายเซลส์)
      const named = slms.filter(s => s !== '(ไม่ระบุ)');
      const ors = [];
      if (named.length) { ors.push(`i.slm_code IN (${named.map(() => '?').join(',')})`); params.push(...named); }
      if (named.length !== slms.length) ors.push("(i.slm_code IS NULL OR TRIM(i.slm_code) = '' OR i.slm_code = '(none)')");
      where.push(`(${ors.join(' OR ')})`);
    }
    const whereSql = where.join(' AND ');

    const products = db.prepare(`
      SELECT l.sku, MAX(l.sku_name) AS sku_name, MAX(p.group_name) AS group_name, MAX(l.unit_code) AS unit,
             SUM(l.qty) AS qty, SUM(l.line_value) AS amount, COUNT(DISTINCT l.doc_num) AS invoices
      FROM invoices i
      JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
      LEFT JOIN products p ON p.code = l.sku
      WHERE ${whereSql}
      GROUP BY l.sku
      ORDER BY amount DESC
    `).all(COMPANY, ...params);

    const invoices = db.prepare(`
      SELECT i.doc_num, i.doc_date, i.rectyp, i.slm_code, i.so_num, i.total,
             (SELECT SUM(l.line_value) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_value,
             (SELECT COUNT(*) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_count
      FROM invoices i
      WHERE ${whereSql}
      ORDER BY i.doc_date DESC, i.doc_num DESC
      LIMIT 1000
    `).all(COMPANY, COMPANY, ...params);

    const coverage = db.prepare('SELECT MIN(doc_date) AS d FROM invoices').get();
    res.json({ cust, from, to, coverage_from: coverage?.d || null, products, invoices });
  });

  // บรรทัดสินค้าของใบกำกับ 1 ใบ
  router.get('/lines', (req, res) => {
    const doc = String(req.query.doc || '').trim();
    if (!doc) return res.status(400).json({ error: 'doc is required' });
    const lines = db.prepare(`
      SELECT l.seq_num, l.sku, l.sku_name, l.warehouse, l.qty, l.unit_code, l.line_value, p.group_name
      FROM invoice_lines l LEFT JOIN products p ON p.code = l.sku
      WHERE l.doc_num = ? AND l.company = ?
      ORDER BY CAST(l.seq_num AS INTEGER)
    `).all(doc, COMPANY);
    const head = db.prepare('SELECT doc_num, doc_date, cust_code, slm_code, so_num, total, rectyp, route_name, ship_to_address FROM invoices WHERE doc_num = ?').get(doc) || null;
    res.json({ head, lines });
  });

  return router;
}

module.exports = invoiceDetailRoutes;
