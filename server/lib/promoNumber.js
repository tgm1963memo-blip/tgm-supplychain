// เลขที่ใบเคาะ / ใบโปร ตามรหัสลูกค้า (2026-10-03, ผู้ใช้กำหนด) — ตารางจากไฟล์
// "รหัสใบเคาะ ใบโปร Modern trade_update300926.xlsx" ชีต "รหัสใบโปรโมชั่น": ช่วงรหัสลูกค้า (คอลัมน์ H หรือ I
// "แก้ไข/เพิ่มเติม" ถ้ามี) → รหัสใบเคาะ (L เช่น 1LTA0000) / รหัสใบโปร (M เช่น LTA0000)
//   · เลข = รหัส + ปี พ.ศ. 2 หลัก + "-" + เดือน 2 หลัก + เลขวิ่ง 3 หลัก (วิ่งใหม่ทุกเดือนต่อรหัส) เช่น 1LTA69-10001
//   · เอกสารที่มีหลายสาขา → กฎที่ตรงกับสาขามากที่สุด (เท่ากัน = แถวบนสุดในไฟล์)
//   · จับคู่สาขา: ตรงตัวก่อน ไม่เจอลองคู่ CONSI (01-L2-0005 → BB-L2-0005) เหมือน _draftConsiPairCode ฝั่ง client
//   · ไม่เข้ากฎ (หรือยังไม่ได้นำเข้าตาราง) → เลขเดิมของระบบ PC<พ.ศ.>-0001 / PM<พ.ศ.>-0001
// แทนวิธีเดิม (2026-09-24) ที่ต่อเลขชุด Express ของกลุ่มลูกค้า (LT-0149 → LT-0150)
const CODE_MAP_ENTITY = 'promo_code_map';
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const CODE_RE = /^([A-Z0-9]+-[A-Z0-9]+-)(\d+)$/i;

// แปลงแถวดิบจาก Excel ({row, A, B, ..., M}) เป็นกฎ — ชื่อ/รหัสลูกค้า (A/B) ว่างในแถวต่อมา = ใช้ของแถวก่อนหน้า
function parseCodeMap(rows) {
  const rules = [], skipped = [];
  let name = '', code = '';
  for (const r of Array.isArray(rows) ? rows : []) {
    const s = k => String(r?.[k] ?? '').replace(/\s+/g, ' ').trim();
    if (s('A')) { name = s('A'); code = s('B'); }
    const src = s('I') || s('H');
    const label = `แถว ${r?.row ?? '?'} ${name}${s('F') ? ' ' + s('F') : ''}`;
    if (!src && !s('L') && !s('M')) continue;
    if (!src || /ยกเลิก/.test(src) || /^-+$/.test(src)) { skipped.push({ row: r?.row, name, cls: s('F'), reason: src ? `รหัสลูกค้า "${src}"` : 'ไม่มีรหัสลูกค้า', label }); continue; }
    const kc = s('L').toUpperCase().match(/^(\d?[A-Z]+)0000$/), pm = s('M').toUpperCase().match(/^([A-Z]+)0000$/);
    if (!kc || !pm) { skipped.push({ row: r?.row, name, cls: s('F'), reason: `รหัสใบเคาะ "${s('L')}" / ใบโปร "${s('M')}" ไม่ใช่รูปแบบ …0000`, label }); continue; }
    const t = src.toUpperCase().replace(/\s+/g, ' ');
    let m = t.match(/^([A-Z0-9]+-[A-Z0-9]+-)(\d+) ?(?:-|ถึง) ?(?:[A-Z0-9]+-[A-Z0-9]+-)?(\d+)$/);
    let rule = null;
    if (m) rule = { prefix: m[1], from: +m[2], to: +m[3] };
    else if ((m = t.match(/^([A-Z0-9]+-[A-Z0-9]+-)(\d+) ?ถึง ?สุดท้าย$/))) rule = { prefix: m[1], from: +m[2], to: 999999 };
    else if ((m = t.match(CODE_RE))) rule = { prefix: m[1], from: +m[2], to: +m[2] };
    if (!rule || rule.to < rule.from) { skipped.push({ row: r?.row, name, cls: s('F'), reason: `อ่านช่วงรหัสลูกค้าไม่ได้ "${src}"`, label }); continue; }
    // ชื่อเซลล์ (N) / ชื่อผู้จัดการ (O) (2026-10-06) — master สิทธิ์การเห็นเจ้า MT (lib/customerScope.js) · หลายชื่อคั่น , / ·
    // เก็บชื่อตามไฟล์ ไม่ตัด 'คุณ' ออก (ปู กับ คุณปู เป็นคนละคน) — จับคู่ชื่อ→ผู้ใช้ในหน้า ทีมขาย
    const names = k => s(k).split(/[,，/]+/).map(x => x.trim()).filter(x => x && x !== '-');
    rules.push({ row: r?.row, name, code, type: s('E'), cls: s('F'), src, ...rule, kc: kc[1], pm: pm[1], sales: names('N'), manager: names('O') });
  }
  return { rules, skipped };
}

