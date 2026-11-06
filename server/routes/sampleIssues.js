'use strict';

// ประวัติเบิกสินค้าตัวอย่าง/ชิม/แถม จาก Express (2026-11-05) — หน้า "ของตัวอย่าง" › 📊 ประวัติเบิก (Express)
// สิทธิ์: เซลส์เห็นเฉพาะของตัวเอง/ทีมตาม lib/customerScope.js (เจ้าของ = owner_slm ใน v_sample_issue_lines)
// มูลค่าทุนส่งเฉพาะ COST_ROLES — เซลส์ได้เฉพาะราคาขาย (ตัดที่ server ไม่ใช่แค่ซ่อนหน้าเว็บ)
const express = require('express');
const { requireRole } = require('../middleware/auth');
const cs = require('../lib/customerScope');

const COST_ROLES = ['superadmin', 'admin', 'manager', 'sales_manager'];
// ระบุเจ้าของ/จับคู่ผู้เบิก: ใบที่รอระบุยังไม่มีเจ้าของ จึงกรองตามทีมไม่ได้ — ให้เฉพาะคนที่เห็นภาพรวมทั้งบริษัท
// (sales_manager ที่ดูแลแค่บางทีมทำไม่ได้ ไม่งั้นเห็นทุนของทุกใบและโอนใบทีมอื่นมาทีมตัวเองได้ — code review 2026-11-05)
const MANAGE_ROLES = COST_ROLES;
const SLM_RE = /^[0-9A-Za-z][0-9A-Za-z-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const T = s => String(s ?? '').trim();

module.exports = function sampleIssuesRoutes(db) {
  const router = express.Router();

  // รหัสเซลส์ → ชื่อที่อ่านง่าย: ชื่อบัญชีผู้ใช้ (มีชื่อเล่น) ก่อน แล้วค่อยชื่อใน Express (ตัดเบอร์โทร)
  function slmNames() {
    const out = {};
    for (const s of db.prepare('SELECT slm_id, name FROM salesmen').all()) {
      const n = T(s.name).replace(/[.\-]?\s*0\d{8,9}.*$/, '').replace(/\s*\d{2}-\d{3}-\d{4}.*$/, '');
      out[s.slm_id] = /^\*+$/.test(n) ? '(รหัสเลิกใช้)' : n;
    }
    // slm_codes ของ sales_manager คือรหัสลูกทีม ไม่ใช่รหัสตัวเอง — ใช้แค่รหัสแรก และไม่ทับชื่อเจ้าของรหัส
    // (เคยทำให้เซลส์ทั้งทีมแสดงเป็นชื่อหัวหน้าทีม)
    const users = db.prepare("SELECT name, role, slm_id, slm_codes FROM sc_users WHERE COALESCE(is_active, 1) = 1").all();
    const codesOf = u => T(u.slm_codes || u.slm_id).split(',').map(T).filter(Boolean);
    const taken = new Set();
    for (const u of users.filter(x => x.role !== 'sales_manager')) {
      for (const c of codesOf(u)) { out[c] = T(u.name); taken.add(c); }
    }
    for (const u of users.filter(x => x.role === 'sales_manager')) {
      const own = T(u.slm_id) || codesOf(u)[0];
      if (own && !taken.has(own)) out[own] = T(u.name);
    }
    return out;
  }
  const canCost = u => COST_ROLES.includes(u?.role);
  const canManage = u => ['superadmin', 'admin', 'manager'].includes(u?.role)
    || (u?.role === 'sales_manager' && cs.resolveScope(db, u).all === true);
  const requireManage = (req, res, next) => canManage(req.user) ? next() : res.status(403).json({ error: 'เฉพาะผู้ดูแลที่เห็นภาพรวมทั้งบริษัท' });

  // GET /lines?from=YYYY-MM-DD&to=YYYY-MM-DD — บรรทัดเบิกทั้งหมดในช่วง (หน้าเว็บทำ pivot เอง)
  // แถว: [วันที่, เลขที่, เล่ม, ประเภท, รหัสสินค้า, ชื่อสินค้า, จำนวน, หน่วย, ราคาขาย, ทุน|null, เจ้าของ, รหัสลูกค้า, ชื่อลูกค้า, ที่มาเจ้าของ]
  router.get('/lines', (req, res) => {
    const from = DATE_RE.test(req.query.from) ? req.query.from : '2026-01-01';
    const to = DATE_RE.test(req.query.to) ? req.query.to : '2026-12-31';
    const where = ['doc_date >= ?', 'doc_date <= ?'];
    const params = [from, to];
    const f = cs.factSql(cs.resolveScope(db, req.user), { cust: 'cust_code', slm: 'owner_slm' });
    if (f) { where.push(f.sql); params.push(...f.params); }
    const cost = canCost(req.user);
    const rows = db.prepare(`SELECT doc_date, doc_num, prefix, kind, sku, sku_name, qty, unit, sell_value, cost_value, owner_slm,
        cust_code, cust_match, cust_name, owner_cust_name, owner_from FROM v_sample_issue_lines WHERE ${where.join(' AND ')} ORDER BY doc_date, doc_num, seq`)
      .all(...params)
      // รหัสลูกค้า (คอลัมน์ที่หน้าเว็บใช้จัดกลุ่ม): ผู้จัดการพิมพ์ชื่อเอง = จัดกลุ่มตามชื่อนั้น · จับลูกค้าในระบบได้ = รหัสนั้น · อื่นๆ = รหัสในใบ
      // ใบ LA รหัสในใบเป็นรหัสพนักงาน ไม่ใช่ลูกค้า — ส่งว่างให้จัดกลุ่มตามชื่อ ไม่งั้นลูกค้าทุกรายของผู้เบิกคนเดียวถูกรวมเป็นแถวเดียว
      .map(r => [r.doc_date, r.doc_num, r.prefix, r.kind, r.sku, r.sku_name, r.qty, r.unit, r.sell_value, cost ? r.cost_value : null,
        r.owner_slm, r.owner_cust_name !== r.cust_name ? '' : (r.cust_match || (r.prefix === 'LA' ? '' : r.cust_code)), r.owner_cust_name, r.owner_from]);
    const sync = db.prepare("SELECT MAX(synced_at) AS at FROM sync_file_state WHERE source LIKE '%#sample_issues'").get();
    res.json({ from, to, can_cost: cost, can_manage: canManage(req.user), synced_at: sync?.at || null, slm_names: slmNames(), rows });
  });

  // GET /unresolved — ใบที่ยังไม่มีเจ้าของ + ผู้เบิกใบ LA ที่ยังไม่จับคู่ (ผู้จัดการ)
  router.get('/unresolved', requireRole(...MANAGE_ROLES), requireManage, (req, res) => {
    const docs = db.prepare(`SELECT doc_num, prefix, MIN(doc_date) AS doc_date, MAX(remark) AS remark, MAX(owner_cust_name) AS cust_name,
        MAX(owner_from) AS owner_from, COUNT(*) AS items, ROUND(SUM(cost_value), 2) AS cost_value, ROUND(SUM(COALESCE(sell_value, 0)), 2) AS sell_value
      FROM v_sample_issue_lines WHERE owner_slm = '' AND prefix <> 'LA' GROUP BY doc_num, prefix ORDER BY cost_value DESC`).all();
    const people = db.prepare(`SELECT l.cust_code AS people_code, COALESCE((SELECT name FROM customers WHERE code = l.cust_code LIMIT 1), l.cust_code) AS name, COUNT(DISTINCT l.doc_num) AS docs,
        ROUND(SUM(l.cost_value), 2) AS cost_value, pm.slm_code
      FROM sample_issue_lines l LEFT JOIN sample_person_slm_map pm ON pm.people_code = l.cust_code
      WHERE l.prefix = 'LA' GROUP BY l.cust_code ORDER BY (pm.slm_code IS NULL) DESC, cost_value DESC`).all();
    res.json({ docs, people, slm_names: slmNames() });
  });

  // รหัสต้องเป็นรูปแบบรหัสเซลส์ และมีอยู่จริงใน Express หรือในบัญชีผู้ใช้ (เทียบแบบตรงตัว ไม่ใช้ LIKE — กัน % / _ ผ่าน)
  const validSlm = code => !code || (SLM_RE.test(code) && (!!db.prepare('SELECT 1 FROM salesmen WHERE slm_id = ?').get(code)
    || !!db.prepare("SELECT 1 FROM sc_users WHERE instr(',' || REPLACE(COALESCE(slm_codes, slm_id, ''), ' ', '') || ',', ',' || ? || ',') > 0").get(code)));

  // PUT /owner/:doc_num { slm_code, cust_name?, note? } — slm_code ว่างและไม่มี cust_name = ลบค่าที่ระบุไว้
  router.put('/owner/:doc_num', requireRole(...MANAGE_ROLES), requireManage, (req, res) => {
    const doc = T(req.params.doc_num);
    const slm = T(req.body?.slm_code), custName = T(req.body?.cust_name).slice(0, 200), note = T(req.body?.note).slice(0, 500);
    if (!db.prepare('SELECT 1 FROM sample_issue_lines WHERE doc_num = ?').get(doc)) return res.status(404).json({ error: 'ไม่พบใบเบิกนี้' });
    if (!validSlm(slm)) return res.status(400).json({ error: `ไม่พบรหัสเซลส์ ${slm}` });
    if (!slm && !custName) {
      db.prepare('DELETE FROM sample_issue_owner_override WHERE doc_num = ?').run(doc);
      return res.json({ ok: true, removed: true });
    }
    db.prepare(`INSERT INTO sample_issue_owner_override (doc_num, slm_code, cust_name, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_num) DO UPDATE SET slm_code = excluded.slm_code, cust_name = excluded.cust_name, note = excluded.note,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(doc, slm, custName || null, note || null, req.user.uid, new Date().toISOString());
    res.json({ ok: true });
  });

  // PUT /person/:people_code { slm_code } — ผู้เบิกใบ LA → เซลส์ · slm_code ว่าง = ลบการจับคู่
  router.put('/person/:people_code', requireRole(...MANAGE_ROLES), requireManage, (req, res) => {
    const code = T(req.params.people_code), slm = T(req.body?.slm_code);
    if (!validSlm(slm)) return res.status(400).json({ error: `ไม่พบรหัสเซลส์ ${slm}` });
    if (!slm) { db.prepare('DELETE FROM sample_person_slm_map WHERE people_code = ?').run(code); return res.json({ ok: true, removed: true }); }
    db.prepare(`INSERT INTO sample_person_slm_map (people_code, slm_code, updated_by, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(people_code) DO UPDATE SET slm_code = excluded.slm_code, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(code, slm, req.user.uid, new Date().toISOString());
    res.json({ ok: true });
  });

  return router;
};

module.exports.COST_ROLES = COST_ROLES;
