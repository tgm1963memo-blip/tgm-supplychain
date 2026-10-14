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

    // สินค้าลูก (2026-10-12, ผู้ใช้ขอ Top 10 ให้เป็นสินค้าลูก): บรรทัดรหัสชุด (เช่น 90022-1) แตกเป็นไส้ใน
    // · มีไส้ในจริง (invoice_line_components — ปัจจุบันมีเฉพาะฝากขาย CONSI) = แบ่งยอดบรรทัดตามสัดส่วนจำนวนลูก
    // · ไม่มี (ใบกำกับ DD ของ TSS — Express ไม่มีหมายเหตุไส้ใน) = ประมาณจากสัดส่วนไส้ในของรหัสชุดเดียวกันในช่วงเวลาเดียวกัน
    //   (ไม่มีในช่วง = 90 วันก่อนสิ้นช่วง) → estimated = true
    const lineRows = db.prepare(`
      SELECT l.doc_num, l.seq_num, l.sku, l.sku_name, l.unit_code, l.qty, l.line_value, c.child_code, c.child_name, c.child_qty
      FROM invoices i
      JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
      LEFT JOIN invoice_line_components c ON c.doc_num = l.doc_num AND c.seq_num = l.seq_num AND c.company = l.company
      WHERE ${whereSql}
    `).all(COMPANY, ...params);
    const shareRows = (lo, hi) => db.prepare(`SELECT c.parent_sku, c.child_code, MAX(c.child_name) AS child_name, SUM(c.child_qty) AS q
      FROM invoice_line_components c JOIN invoice_lines l ON l.doc_num = c.doc_num AND l.seq_num = c.seq_num AND l.company = c.company
      WHERE l.doc_date >= ? AND l.doc_date <= ? GROUP BY c.parent_sku, c.child_code`).all(lo, hi);
    const sharesOf = rows => { const m = new Map(); rows.forEach(r => { if (!m.has(r.parent_sku)) m.set(r.parent_sku, []); m.get(r.parent_sku).push(r); }); return m; };
    const shares = sharesOf(shareRows(from, to));
    const back90 = new Date(new Date(to + 'T00:00:00Z').getTime() - 90 * 864e5).toISOString().slice(0, 10);
    let sharesWide = null;
    const byLine = new Map();
    for (const r of lineRows) { const k = r.doc_num + '|' + r.seq_num; if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(r); }
    const agg = new Map();
    const add = (sku, name, unit, qty, amount, parent, est) => {
      const e = agg.get(sku) || { sku, sku_name: name, unit, qty: 0, amount: 0, parent_sku: parent || null, estimated: false };
      e.qty += qty; e.amount += amount; if (est) e.estimated = true; if (!e.sku_name && name) e.sku_name = name;
      agg.set(sku, e);
    };
    for (const rows of byLine.values()) {
      const l = rows[0], val = Number(l.line_value) || 0, qty = Number(l.qty) || 0;
      const kids = rows.filter(r => r.child_code);
      if (kids.length) {
        const tq = kids.reduce((a, r) => a + (Number(r.child_qty) || 0), 0) || kids.length;
        kids.forEach(r => add(r.child_code, r.child_name, l.unit_code, Number(r.child_qty) || 0, val * ((Number(r.child_qty) || 1) / tq), l.sku, false));
        continue;
      }
      let sh = /^90022(?:-|$)/.test(l.sku || '') ? shares.get(l.sku) : null;
      if (!sh && /^90022(?:-|$)/.test(l.sku || '')) { sharesWide = sharesWide || sharesOf(shareRows(back90, to)); sh = sharesWide.get(l.sku); }
      if (sh && sh.length) {
        const tq = sh.reduce((a, r) => a + (Number(r.q) || 0), 0) || 1;
        sh.forEach(r => { const f = (Number(r.q) || 0) / tq; add(r.child_code, r.child_name, l.unit_code, qty * f, val * f, l.sku, true); });
      } else add(l.sku, l.sku_name, l.unit_code, qty, val, null, false);
    }
    const grp = db.prepare('SELECT group_name FROM products WHERE code = ?');
    const productsChildren = [...agg.values()].map(e => ({ ...e, group_name: grp.get(e.sku)?.group_name || null }))
      .sort((a, b) => b.amount - a.amount);

    const invoices = db.prepare(`
      SELECT i.doc_num, i.doc_date, i.cust_code, i.rectyp, i.slm_code, i.so_num, i.total,
             (SELECT SUM(l.line_value) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_value,
             (SELECT COUNT(*) FROM invoice_lines l WHERE l.doc_num = i.doc_num AND l.company = ?) AS line_count
      FROM invoices i
      WHERE ${whereSql}
      ORDER BY i.doc_date DESC, i.doc_num DESC
      LIMIT 3000
    `).all(COMPANY, COMPANY, ...params);

    // ใบกำกับโรงงาน TGM จาก Bplus (2026-10-12) — ลูกค้าโรงงานเดิมขึ้น "ดูใบกำกับ 0 ใบ" เพราะตารางข้างบนมีแต่ TSS ของ Express
    // รวมเข้าในรายการเดียวกัน (company = 'TGM') · ยอดขายในเครือ (BP-TGM-IC) ไม่นับ · ตัวกรอง Sales ใช้รหัสที่จับคู่แล้วแบบเดียวกับยอดขาย
    try {
      const bw = [`b.cust_code IN (${custs.map(() => '?').join(',')})`, 'b.doc_date >= ?', 'b.doc_date <= ?', "b.company = 'BP-TGM'"];
      const bp = [...custs, from, to];
      if (slms.length) { bw.push(`b.slm_code IN (${slms.map(() => '?').join(',')})`); bp.push(...slms); }
      const bWhere = bw.join(' AND ');
      const bInv = db.prepare(`SELECT 'BP:' || b.doc_key AS doc_num, b.doc_num AS doc_ref, b.doc_date, b.cust_code, CASE WHEN b.is_cn = 1 THEN '5' ELSE '0' END AS rectyp, b.slm_code,
          NULL AS so_num, b.amount + b.vat_amount AS total,
          (SELECT SUM(l.amount) FROM bplus_invoice_lines l WHERE l.doc_key = b.doc_key) AS line_value,
          (SELECT COUNT(*) FROM bplus_invoice_lines l WHERE l.doc_key = b.doc_key) AS line_count, 'TGM' AS company
        FROM bplus_invoices b WHERE ${bWhere} ORDER BY b.doc_date DESC, b.doc_num DESC LIMIT 3000`).all(...bp);
      if (bInv.length) {
        const bProd = db.prepare(`SELECT l.sku, MAX(COALESCE(s.name, p.name, l.sku)) AS sku_name, MAX(p.group_name) AS group_name, MAX(l.unit_code) AS unit,
            SUM(l.qty) AS qty, SUM(l.amount) AS amount, COUNT(DISTINCT l.doc_key) AS invoices, COUNT(DISTINCT b.cust_code) AS custs
          FROM bplus_invoices b JOIN bplus_invoice_lines l ON l.doc_key = b.doc_key
          LEFT JOIN bplus_skus s ON s.code = l.sku LEFT JOIN products p ON p.code = l.sku
          WHERE ${bWhere} AND b.is_cn = 0 GROUP BY l.sku`).all(...bp);
        const merge = (list, extra) => {
          const m = new Map(list.map(x => [x.sku, { ...x }]));
          for (const x of extra) { const e = m.get(x.sku); if (e) { e.qty += x.qty; e.amount += x.amount; e.invoices += x.invoices; } else m.set(x.sku, { ...x }); }
          return [...m.values()].sort((a, b) => b.amount - a.amount);
        };
        products.splice(0, products.length, ...merge(products, bProd));
        productsChildren.splice(0, productsChildren.length, ...merge(productsChildren, bProd.map(x => ({ ...x, parent_sku: null, estimated: false }))));
        invoices.push(...bInv);
        invoices.sort((a, b) => String(b.doc_date).localeCompare(String(a.doc_date)) || String(b.doc_num).localeCompare(String(a.doc_num)));
      }
    } catch (e) { /* ยังไม่มีตาราง bplus_invoices (ก่อน migration) */ }

    const out = { cust: custs, from, to, coverage_from: db.prepare('SELECT MIN(doc_date) AS d FROM invoices').get()?.d || null, products, products_children: productsChildren, invoices };
    if (String(q.lines || '') === '1' || q.lines === true) {
      out.lines = db.prepare(`
        SELECT l.doc_num, i.doc_date, i.cust_code, l.sku, l.sku_name, l.qty, l.unit_code, l.line_value
        FROM invoices i JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
        WHERE ${whereSql}
        ORDER BY i.doc_date DESC, l.doc_num DESC
        LIMIT 50000
      `).all(COMPANY, ...params);
      // บรรทัดใบกำกับโรงงาน (Bplus) — 2026-10-12
      try {
        const bw = [`b.cust_code IN (${custs.map(() => '?').join(',')})`, 'b.doc_date >= ?', 'b.doc_date <= ?', "b.company = 'BP-TGM'"];
        const bp = [...custs, from, to];
        if (slms.length) { bw.push(`b.slm_code IN (${slms.map(() => '?').join(',')})`); bp.push(...slms); }
        out.lines.push(...db.prepare(`SELECT 'BP:' || b.doc_key AS doc_num, b.doc_num AS doc_ref, b.doc_date, b.cust_code, l.sku, COALESCE(s.name, l.sku) AS sku_name,
          l.qty, l.unit_code, l.amount AS line_value FROM bplus_invoices b JOIN bplus_invoice_lines l ON l.doc_key = b.doc_key
          LEFT JOIN bplus_skus s ON s.code = l.sku WHERE ${bw.join(' AND ')} ORDER BY b.doc_date DESC LIMIT 50000`).all(...bp));
      } catch (e) { /* ไม่มีตาราง */ }
    }
    res.json(out);
  }

  // ── Pivot รายลูกค้า × สินค้า × Sales (2026-10-12, ผู้ใช้ขอ "ติ๊กเลือกมิติที่จะแสดง") ─────────────────────────────
  // POST { from, to, slm? } → rows [{ c: cust_code, s: slm_code, k: sku, n: ชื่อสินค้า, g: group_name, q: qty, a: amount }]
  // ยอดขายจากบรรทัดใบกำกับ TSS (invoice_lines) + โรงงาน TGM (bplus_invoice_lines) ไม่รวมใบลดหนี้ — ส่วนต่างกับยอดหัวใบ
  // (CN / ใบที่ไม่มีบรรทัด) client แสดงเป็น "(ไม่มีรายการสินค้า)" · กรองตามสิทธิ์ลูกค้า (lib/customerScope.js)
  router.post('/pivot', (req, res) => {
    try {
      const q = req.body || {};
      const from = String(q.from || ''), to = String(q.to || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return res.status(400).json({ error: 'from, to (YYYY-MM-DD) are required' });
      const slms = list(q.slm);
      const cs = require('../lib/customerScope');
      const sc = cs.factSql(cs.resolveScope(db, req.user), { cust: 'x.cust_code', slm: 'x.slm_code' });
      const filt = (x) => {
        const w = [], p = [];
        if (slms.length) { w.push(`${x}.slm_code IN (${slms.map(() => '?').join(',')})`); p.push(...slms); }
        if (sc) { w.push(sc.sql.replace(/x\./g, `${x}.`)); p.push(...sc.params); }
        return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p };
      };
      const fi = filt('i');
      const rows = db.prepare(`SELECT i.cust_code AS c, COALESCE(NULLIF(TRIM(i.slm_code), ''), '(ไม่ระบุ)') AS s, l.sku AS k, MAX(l.sku_name) AS n,
          MAX(p.group_name) AS g, SUM(l.qty) AS q, SUM(l.line_value) AS a
        FROM invoices i JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
        LEFT JOIN products p ON p.code = l.sku
        WHERE i.doc_date >= ? AND i.doc_date <= ? AND COALESCE(i.rectyp, '') <> '5'${fi.sql}
        GROUP BY i.cust_code, i.slm_code, l.sku`).all(COMPANY, from, to, ...fi.params);
      try {
        const fb = filt('b');
        rows.push(...db.prepare(`SELECT b.cust_code AS c, b.slm_code AS s, l.sku AS k, MAX(COALESCE(sk.name, p.name, l.sku)) AS n,
            MAX(p.group_name) AS g, SUM(l.qty) AS q, SUM(l.amount) AS a
          FROM bplus_invoices b JOIN bplus_invoice_lines l ON l.doc_key = b.doc_key
          LEFT JOIN bplus_skus sk ON sk.code = l.sku LEFT JOIN products p ON p.code = l.sku
          WHERE b.company = 'BP-TGM' AND b.is_cn = 0 AND b.doc_date >= ? AND b.doc_date <= ?${fb.sql}
          GROUP BY b.cust_code, b.slm_code, l.sku`).all(from, to, ...fb.params));
      } catch (e) { /* ยังไม่มีตาราง Bplus */ }
      res.json({ from, to, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

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
    if (!head && !lines.length) {
      // ใบกำกับโรงงาน (Bplus) — 2026-10-12
      try {
        const key = doc.startsWith('BP:') ? doc.slice(3) : doc;
        const bh = db.prepare(`SELECT doc_num, doc_date, cust_code, slm_code, NULL AS so_num, amount + vat_amount AS total,
          CASE WHEN is_cn = 1 THEN '5' ELSE '0' END AS rectyp, NULL AS route_name, NULL AS ship_to_address, 'TGM' AS company FROM bplus_invoices WHERE doc_key = ?`).get(key);
        if (bh) {
          const bl = db.prepare(`SELECT ROW_NUMBER() OVER (ORDER BY l.rowid) AS seq_num, l.sku, COALESCE(s.name, p.name, l.sku) AS sku_name, NULL AS warehouse,
            l.qty, l.unit_code, l.amount AS line_value, p.group_name FROM bplus_invoice_lines l LEFT JOIN bplus_skus s ON s.code = l.sku
            LEFT JOIN products p ON p.code = l.sku WHERE l.doc_key = ?`).all(key);
          return res.json({ head: bh, lines: bl });
        }
      } catch (e) { /* ไม่มีตาราง */ }
    }
    res.json({ head, lines });
  });

  return router;
}

module.exports = invoiceDetailRoutes;