function loadCodeMap(db) {
  const row = db.prepare('SELECT levels_json, updated_at FROM approval_workflow_templates WHERE entity_type = ?').get(CODE_MAP_ENTITY);
  const v = parse(row?.levels_json) || {};
  return { rules: Array.isArray(v.rules) ? v.rules : [], skipped: Array.isArray(v.skipped) ? v.skipped : [], file: v.file || '', imported_at: v.imported_at || row?.updated_at || '', imported_by: v.imported_by || '' };
}

function ruleForCode(rules, cust) {
  const one = c => {
    const m = String(c || '').trim().toUpperCase().match(CODE_RE);
    if (!m) return null;
    return rules.find(r => r.prefix === m[1] && +m[2] >= r.from && +m[2] <= r.to) || null;
  };
  const c = String(cust || '').trim();
  return one(c) || (/^[^-]+-.+-.+$/.test(c) ? one(c.replace(/^[^-]+-/, 'BB-')) : null);
}
// กฎของเอกสาร = กฎที่ตรงกับสาขามากที่สุด (เท่ากัน = แถวบนสุดในไฟล์)
function ruleForCodes(rules, codes) {
  const cnt = new Map();
  for (const c of new Set((codes || []).map(String))) { const r = ruleForCode(rules, c); if (r) cnt.set(r, (cnt.get(r) || 0) + 1); }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1] || (a[0].row || 0) - (b[0].row || 0))[0]?.[0] || null;
}

// ปี พ.ศ. 2 หลัก + "-" + เดือน 2 หลัก ของวันที่ (เวลาเครื่อง server = เวลาไทย)
function ymPart(date) {
  const d = date ? new Date(date) : new Date();
  const dd = isNaN(d) ? new Date() : d;
  return `${String((dd.getFullYear() + 543) % 100).padStart(2, '0')}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
}
// เลขถัดไปของรหัส base ในเดือนนั้น: MAX ของ base+YY-MM### ที่มีอยู่ใน doc_no / promo_no + 1
// (single-writer node:sqlite — เรียกใน transaction ของผู้เรียก ไม่มี race)
function nextCodeNo(db, base, col, date, exclude = new Set()) {
  if (!['doc_no', 'promo_no'].includes(col)) throw new Error('bad column');
  const head = `${base}${ymPart(date)}`;
  let max = 0;
  db.prepare(`SELECT ${col} AS v FROM promo_draft_headers WHERE ${col} LIKE ?`).all(`${head}%`).forEach(x => {
    if (exclude.has(x.v)) return;
    const m = String(x.v || '').slice(head.length).match(/^(\d{3})$/);
    if (m && +m[1] > max) max = +m[1];
  });
  if (max >= 999) throw new Error(`เลขที่ ${head}xxx เต็ม 999 ใบในเดือนนี้แล้ว`);
  return `${head}${String(max + 1).padStart(3, '0')}`;
}

// ชุดเดิมของระบบ (ไม่เข้ากฎ) — PC<พ.ศ.>-0001 / PM<พ.ศ.>-0001 วิ่งต่อปี
function fallbackNo(db, col, kind) {
  const prefix = `${kind}${new Date().getFullYear() + 543}-`;
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(${col}, LENGTH(?) + 1) AS INTEGER)) AS maxN FROM promo_draft_headers WHERE ${col} LIKE ?`).get(prefix, `${prefix}%`);
  return `${prefix}${String((row?.maxN || 0) + 1).padStart(4, '0')}`;
}

// รหัสสาขาของเอกสาร: บรรทัดสินค้า หรือ form_extra_json.branches (เอกสารนอกสัญญา)
function docCustCodes(db, header) {
  let codes = db.prepare('SELECT DISTINCT cust_code FROM promo_drafts WHERE draft_no = ?').all(header.draft_no).map(r => r.cust_code).filter(Boolean);
  if (!codes.length) { const fx = parse(header.form_extra_json) || {}; codes = Array.isArray(fx.branches) ? fx.branches.map(String) : []; }
  return codes;
}

