'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const ch = require('../lib/chainSales');
const cs = require('../lib/customerScope');

// ยอดขายรายสาขาห้าง (ห้อง SKU) — ดู lib/chainSales.js / jobs/importChainRooms.js (2026-10-07)
//   GET  /api/chain_sales/map             Master + สถิติข้อมูลที่ดึงแล้ว
//   POST /api/chain_sales/map/preview     {chain, sheets} → ผลอ่านไฟล์ (ไม่บันทึก)
//   PUT  /api/chain_sales/map/:chain      นำเข้าไฟล์ {sheets, file} และ/หรือ ตั้งค่า {replace, office_slm, aliases, keep_skus} (admin)
//   GET  /api/chain_sales/swap?from&to    มุมมองราย Sales: ช่วงรหัส DC ที่ถูกแทน + ยอดสาขาห้อง (กรองตามสิทธิ์ผู้ใช้)
module.exports = function chainSalesRoutes(db) {
  const router = express.Router();
  router.use(requireAuth(db));
  const ADMIN = ['admin', 'superadmin'];

  router.get('/map', (req, res) => {
    const map = ch.loadChainMap(db);
    const stats = {};
    for (const k of ch.CHAIN_KEYS) {
      const s = db.prepare(`SELECT MIN(ym) AS first, MAX(ym) AS last, COUNT(DISTINCT cust_code) AS branches FROM chain_sales_monthly WHERE chain = ?`).get(k);
      const y = new Date().getFullYear();
      const rows = db.prepare(`SELECT cust_code, SUM(amount) AS a FROM chain_sales_monthly WHERE chain = ? AND ym >= ? GROUP BY cust_code`).all(k, `${y}-01`);
      const bySlm = {};
      let total = 0;
      for (const r of rows) { const slm = ch.slmFor(map, k, r.cust_code) || '(ไม่ระบุ)'; bySlm[slm] = (bySlm[slm] || 0) + r.a; total += r.a; }
      // ค่า "เขต Sale" ที่ไม่ใช่รหัส Sales/ออฟฟิศ — ต้องตั้งตารางแปลง
      const labels = {};
      for (const v of Object.values(map.chains[k].cust)) if (!ch.isOffice(v) && !ch.isSlmCode(v)) labels[v] = (labels[v] || 0) + 1;
      const sync = db.prepare('SELECT synced_at FROM sync_file_state WHERE source LIKE ?').get(`chain/%${k === 'GO' ? 'GOWHOLES' : k === 'TOPS' ? 'TOPS-53' : 'MAKRO'}/ARTRN.DBF`);
      stats[k] = { ...s, synced_at: sync?.synced_at || null, ytd_total: total, ytd_by_slm: bySlm, labels };
    }
    // สิทธิ์ (2026-10-12, security review): ผู้ถูกจำกัดเห็นเฉพาะยอด/สาขาของรหัส Sales ตัวเอง — admin/ผู้เห็นทั้งหมดได้ครบเหมือนเดิม
    const scope = require('../lib/customerScope').resolveScope(db, req.user);
    if (!scope.all) {
      const mine = new Set((scope.slmCodes || []).map(String));
      const own = slm => mine.has(String(slm));
      const chains = {};
      for (const [k, c] of Object.entries(map.chains || {})) {
        chains[k] = { ...c, cust: Object.fromEntries(Object.entries(c.cust || {}).filter(([code]) => own(ch.slmFor(map, k, code)))), aliases: {}, groups: [] };
      }
      for (const k of Object.keys(stats)) {
        stats[k] = { ...stats[k], ytd_total: undefined, labels: {}, ytd_by_slm: Object.fromEntries(Object.entries(stats[k].ytd_by_slm || {}).filter(([slm]) => own(slm))) };
      }
      return res.json({ ...map, chains, stats });
    }
    res.json({ ...map, stats });
  });

  router.post('/map/preview', (req, res) => res.json(ch.parseChainFile(req.body?.sheets)));

  router.put('/map/:chain', requireRole(...ADMIN), (req, res) => {
    const k = String(req.params.chain || '').toUpperCase();
    if (!ch.CHAIN_KEYS.includes(k)) return res.status(400).json({ error: 'ไม่รู้จักห้าง' });
    const body = req.body || {};
    const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type = ?').get(ch.ENTITY);
    let v = {};
    try { v = JSON.parse(row?.levels_json || '{}') || {}; } catch { v = {}; }
    v.chains = v.chains || {};
    const cur = { ...(v.chains[k] || {}) };
    if (body.sheets) {
      const p = ch.parseChainFile(body.sheets);
      if (!p.custCount) return res.status(400).json({ error: p.warnings[0] || 'ไม่พบข้อมูลจับคู่สาขาในไฟล์' });
      Object.assign(cur, { cust: p.cust, groups: p.groups.length ? p.groups : (cur.groups || []), file: String(body.file || '').slice(0, 200),
        imported_at: new Date().toISOString(), imported_by: req.user.uid });
    }
    if (body.replace !== undefined) cur.replace = !!body.replace;
    if (body.office_slm !== undefined) cur.office_slm = String(body.office_slm || '').trim().slice(0, 20);
    if (body.keep_skus !== undefined) {
      if (!Array.isArray(body.keep_skus)) return res.status(400).json({ error: 'keep_skus ต้องเป็นรายการ' });
      cur.keep_skus = [...new Set(body.keep_skus.map(s => String(s || '').trim().toUpperCase().slice(0, 10)).filter(Boolean))];
    }
    if (body.aliases !== undefined) {
      if (!body.aliases || typeof body.aliases !== 'object') return res.status(400).json({ error: 'ตารางแปลงไม่ถูกต้อง' });
      cur.aliases = Object.fromEntries(Object.entries(body.aliases).map(([a, b]) => [String(a).slice(0, 60), String(b || '').trim().slice(0, 20)]).filter(([, b]) => b));
    }
    if (cur.replace && !(cur.groups || []).length) return res.status(400).json({ error: 'ยังไม่มีชีตเทียบห้อง SKU ↔ ห้อง VAT — นำเข้าไฟล์ที่มีชีตนี้ก่อนเปิด "แทนยอด DC"' });
    v.chains[k] = cur;
    db.prepare(`INSERT INTO approval_workflow_templates (entity_type, levels_json, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(ch.ENTITY, JSON.stringify(v), req.user.uid);
    res.json(ch.loadChainMap(db));
  });

  router.get('/swap', (req, res) => {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}(-\d{2})?$/.test(from) || !/^\d{4}-\d{2}(-\d{2})?$/.test(to) || from.length !== to.length) return res.status(400).json({ error: 'from/to ต้องเป็น YYYY-MM หรือ YYYY-MM-DD' });
    const map = ch.loadChainMap(db);
    const scope = cs.resolveScope(db, req.user);
    let rows = ch.chainFacts(db, map, from, to);
    if (!scope.all) { const ok = new Set(scope.slmCodes); rows = rows.filter(r => ok.has(r.slm_code)); }
    // ชื่อสาขา/เครือ — รหัสสาขาห้อง SKU ไม่มีในรายชื่อลูกค้าฝั่งหน้าเว็บ
    const CORP = { TOPS: 'Tops', MAKRO: 'Makro', GO: 'GO Wholesale' };
    const names = new Map(db.prepare('SELECT code, name FROM chain_customers').all().map(r => [r.code, r.name]));
    res.json({ ranges: ch.replacedRanges(map), rows: rows.map(r => ({ ...r, cust_name: names.get(r.cust_code) || r.cust_code, corp: CORP[r.chain] || r.chain })) });
  });
  return router;
};
