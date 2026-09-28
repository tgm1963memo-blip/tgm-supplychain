const express = require('express');

// รายละเอียดใบกำกับของลูกค้า (2026-09-28) — Sales Overview แบบยอดใบกำกับ (invoice_sales_monthly) ไม่มีมิติสินค้า
// จึงดึงรายการสินค้าจาก invoice_lines (STCRD) ผูกกับหัวใบกำกับ invoices (ARTRN: cust_code/slm_code) ด้วย doc_num
// หมายเหตุ: invoices (หัวใบ) sync ย้อนหลังได้ไม่ครบเท่า invoice_lines — ช่วงก่อน coverage_from จะไม่มีรายละเอียด
//   ใบลดหนี้ (RECTYP 5) ไม่มีบรรทัดสินค้า — client แสดงเป็นแถวส่วนต่างกับยอดรวมของสาขา
// cust = รหัสสาขาเดียว หรือหลายสาขา (สรุปทั้งกลุ่มลูกค้า) — GET ?cust=a,b หรือ POST {cust:[...]} เมื่อรายการยาว
// lines=1 = ส่งบรรทัดสินค้าของทุกใบในช่วงด้วย (มุมมอง "รายสินค้า → ใบกำกับ" ในหน้าต่างดูใบกำกับ)
const COMPANY = 'TSS'; // ตรงกับ invoice_sales_monthly ที่ Sales Overview ใช้
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CUSTS = 2000;
const list = v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean))];

function invoiceDetailRoutes(db) {
  const router = express.Router();

  function detail(q, res) {
    const custs = list(q.cust);
    const from = String(q.from || '');
    const to = String(q.to || '');
    if (!custs.length || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'cust, from, to (YYYY-MM-DD) are required' });
    }
    if (custs.length > MAX_CUSTS) return res.status(400).json({ error: `too many customers (max ${MAX_CUSTS})` });
    const slms = list(q.slm);
    const where = [`i.cust_code IN (${custs.map(() => '?').join(',')})`, 'i.doc_date >= ?', 'i.doc_date <= ?'];
    const params = [...custs, from, to];
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
             SUM(l.qty) AS qty, SUM(l.line_value) AS amount, COUNT(DISTINCT l.doc_num) AS invoices,
             COUNT(DISTINCT i.cust_code) AS custs
      FROM invoices i
      JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
      LEFT JOIN products p ON p.code = l.sku
      WHERE ${whereSql}
      GROUP BY l.sku
      ORDER BY amount DESC
    `).all(COMPANY, ...params);

    const invoices = db.prepare(`
      SELECT i.doc_num, i.doc_date, i.cust_code, i.rectyp, i.slm_code, i.so_num, i.total,
             (SELECT SUM(l.line_value) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_value,
             (SELECT COUNT(*) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_count
      FROM invoices i
      WHERE ${whereSql}
      ORDER BY i.doc_date DESC, i.doc_num DESC
      LIMIT 3000
    `).all(COMPANY, COMPANY, ...params);

    const out = { cust: custs, from, to, coverage_from: db.prepare('SELECT MIN(doc_date) AS d FROM invoices').get()?.d || null, products, invoices };
    if (String(q.lines || '') === '1' || q.lines === true) {
      out.lines = db.prepare(`
        SELECT l.doc_num, i.doc_date, i.cust_code, l.sku, l.sku_name, l.qty, l.unit_code, l.line_value
        FROM invoices i JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
        WHERE ${whereSql}
        ORDER BY i.doc_date DESC, l.doc_num DESC
        LIMIT 50000
      `).all(COMPANY, ...params);
    }
    res.json(out);
  }

  router.get('/', (req, res) => detail(req.query, res));
  router.post('/', (req, res) => detail(req.body || {}, res));

  // ชื่อสาขาจากที่อยู่จัดส่งของใบกำกับ (ARSHIP) เช่น "บมจ.ซีพี แอ็กซ์ตร้า (สาขา ราไวย์ 2) ..." → "ราไวย์ 2"
  // ใช้แสดงแทนชื่อบริษัทซ้ำๆ ในแถวสาขาของ Sales Overview (ชื่อที่ตั้งใน customer_profiles.branch มาก่อนเสมอ — ทำที่ client)
  router.get('/branch_names', (req, res) => {
    const rows = db.prepare(`
      SELECT cust_code, ship_to_address FROM invoices
      WHERE ship_to_address IS NOT NULL AND ship_to_address LIKE '%สาขา%'
      ORDER BY doc_date DESC
    `).all();
    const re = /\(\s*สาขา\s*([^)]+?)\s*\)|สาขา\s*([^\s,()]+(?:\s+\d+)?)/;
    const out = {};
    for (const r of rows) {
      if (out[r.cust_code]) continue; // ใบล่าสุดก่อน
      const m = String(r.ship_to_address).match(re);
      const name = m && String(m[1] || m[2] || '').trim().replace(/[.,:;\s-]+$/, '');
      if (name && !/^\d+$/.test(name) && !/^(ที่|เลขที่)$/.test(name)) out[r.cust_code] = name;
    }
    res.json(out);
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