function nextDocNoFor(db, codes, date) {
  const r = ruleForCodes(loadCodeMap(db).rules, codes);
  return r ? nextCodeNo(db, r.kc, 'doc_no', date) : fallbackNo(db, 'doc_no', 'PC');
}
function nextPromoNoFor(db, header, date) {
  const r = ruleForCodes(loadCodeMap(db).rules, docCustCodes(db, header));
  return r ? nextCodeNo(db, r.pm, 'promo_no', date) : fallbackNo(db, 'promo_no', 'PM');
}
// รหัสใบเคาะของเลขที่เอกสาร (1LTA69-10001 → 1LTA) — เลขเดิม PC… = ''
function docNoBase(no) { const m = String(no || '').match(/^(\d?[A-Z]+)\d{2}-\d{5}$/); return m ? m[1] : ''; }

// ทดสอบ: รหัสลูกค้า → กฎ + เลขถัดไป (หน้าตั้งค่า)
function previewForCodes(db, codes) {
  const r = ruleForCodes(loadCodeMap(db).rules, codes);
  return {
    rule: r,
    next_doc_no: r ? nextCodeNo(db, r.kc, 'doc_no') : fallbackNo(db, 'doc_no', 'PC'),
    next_promo_no: r ? nextCodeNo(db, r.pm, 'promo_no') : fallbackNo(db, 'promo_no', 'PM'),
  };
}

// ออกเลขใหม่ให้เอกสารทั้งหมดตามตาราง (ครั้งเดียว ตอนเปลี่ยนรูปแบบ) — ไล่ตามวันที่สร้าง; doc_no จากเดือนที่สร้าง,
// promo_no จากเดือนที่อนุมัติ (บันทึก log 'approve' ครั้งล่าสุด หรือ updated_at) · เอกสารที่ไม่เข้ากฎคงเลขเดิม
// คืนรายการ {draft_no, old_doc_no, new_doc_no, old_promo_no, new_promo_no} — apply=false = ดูตัวอย่างเท่านั้น
function planRenumberAll(db) {
  const rules = loadCodeMap(db).rules;
  const hs = db.prepare('SELECT * FROM promo_draft_headers ORDER BY created_at, draft_no').all();
  const taken = { doc_no: new Map(), promo_no: new Map() };
  const seqNext = (col, base, date) => {
    const head = `${base}${ymPart(date)}`;
    const n = (taken[col].get(head) || 0) + 1;
    taken[col].set(head, n);
    return `${head}${String(n).padStart(3, '0')}`;
  };
  // วันที่อนุมัติครบ: log 'approved_final' > เวลาอนุมัติล่าสุดในขั้นอนุมัติ (เอกสารก่อนมี log) > updated_at
  const approvedAt = h => {
    const lg = db.prepare("SELECT ts FROM promo_draft_logs WHERE draft_no = ? AND action = 'approved_final' ORDER BY ts DESC LIMIT 1").get(h.draft_no)?.ts;
    if (lg) return lg;
    const ts = [...(parse(h.approval_history_json) || []), ...(parse(h.levels_json) || [])]
      .flatMap(lv => (lv?.approvers || []).map(a => a.status === 'approved' ? a.ts : null)).filter(Boolean).sort();
    return ts[ts.length - 1] || h.updated_at || h.created_at;
  };
  return hs.map(h => {
    const r = ruleForCodes(rules, docCustCodes(db, h));
    return {
      draft_no: h.draft_no, status: h.status, promo_name: h.promo_name || '', rule: r ? `${r.name} ${r.type} ${r.cls}`.trim() : '',
      old_doc_no: h.doc_no, new_doc_no: r ? seqNext('doc_no', r.kc, h.created_at) : h.doc_no,
      old_promo_no: h.promo_no || null, new_promo_no: h.promo_no ? (r ? seqNext('promo_no', r.pm, approvedAt(h)) : h.promo_no) : null,
    };
  });
}

module.exports = {
  CODE_MAP_ENTITY, parseCodeMap, loadCodeMap, ruleForCode, ruleForCodes, nextCodeNo, nextDocNoFor, nextPromoNoFor,
  docCustCodes, docNoBase, previewForCodes, planRenumberAll, ymPart,
};
