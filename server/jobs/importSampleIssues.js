'use strict';

// ดึงประวัติเบิกสินค้าตัวอย่าง/ชิม/แถม ปี 2569 จาก Express ห้อง TSS + TSS-NV → sample_issue_lines (2026-11-05)
// กติกาการอ่าน/หาเจ้าของอยู่ใน lib/sampleIssues.js · เรียกจาก runImport() ทุกรอบ แต่จะอ่านจริงเมื่อไฟล์เปลี่ยน
// และไม่ถี่กว่า SAMPLE_ISSUES_MIN_INTERVAL_MIN นาที (ค่าเริ่ม 60) — STCRD ของ TSS ใหญ่ ~265MB
const fs = require('fs');
const path = require('path');
const si = require('../lib/sampleIssues');

const MIN_INTERVAL_MS = (Number(process.env.SAMPLE_ISSUES_MIN_INTERVAL_MIN) || 60) * 60 * 1000;
const T = s => String(s ?? '').trim();

function hashOf(v) {
  const s = JSON.stringify(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

async function syncSampleIssues(db, { force = false } = {}) {
  const ife = require('./importFromExpress');
  const getState = db.prepare('SELECT mtime_ms, synced_at FROM sync_file_state WHERE source = ?');
  const setState = db.prepare(`INSERT INTO sync_file_state (source, mtime_ms, synced_at) VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET mtime_ms = excluded.mtime_ms, synced_at = excluded.synced_at`);

  const users = db.prepare('SELECT name, slm_id, slm_codes FROM sc_users WHERE is_active = 1 OR is_active IS NULL').all();
  const nickMap = si.buildNickMap(db.prepare('SELECT slm_id, name FROM salesmen').all(), users);
  // รหัสเซลส์ → ทุกรหัสของคนนั้น (ใช้หาลูกค้าของเจ้าของใบ)
  const ownerCodes = new Map();
  for (const u of users) {
    const codes = T(u.slm_codes || u.slm_id).split(',').map(T).filter(Boolean);
    const main = T(u.slm_id) || codes[0];
    if (main) for (const c of [main, `${main}-1`]) if (codes.includes(c) && !ownerCodes.has(c)) ownerCodes.set(c, codes);
  }
  const rulesSig = hashOf([[...nickMap].sort(), si.SOURCES, si.CUST_MATCH_VERSION]);

  // สถานะไฟล์ของทุกห้อง — เปลี่ยนห้องไหนก็สร้างใหม่ห้องนั้น
  const plans = [];
  for (const src of si.SOURCES) {
    const folder = path.join(ife.EXPRESS_ROOT, src.company);
    // ไฟล์ทุกตัวที่ใช้ — เปลี่ยนตัวไหนก็อ่านใหม่ (หมายเหตุ ARTRNRM / ราคาขาย STMAS ด้วย)
    const files = ['STCRD.DBF', 'STTRN.DBF', 'ARTRN.DBF', 'ARTRNRM.DBF', 'STMAS.DBF'].map(f => ife.findFile(folder, f)).filter(Boolean);
    if (!files.some(f => /stcrd\.dbf$/i.test(f))) continue;
    let mt;
    try { mt = files.map(f => fs.statSync(f).mtimeMs).reduce((a, b) => a + b, 0); } catch (e) { console.warn(`[sampleIssues] stat ${src.company} failed: ${e.message}`); continue; }
    const key = `${src.company}#sample_issues`;
    const prev = getState.get(key);
    const sig = mt + rulesSig;
    if (!force && prev && prev.mtime_ms === sig) continue;
    if (!force && prev && prev.synced_at && Date.now() - Date.parse(prev.synced_at) < MIN_INTERVAL_MS) continue;
    plans.push({ ...src, key, sig });
  }
  if (!plans.length) return 0;

  // ราคาขายแรกที่ > 0 ของสินค้า + ชื่อ/หน่วยหลัก (STMAS ของทั้งสองห้อง — products.unit เป็นชื่อหน่วยเต็ม เทียบกับ TQUCOD ไม่ได้)
  const products = new Map();
  for (const company of ['TSS', 'TSS-NV']) {
    for (const r of await ife.readTable(company, 'STMAS.DBF')) {
      const sku = T(r.STKCOD);
      if (!sku || products.get(sku)?.price) continue;
      const price = [r.SELLPR1, r.SELLPR2, r.SELLPR3, r.SELLPR4, r.SELLPR5].map(Number).find(x => x > 0) || 0;
      products.set(sku, { price, unit: T(r.QUCOD), name: T(r.STKDES) });
    }
  }
  const custNames = new Map(db.prepare('SELECT code, name FROM customers').all().map(r => [r.code, r.name]));
  // ลูกค้าในระบบ + ยอดขายปีนี้ — ใช้จับชื่อลูกค้าจากหมายเหตุ (lib/sampleIssues.js matchCustomer)
  const custIndex = si.buildCustIndex(db.prepare(`SELECT c.code, c.name, c.slm_id, COALESCE(s.amt, 0) AS sales FROM customers c
    LEFT JOIN (SELECT cust_code, SUM(amount) AS amt FROM invoice_sales_monthly WHERE ym >= ? GROUP BY cust_code) s ON s.cust_code = c.code`)
    .all(`${si.SAMPLE_YEAR}-01`));
  const personSlm = new Map(db.prepare('SELECT people_code, slm_code FROM sample_person_slm_map').all().map(r => [r.people_code, r.slm_code]));

  let imported = 0;
  for (const plan of plans) {
    const rows = await ife.readTable(plan.company, 'STCRD.DBF');
    if (!rows.length) { console.warn(`[sampleIssues] ${plan.company}/STCRD.DBF read 0 rows — skipped (share dropped?)`); continue; }
    const prefixes = new Set(plan.prefixes);
    const cancelled = new Set();
    const headerRemarks = new Map();
    // อ่านได้ 0 แถว = share หลุดกลางรอบ — ข้ามห้องนี้ ไม่บันทึกสถานะ (ไม่งั้นใบยกเลิก/หมายเหตุหายค้างจนไฟล์เปลี่ยนรอบหน้า)
    // ARTRNRM ใช้ readRemarks (cache ต่อรอบ sync ร่วมกับ job อื่น)
    const artrn = await ife.readTable(plan.company, 'ARTRN.DBF');
    const sttrn = await ife.readTable(plan.company, 'STTRN.DBF');
    const remarks = await ife.readRemarks(plan.company);
    if (!artrn.length || (plan.company === 'TSS' && !sttrn.length) || !remarks.length) {
      console.warn(`[sampleIssues] ${plan.company}: ARTRN/STTRN/ARTRNRM read 0 rows — skipped (share dropped?)`);
      continue;
    }
    const laOrder = new Map(); // ใบ LA → ใบ SL ที่อ้างถึง
    for (const r of artrn) {
      const doc = T(r.DOCNUM);
      if (T(r.DOCSTAT) === 'C') cancelled.add(doc);
      if (prefixes.has('LA') && doc.startsWith('LA') && T(r.SONUM)) laOrder.set(doc, T(r.SONUM));
    }
    const orderDocs = new Set(laOrder.values());
    for (const r of sttrn) {
      const doc = T(r.DOCNUM);
      if (!prefixes.has(doc.slice(0, 2))) continue;
      if (T(r.DOCSTAT) === 'C') cancelled.add(doc);
      headerRemarks.set(doc, T(r.REMARK));
    }
    const lineRemarks = new Map();
    const orderRemarks = new Map(); // หมายเหตุใบ SL ของใบ LA — ที่เก็บชื่อลูกค้าจริงของใบ LA
    for (const r of remarks) {
      const doc = T(r.DOCNUM);
      const t = T(r.REMARK);
      if (!t) continue;
      if (orderDocs.has(doc)) orderRemarks.set(doc, [...(orderRemarks.get(doc) || []), { seq: T(r.SEQNUM), text: t }]);
      if (prefixes.has(doc.slice(0, 2))) lineRemarks.set(doc, `${lineRemarks.get(doc) || ''} ${t}`);
    }
    const lines = si.buildLines(rows, { company: plan.company, prefixes, cancelled, headerRemarks, lineRemarks, nickMap, products, custNames, normalizeSlm: ife.normalizeSlmCode });

    // ชื่อลูกค้าจากหมายเหตุ (ใบละครั้ง): KA/KB/PD ใช้หมายเหตุหัวใบ · LA ใช้หมายเหตุใบ SL แล้วค่อยหมายเหตุของ LA เอง · ใบที่มีลูกค้าในใบอยู่แล้ว (LB/LD/LE) ไม่ต้องหา
    // เจอในระบบ = ใช้ชื่อในระบบ · ไม่เจอ = ใช้ข้อความหมายเหตุ · ไม่มีหมายเหตุ = คงชื่อเดิม (เชน / ผู้เบิก)
    const perDoc = new Map();
    for (const l of lines) {
      if (!['KA', 'KB', 'PD', 'LA'].includes(l.prefix) || l.cust_name === 'ออฟฟิศ') continue;
      if (!perDoc.has(l.doc_num)) {
        const remark = l.prefix === 'LA'
          ? (si.laRemarkText(orderRemarks.get(laOrder.get(l.doc_num))) || T(lineRemarks.get(l.doc_num)))
          : T(headerRemarks.get(l.doc_num));
        const owner = l.prefix === 'LA' ? (personSlm.get(l.cust_code) || '') : l.slm_code;
        const m = remark ? si.matchCustomer(remark, ownerCodes.get(owner) || owner, custIndex) : null;
        perDoc.set(l.doc_num, m ? { code: m.code, name: m.name, remark } : { code: '', name: remark ? si.displayFromRemark(remark) : '', remark });
      }
      const r = perDoc.get(l.doc_num);
      l.cust_match = r.code;
      if (r.name) l.cust_name = r.name;
      if (l.prefix === 'LA') l.remark = r.remark;
    }

    const ins = db.prepare(`INSERT OR REPLACE INTO sample_issue_lines (company, doc_num, seq, doc_date, prefix, kind, sku, loc_code, sku_name, qty, unit,
      cost_value, sell_value, cust_code, cust_name, slm_code, dept_code, remark, owner_src, cust_match) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM sample_issue_lines WHERE company = ? AND doc_date >= ? AND doc_date <= ?').run(plan.company, `${si.SAMPLE_YEAR}-01-01`, `${si.SAMPLE_YEAR}-12-31`);
      for (const l of lines) {
        ins.run(l.company, l.doc_num, l.seq, l.doc_date, l.prefix, l.kind, l.sku, l.loc_code, l.sku_name, l.qty, l.unit,
          l.cost_value, l.sell_value, l.cust_code, l.cust_name, l.slm_code, l.dept_code, l.remark, l.owner_src, l.cust_match || '');
      }
      setState.run(plan.key, plan.sig, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    imported += lines.length;
  }
  return imported;
}

module.exports = { syncSampleIssues };
