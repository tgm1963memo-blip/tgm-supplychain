// เลขที่ใบโปรโมชั่นแยกตามลูกค้า (2026-09-24, ยืนยันกับผู้ใช้): ต่อเลขชุดเดิมของลูกค้าใน Express
// เช่น โลตัส ใบล่าสุดใน Express = LT-0149 → ใบเคาะที่อนุมัติถัดไปได้ LT-0150
//   · กลุ่มลูกค้าของเอกสาร = กลุ่ม (customer_profiles.corporate) ที่มีสาขาในเอกสารมากที่สุด เทียบชื่อแบบตัดคำต่อท้าย
//     ("โลตัส" = "โลตัส TGM" = "โลตัส (ยอดสั่ง)") เหมือน _draftCorpBase ฝั่ง client
//   · ตัวอักษรนำ: ตั้งเองที่ entity 'promo_no_prefixes' ก่อน ไม่มีค่อยหาจากหมายเหตุอ้างอิง (doc_ref) ของใบโปรใน
//     Express ของกลุ่มนั้นที่ใช้บ่อยที่สุด (LT-xxxx, CJ-xxxx, VL-xxxx …)
//   · เลขถัดไป = เลขสูงสุดของตัวอักษรนำนั้น (ทั้งใน Express และที่ระบบออกไปแล้ว) + 1
//   · หาไม่ได้เลย → ชุดเดิมของระบบ PM<พ.ศ.>-xxxx (ไม่ทำให้อนุมัติไม่ผ่าน)
const PREFIXES_ENTITY = 'promo_no_prefixes';
const PREFIX_RE = /^[A-Z]{1,6}$/;
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

function corpBase(corp) {
  const c = String(corp || '').replace(/\([^)]*\)/g, ' ').replace(/\b(TGM|TSS|CONSI)\b/gi, ' ').replace(/ตู้\S*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return !c || c === '-' || c === 'ไม่ระบุ' || c === 'ไม่ระบุกลุ่ม' ? '' : c;
}

function validatePrefixes(list) {
  if (!Array.isArray(list)) return 'รูปแบบตัวอักษรนำเลขที่ใบโปรไม่ถูกต้อง';
  const seen = new Set();
  for (const r of list) {
    const base = corpBase(r && r.corp);
    if (!base) return 'กรุณาระบุกลุ่มลูกค้าทุกแถว';
    if (!PREFIX_RE.test(String(r.prefix || ''))) return 'ตัวอักษรนำต้องเป็นภาษาอังกฤษตัวใหญ่ 1-6 ตัว เช่น LT';
    if (seen.has(base)) return `กลุ่มลูกค้า "${r.corp}" ซ้ำกัน`;
    seen.add(base);
  }
  return null;
}

// กลุ่มลูกค้าหลักของเอกสาร (ฐานชื่อ) จากสาขาในบรรทัดสินค้า หรือ form_extra_json.branches (เอกสารนอกสัญญา)
function docCorpBase(db, header) {
  let codes = db.prepare('SELECT DISTINCT cust_code FROM promo_drafts WHERE draft_no = ?').all(header.draft_no).map(r => r.cust_code).filter(Boolean);
  if (!codes.length) { const fx = parse(header.form_extra_json) || {}; codes = Array.isArray(fx.branches) ? fx.branches.map(String) : []; }
  const counts = new Map();
  for (let i = 0; i < codes.length; i += 500) {
    const chunk = codes.slice(i, i + 500);
    db.prepare(`SELECT corporate FROM customer_profiles WHERE code IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
      .forEach(r => { const b = corpBase(r.corporate); if (b) counts.set(b, (counts.get(b) || 0) + 1); });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

// ตัวอักษรนำของกลุ่ม: ตั้งค่าเอง > ที่ใช้บ่อยสุดใน doc_ref ของใบโปร Express ของกลุ่มนั้น
function prefixFor(db, base) {
  if (!base) return { prefix: '', source: 'none' };
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type = ?').get(PREFIXES_ENTITY);
  const conf = (parse(row?.levels_json) || []).find(r => corpBase(r && r.corp) === base);
  if (conf && PREFIX_RE.test(String(conf.prefix || ''))) return { prefix: conf.prefix, source: 'config' };
  const counts = new Map();
  db.prepare(`SELECT cp.corporate AS corp, UPPER(SUBSTR(TRIM(d.doc_ref), 1, INSTR(TRIM(d.doc_ref), '-') - 1)) AS p, COUNT(*) AS n
    FROM promo_docs d JOIN customer_profiles cp ON cp.code = d.cust_code
    WHERE INSTR(TRIM(COALESCE(d.doc_ref, '')), '-') > 1 GROUP BY cp.corporate, p`).all()
    .forEach(r => { if (corpBase(r.corp) === base && PREFIX_RE.test(r.p || '')) counts.set(r.p, (counts.get(r.p) || 0) + r.n); });
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? { prefix: best[0], source: 'express' } : { prefix: '', source: 'none' };
}

// เลขถัดไปของตัวอักษรนำ: สูงสุดใน Express (doc_ref "LT-0149 …") และที่ระบบออกแล้ว (promo_no "LT-0150") + 1
function nextForPrefix(db, prefix) {
  const numOf = s => { const m = String(s || '').trim().toUpperCase().match(new RegExp(`^${prefix}-(\\d+)`)); return m ? Number(m[1]) : 0; };
  let max = 0, width = 4;
  const like = `${prefix}-%`;
  db.prepare('SELECT DISTINCT TRIM(doc_ref) AS r FROM promo_docs WHERE UPPER(TRIM(doc_ref)) LIKE ?').all(like).forEach(x => {
    const n = numOf(x.r); if (n > max) { max = n; width = Math.max(4, (String(x.r).trim().match(/-(\d+)/) || [, ''])[1].length); }
  });
  db.prepare('SELECT promo_no FROM promo_draft_headers WHERE promo_no LIKE ?').all(like).forEach(x => { const n = numOf(x.promo_no); if (n > max) max = n; });
  return `${prefix}-${String(max + 1).padStart(width, '0')}`;
}

// ชุดเดิมของระบบ (ใช้เมื่อหาตัวอักษรนำของลูกค้าไม่ได้)
function fallbackPromoNo(db) {
  const prefix = `PM${new Date().getFullYear() + 543}-`;
  const row = db.prepare('SELECT MAX(CAST(SUBSTR(promo_no, LENGTH(?) + 1) AS INTEGER)) AS maxN FROM promo_draft_headers WHERE promo_no LIKE ?').get(prefix, `${prefix}%`);
  return `${prefix}${String((row?.maxN || 0) + 1).padStart(4, '0')}`;
}

function nextPromoNoFor(db, header) {
  const { prefix } = prefixFor(db, docCorpBase(db, header));
  return prefix ? nextForPrefix(db, prefix) : fallbackPromoNo(db);
}

// ตัวอย่างเลขถัดไปของกลุ่ม (หน้าตั้งค่า)
function previewForCorp(db, corp) {
  const base = corpBase(corp);
  const { prefix, source } = prefixFor(db, base);
  return { corp, base, prefix, source, next: prefix ? nextForPrefix(db, prefix) : fallbackPromoNo(db) };
}

module.exports = { PREFIXES_ENTITY, corpBase, validatePrefixes, nextPromoNoFor, previewForCorp };
