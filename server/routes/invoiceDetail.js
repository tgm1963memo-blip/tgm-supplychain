const express = require('express');
const { productGroupResolver, unitLabel } = require('../lib/productGroupMatch');
const { salesDocSql } = require('../lib/salesDocs');

// รายละเอียดใบกำกับของลูกค้า (2026-09-28) — Sales Overview แบบยอดใบกำกับ (invoice_sales_monthly) ไม่มีมิติสินค้า
// จึงดึงรายการสินค้าจาก invoice_lines (STCRD) ผูกกับหัวใบกำกับ v_invoice_heads (ARTRN: cust_code/slm_code) ด้วย doc_num
// (2026-10-19: invoices มีแค่ 90 วัน — v_invoice_heads รวม invoice_heads ย้อนหลังถึง 2024-01 ให้ตรงกับ invoice_lines)
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

  // สิทธิ์การเห็นลูกค้า (2026-10-12, security review) — ผู้ถูกจำกัดเห็นเฉพาะลูกค้าในสิทธิ์ (lib/customerScope.js)
  const cs = require('../lib/customerScope');
  const scopeOf = user => cs.resolveScope(db, user);
  // เติม group_name ที่ว่างด้วยตัวหากลุ่มจากรหัส/ชื่อ (lib/productGroupMatch.js) — ใช้ใน detail / lines
  function fillGroups(list) {
    const { resolve } = productGroupResolver(db);
    for (const r of list || []) if (!r.group_name && r.sku) r.group_name = resolve(r.sku, r.sku_name, '') || null;
    return list;
  }
  function detail(q, res, user) {
    const scope = scopeOf(user);
    let custs = list(q.cust);
    if (!scope.all) custs = custs.filter(c => cs.canSeeCust(scope, c));
    if (!custs.length && list(q.cust).length) {
      return res.json({ cust: [], from: String(q.from || ''), to: String(q.to || ''), coverage_from: null, products: [], products_children: [], invoices: [], ...(q.lines ? { lines: [] } : {}) });
    }
    const from = String(q.from || '');
    const to = String(q.to || '');
    if (!custs.length || !DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'cust, from, to (YYYY-MM-DD) are required' });
    }
    if (custs.length > MAX_CUSTS) return res.status(400).json({ error: `too many customers (max ${MAX_CUSTS})` });
    const slms = list(q.slm);
    // ไม่รวมเล่มที่ไม่นับยอดขาย (ค่าขนส่ง IT / ขายวัสดุ IV / LF LE LG — lib/salesDocs.js, 2026-10-20) ให้ตรงกับยอดรวมของ Sales Overview
    const where = [`i.cust_code IN (${custs.map(() => '?').join(',')})`, 'i.doc_date >= ?', 'i.doc_date <= ?', salesDocSql('i.doc_num')];
    const params = [...custs, from, to];
    if (slms.length) {
      // ตามเจ้าของยอด (2026-10-20, lib/customerScope.js slmListSql): รหัส Sales ที่เลือก รวมใบไม่มี SLMCOD ของลูกค้าที่ master ผูกกับรหัสนั้น
      // "(ไม่ระบุ)" = ใบไม่มี SLMCOD และลูกค้าไม่ได้ผูกกับใคร (แถวเดียวกับกลุ่ม "ไม่ระบุพนักงานขาย" ในแท็บรายเซลส์)
      const x = cs.slmListSql(slms, { cust: 'i.cust_code', slm: 'i.slm_code' });
      where.push(x.sql); params.push(...x.params);
    }
    const whereSql = where.join(' AND ');

    const products = db.prepare(`
      SELECT l.sku, MAX(l.sku_name) AS sku_name, MAX(p.group_name) AS group_name, MAX(l.unit_code) AS unit,
             SUM(l.qty) AS qty, SUM(l.line_value) AS amount, COUNT(DISTINCT l.doc_num) AS invoices,
             COUNT(DISTINCT i.cust_code) AS custs
      FROM v_invoice_heads i
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
      FROM v_invoice_heads i
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
      FROM v_invoice_heads i
      WHERE ${whereSql}
      ORDER BY i.doc_date DESC, i.doc_num DESC
      LIMIT 3000
    `).all(COMPANY, COMPANY, ...params);

    // ใบกำกับโรงงาน TGM จาก Bplus (2026-10-12) — ลูกค้าโรงงานเดิมขึ้น "ดูใบกำกับ 0 ใบ" เพราะตารางข้างบนมีแต่ TSS ของ Express
    // รวมเข้าในรายการเดียวกัน (company = 'TGM') · ยอดขายในเครือ (BP-TGM-IC) ไม่นับ · ตัวกรอง Sales ใช้รหัสที่จับคู่แล้วแบบเดียวกับยอดขาย
    try {
      const bw = [`b.cust_code IN (${custs.map(() => '?').join(',')})`, 'b.doc_date >= ?', 'b.doc_date <= ?', "b.company = 'BP-TGM'"];
      const bp = [...custs, from, to];
      if (slms.length) { const x = cs.slmListSql(slms, { cust: 'b.cust_code', slm: 'b.slm_code', company: "'BP-TGM'" }); bw.push(x.sql); bp.push(...x.params); }
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

    // สินค้าที่ไม่มีกลุ่มใน products (รหัสโรงงาน เช่น 10396-18 ไส้กรอกไก่สโมคกี้) → หากลุ่มจากรหัสขึ้นต้น/ชื่อ
    // แบบเดียวกับ /pivot (2026-10-14, ผู้ใช้แจ้งยังมี "ไม่ระบุกลุ่ม" ในรายการสินค้าจากใบกำกับจริงของสาขา)
    fillGroups(products); fillGroups(productsChildren);
    const out = { cust: custs, from, to, coverage_from: db.prepare('SELECT MIN(d) AS d FROM (SELECT MIN(doc_date) AS d FROM invoices UNION ALL SELECT MIN(doc_date) FROM invoice_heads)').get()?.d || null, products, products_children: productsChildren, invoices };
    if (String(q.lines || '') === '1' || q.lines === true) {
      out.lines = db.prepare(`
        SELECT l.doc_num, i.doc_date, i.cust_code, l.sku, l.sku_name, l.qty, l.unit_code, l.line_value
        FROM v_invoice_heads i JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
        WHERE ${whereSql}
        ORDER BY i.doc_date DESC, l.doc_num DESC
        LIMIT 50000
      `).all(COMPANY, ...params);
      // บรรทัดใบกำกับโรงงาน (Bplus) — 2026-10-12
      try {
        const bw = [`b.cust_code IN (${custs.map(() => '?').join(',')})`, 'b.doc_date >= ?', 'b.doc_date <= ?', "b.company = 'BP-TGM'"];
        const bp = [...custs, from, to];
        if (slms.length) { const x = cs.slmListSql(slms, { cust: 'b.cust_code', slm: 'b.slm_code', company: "'BP-TGM'" }); bw.push(x.sql); bp.push(...x.params); }
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
      // + ตัดลูกค้าที่ไม่นับเป็นยอดขาย (บริษัทในเครือ / Shop, 2026-10-14 — lib/nonSales.js)
      // ใบไม่มีรหัส Sales นับให้เจ้าของลูกค้าเฉพาะหัวใบ Express (TSS ล้วน) — ใบโรงงาน Bplus ไม่โอนให้ใคร (2026-10-20, code review)
      const scope = cs.resolveScope(db, req.user), nsx = require('../lib/nonSales');
      const filt = (x, blankToOwner) => {
        const w = [], p = [];
        if (slms.length) { const s = cs.slmListSql(slms, { cust: `${x}.cust_code`, slm: `${x}.slm_code`, company: blankToOwner ? null : "'BP-TGM'" }); w.push(s.sql); p.push(...s.params); }
        const sc = nsx.withExclude(db, cs.factSql(scope, { cust: `${x}.cust_code`, slm: `${x}.slm_code`, blankToOwner }), `${x}.cust_code`);
        w.push(sc.sql); p.push(...sc.params);
        return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p };
      };
      const fi = filt('i', true);
      // u = หน่วยขาย (2026-10-14, ผู้ใช้ขอ) — แยกแถวตามหน่วย ไม่บวกจำนวนต่างหน่วยรวมกัน (กก. + แพ็ค)
      // s = เจ้าของยอด (ใบไม่มีรหัส Sales → รหัสที่ master ผูกกับลูกค้า · ไม่มี = "(ไม่ระบุ)" รวม "(none)" ด้วย) — ตรงกับแท็บรายเซลส์ / ตัวกรอง Sales
      const sExpr = cs.ownerSlmExpr({ cust: 'i.cust_code', slm: 'i.slm_code' });
      const rows = db.prepare(`SELECT i.cust_code AS c, ${sExpr} AS s, l.sku AS k, MAX(l.sku_name) AS n,
          MAX(p.group_name) AS g, TRIM(COALESCE(l.unit_code, '')) AS u, SUM(l.qty) AS q, SUM(l.line_value) AS a
        FROM v_invoice_heads i JOIN invoice_lines l ON l.doc_num = i.doc_num AND l.company = ?
        LEFT JOIN products p ON p.code = l.sku
        WHERE i.doc_date >= ? AND i.doc_date <= ? AND COALESCE(i.rectyp, '') <> '5' AND ${salesDocSql('i.doc_num')}${fi.sql}
        GROUP BY i.cust_code, s, l.sku, u`).all(COMPANY, from, to, ...fi.params);
      try {
        const fb = filt('b', false);
        rows.push(...db.prepare(`SELECT b.cust_code AS c, COALESCE(NULLIF(NULLIF(TRIM(b.slm_code), ''), '(none)'), '(ไม่ระบุ)') AS s, l.sku AS k, MAX(COALESCE(sk.name, p.name, l.sku)) AS n,
            MAX(p.group_name) AS g, TRIM(COALESCE(l.unit_code, '')) AS u, SUM(l.qty) AS q, SUM(l.amount) AS a
          FROM bplus_invoices b JOIN bplus_invoice_lines l ON l.doc_key = b.doc_key
          LEFT JOIN bplus_skus sk ON sk.code = l.sku LEFT JOIN products p ON p.code = l.sku
          WHERE b.company = 'BP-TGM' AND b.is_cn = 0 AND b.doc_date >= ? AND b.doc_date <= ?${fb.sql}
          GROUP BY b.cust_code, s, l.sku, u`).all(from, to, ...fb.params));
      } catch (e) { /* ยังไม่มีตาราง Bplus */ }
      // สินค้าที่ไม่มีกลุ่มใน products (รหัสโรงงาน/บาร์โค้ด) → หากลุ่มจากรหัสขึ้นต้น/ชื่อ แบบเดียวกับแท็บรายสินค้า
      // (2026-10-14, ผู้ใช้แจ้ง "สินค้าบางรายการไม่ถูกจัดกลุ่ม" เช่น 20018-227 โทสต์แฮม) · หน่วยแปลงเป็นชื่อเดียวกัน
      // ทั้ง Express (รหัสย่อ กก/แพ) และ Bplus (ชื่อเต็ม กิโลกรัม/แพ็ค)
      const { resolve } = productGroupResolver(db);
      for (const r of rows) {
        if (!r.g && r.k) r.g = resolve(r.k, r.n, '') || null;
        r.u = unitLabel(r.u);
      }
      res.json({ from, to, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/', (req, res) => detail(req.query, res, req.user));
  router.post('/', (req, res) => detail(req.body || {}, res, req.user));

  // ชื่อสาขาจากที่อยู่จัดส่งของใบกำกับ (ARSHIP) เช่น "บมจ.ซีพี แอ็กซ์ตร้า (สาขา ราไวย์ 2) ..." → "ราไวย์ 2"
  // ใช้แสดงแทนชื่อบริษัทซ้ำๆ ในแถวสาขาของ Sales Overview (ชื่อที่ตั้งใน customer_profiles.branch มาก่อนเสมอ — ทำที่ client)
  router.get('/branch_names', (req, res) => {
    // ชื่อสาขาจากที่อยู่จัดส่ง — "สาขา X" / ชื่อในวงเล็บ / แขวงที่ส่ง (lib/shipBranch.js, 2026-10-12) · กรองตามสิทธิ์
    const all = require('../lib/shipBranch').shipBranchMap(db);
    const scope = scopeOf(req.user);
    const out = scope.all ? all : Object.fromEntries(Object.entries(all).filter(([c]) => cs.canSeeCust(scope, c)));
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
    const head = db.prepare('SELECT doc_num, doc_date, cust_code, slm_code, so_num, total, rectyp, route_name, ship_to_address FROM invoices WHERE doc_num = ?').get(doc)
      // เกิน 90 วัน: หัวใบอยู่ใน invoice_heads (ไม่มีสายรถ/ที่อยู่จัดส่ง) — 2026-10-19
      || db.prepare('SELECT doc_num, doc_date, cust_code, slm_code, so_num, total, rectyp, NULL AS route_name, NULL AS ship_to_address FROM invoice_heads WHERE doc_num = ?').get(doc)
      || null;
    const scope = scopeOf(req.user);
    const deny = () => res.status(404).json({ error: 'ไม่พบใบกำกับ หรือไม่มีสิทธิ์เห็นลูกค้ารายนี้' });
    // ผู้ถูกจำกัด: ต้องรู้ลูกค้าของใบ (มีหัวใบ) และลูกค้าอยู่ในสิทธิ์ · ใบที่ไม่มีหัวใบตรวจลูกค้าไม่ได้ = ไม่แสดง
    if (!scope.all && (lines.length || head) && (!head || !cs.canSeeCust(scope, head.cust_code))) return deny();
    if (!head && !lines.length) {
      // ใบกำกับโรงงาน (Bplus) — 2026-10-12
      try {
        const key = doc.startsWith('BP:') ? doc.slice(3) : doc;
        const bh = db.prepare(`SELECT doc_num, doc_date, cust_code, slm_code, NULL AS so_num, amount + vat_amount AS total,
          CASE WHEN is_cn = 1 THEN '5' ELSE '0' END AS rectyp, NULL AS route_name, NULL AS ship_to_address, 'TGM' AS company FROM bplus_invoices WHERE doc_key = ?`).get(key);
        if (bh) {
          if (!scope.all && !cs.canSeeCust(scope, bh.cust_code)) return deny();
          const bl = db.prepare(`SELECT ROW_NUMBER() OVER (ORDER BY l.rowid) AS seq_num, l.sku, COALESCE(s.name, p.name, l.sku) AS sku_name, NULL AS warehouse,
            l.qty, l.unit_code, l.amount AS line_value, p.group_name FROM bplus_invoice_lines l LEFT JOIN bplus_skus s ON s.code = l.sku
            LEFT JOIN products p ON p.code = l.sku WHERE l.doc_key = ?`).all(key);
          return res.json({ head: bh, lines: fillGroups(bl) });
        }
      } catch (e) { /* ไม่มีตาราง */ }
    }
    res.json({ head, lines: fillGroups(lines) });
  });

  return router;
}

module.exports = invoiceDetailRoutes;
