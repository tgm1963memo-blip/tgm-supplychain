const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { nextDocNo } = require('../lib/docNumber');
const { TIERS } = require('./priceTiers');

// ใบเสนอราคา (2026-10-08, รอบ 2 ของแผน "ใบเสนอราคา + ราคาพิเศษ") — หัวเอกสาร + บรรทัดสินค้า + log
// แทนไฟล์ Excel "ไฟล์เสนอราคาฐาน X" (ชีต ฟอร์มต้นฉบับ ที่ VLOOKUP จาก Master Price)
// กติกาที่ server บังคับเสมอ (ไม่เชื่อค่าจาก client):
//   · ชื่อสินค้า/หน่วย/base_price มาจาก price_tiers ณ ตอนบันทึก (ราคาของฐานที่เลือกในหัวเอกสาร)
//   · รอบ 2 ยังไม่มีการขออนุมัติ → ฐานในหัวเอกสาร และราคาเสนอทุกบรรทัด ต้องไม่ต่ำกว่าฐาน min_price_tier ของผู้สร้าง
//     (ราคาต่ำกว่าสิทธิ์ + ราคาพิเศษประจำลูกค้า = รอบ 3)
//   · created_by จาก session · doc_no ออกตอนสร้างภายใน BEGIN IMMEDIATE (QT2569-10-001)
//   · แก้ไขได้เฉพาะ draft · issue = ออกเอกสาร (พิมพ์ได้) · cancel = ยกเลิก (ทั้ง draft และ issued)
const MANAGER_ROLES = ['superadmin', 'admin', 'sales_manager', 'manager'];
const MAX_LINES = 200;
const tierIdx = t => TIERS.indexOf(String(t || '').toUpperCase());
const col = t => `price_${t.toLowerCase()}`;
const txt = (v, max = 300) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
const isManager = u => MANAGER_ROLES.includes(u.role);
const minTierOf = u => (tierIdx(u.min_price_tier) >= 0 ? String(u.min_price_tier).toUpperCase() : 'E');
const httpErr = (status, msg, extra) => Object.assign(new Error(msg), { status, ...extra });

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function log(db, id, action, detail, uid) {
  db.prepare('INSERT INTO quotation_logs (header_id, action, detail, by_uid) VALUES (?, ?, ?, ?)')
    .run(id, action, detail == null ? null : String(detail).slice(0, 1000), uid);
}
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
function shape(h) {
  return h && { ...h, remarks: parseJson(h.remarks_json, []), signer: parseJson(h.signer_json, {}) };
}

// ตรวจ + แปลงข้อมูลจาก client → { head, lines } ที่จะเขียนจริง
function buildDoc(db, body, user) {
  const b = body || {};
  const tier = String(b.price_tier || '').toUpperCase();
  if (tierIdx(tier) < 0) throw httpErr(400, 'กรุณาเลือกฐานราคา A–G');
  const min = minTierOf(user);
  if (tierIdx(tier) < tierIdx(min)) throw httpErr(400, `ฐาน ${tier} ต่ำกว่าสิทธิ์ของคุณ (ใช้ได้ตั้งแต่ฐาน ${min}) — การขออนุมัติราคาพิเศษจะเปิดในรอบถัดไป`);
  const customer_name = txt(b.customer_name, 200);
  if (!customer_name) throw httpErr(400, 'กรุณาระบุลูกค้า');
  const doc_date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.doc_date || '')) ? b.doc_date : new Date().toISOString().slice(0, 10);
  const remarks = (Array.isArray(b.remarks) ? b.remarks : []).slice(0, 20)
    .map(r => ({ th: txt(r?.th, 400) || '', en: txt(r?.en, 400) || '' })).filter(r => r.th || r.en);
  const sg = b.signer || {};
  const signer = { name: txt(sg.name, 120) || '', title: txt(sg.title, 120) || '', contact: txt(sg.contact, 200) || '' };
  const head = {
    doc_date, customer_name, price_tier: tier,
    customer_code: txt(b.customer_code, 40), attn: txt(b.attn, 120), tel: txt(b.tel, 60), email: txt(b.email, 120),
    sales_name: txt(b.sales_name, 120) || user.name || user.uid, from_text: txt(b.from_text, 200), note: txt(b.note, 1000),
    remarks_json: JSON.stringify(remarks), signer_json: JSON.stringify(signer),
  };

  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length) throw httpErr(400, 'กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ');
  if (raw.length > MAX_LINES) throw httpErr(400, `สินค้าเกิน ${MAX_LINES} รายการ`);
  const get = db.prepare('SELECT * FROM price_tiers WHERE code = ?');
  const errors = [];
  const lines = raw.map((l, i) => {
    const code = String(l?.product_code ?? '').trim();
    const p = code ? get.get(code) : null;
    if (!p) { errors.push(`แถว ${i + 1}: ไม่พบรหัส "${code}" ในราคากลาง`); return null; }
    if (!p.is_active) { errors.push(`แถว ${i + 1}: ${code} ยกเลิกขายแล้ว`); return null; }
    const base = p[col(tier)];
    const floor = p[col(min)];
    const q = l?.quoted_price === '' || l?.quoted_price == null ? base : Number(l.quoted_price);
    if (!(Number.isFinite(q) && q > 0)) { errors.push(`แถว ${i + 1}: ${code} ไม่มีราคาฐาน ${tier} — กรุณาระบุราคาเสนอ`); return null; }
    const quoted = Math.round(q * 100) / 100;
    if (floor != null && quoted < floor) { errors.push(`แถว ${i + 1}: ${code} ราคา ${quoted} ต่ำกว่าฐาน ${min} (${floor}) ซึ่งเป็นสิทธิ์ต่ำสุดของคุณ`); return null; }
    return {
      seq: i + 1, product_code: code, name_th: p.name_th, name_en: p.name_en, unit: p.unit,
      base_price: base, quoted_price: quoted, price_source: base != null && quoted === base ? 'tier' : 'manual', tier_used: tier, needs_approval: 0,
    };
  });
  if (errors.length) throw httpErr(400, errors.slice(0, 8).join(' · '), { errors });
  return { head, lines };
}

function writeLines(db, id, lines) {
  db.prepare('DELETE FROM quotation_lines WHERE header_id = ?').run(id);
  const ins = db.prepare(`INSERT INTO quotation_lines (header_id, seq, product_code, name_th, name_en, unit, base_price, quoted_price, price_source, tier_used, needs_approval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of lines) ins.run(id, l.seq, l.product_code, l.name_th, l.name_en, l.unit, l.base_price, l.quoted_price, l.price_source, l.tier_used, l.needs_approval);
}

module.exports = function quotationHeadersRoutes(db, roles) {
  const router = express.Router();
  router.use(requireAuth(db), requireRole(...roles));

  const load = (id, user) => {
    const h = db.prepare('SELECT * FROM quotation_headers WHERE id = ?').get(String(id || ''));
    if (!h) throw httpErr(404, 'ไม่พบใบเสนอราคา');
    if (!isManager(user) && h.created_by !== user.uid) throw httpErr(403, 'ไม่มีสิทธิ์ดูใบเสนอราคานี้');
    return h;
  };
  const full = id => ({
    ...shape(db.prepare('SELECT * FROM quotation_headers WHERE id = ?').get(id)),
    lines: db.prepare('SELECT * FROM quotation_lines WHERE header_id = ? ORDER BY seq').all(id),
    logs: db.prepare('SELECT * FROM quotation_logs WHERE header_id = ? ORDER BY id').all(id),
  });
  const send = (res, fn) => { try { res.json(fn()); } catch (e) { res.status(e.status || 500).json({ error: e.message, errors: e.errors }); } };

  // รายการ — ผู้จัดการ/admin เห็นทั้งหมด · Sales เห็นเฉพาะที่ตัวเองสร้าง
  router.get('/', (req, res) => send(res, () => {
    const mine = !isManager(req.user);
    return db.prepare(`SELECT h.id, h.doc_no, h.doc_date, h.status, h.customer_code, h.customer_name, h.price_tier, h.sales_name,
        h.created_by, h.created_at, h.updated_at, h.issued_at, (SELECT COUNT(*) FROM quotation_lines l WHERE l.header_id = h.id) AS line_count
      FROM quotation_headers h ${mine ? 'WHERE h.created_by = ?' : ''} ORDER BY h.created_at DESC LIMIT 2000`).all(...(mine ? [req.user.uid] : []));
  }));

  router.get('/:id', (req, res) => send(res, () => { load(req.params.id, req.user); return full(req.params.id); }));

  router.post('/', (req, res) => send(res, () => tx(db, () => {
    const { head, lines } = buildDoc(db, req.body, req.user);
    const id = genId('QTH');
    const docNo = nextDocNo(db, 'quotation_headers', 'doc_no', 'QT');
    const cols = ['id', 'doc_no', 'status', 'created_by', 'updated_by', ...Object.keys(head)];
    db.prepare(`INSERT INTO quotation_headers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(id, docNo, 'draft', req.user.uid, req.user.uid, ...Object.values(head));
    writeLines(db, id, lines);
    log(db, id, 'create', `${docNo} ฐาน ${head.price_tier} ${lines.length} รายการ`, req.user.uid);
    return full(id);
  })));

  router.put('/:id', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status !== 'draft') throw httpErr(400, 'แก้ไขได้เฉพาะใบเสนอราคาที่ยังเป็นร่าง');
    if (h.created_by !== req.user.uid && !isManager(req.user)) throw httpErr(403, 'แก้ไขได้เฉพาะผู้สร้าง');
    const { head, lines } = buildDoc(db, req.body, req.user);
    db.prepare(`UPDATE quotation_headers SET ${Object.keys(head).map(k => `${k} = ?`).join(',')}, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(...Object.values(head), req.user.uid, h.id);
    writeLines(db, h.id, lines);
    log(db, h.id, 'update', `ฐาน ${head.price_tier} ${lines.length} รายการ`, req.user.uid);
    return full(h.id);
  })));

  // ออกเอกสาร: ตรวจราคาซ้ำจาก price_tiers ปัจจุบันก่อน (ราคากลางอาจถูกแก้หลังบันทึกร่าง)
  router.post('/:id/issue', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status !== 'draft') throw httpErr(400, 'ออกได้เฉพาะใบเสนอราคาที่เป็นร่าง');
    if (h.created_by !== req.user.uid && !isManager(req.user)) throw httpErr(403, 'ออกเอกสารได้เฉพาะผู้สร้าง');
    const cur = full(h.id);
    buildDoc(db, { ...cur, lines: cur.lines.map(l => ({ product_code: l.product_code, quoted_price: l.quoted_price })) }, req.user);
    db.prepare(`UPDATE quotation_headers SET status = 'issued', issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(req.user.uid, h.id);
    log(db, h.id, 'issue', h.doc_no, req.user.uid);
    return full(h.id);
  })));

  router.post('/:id/cancel', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status === 'cancelled') throw httpErr(400, 'ใบเสนอราคานี้ยกเลิกแล้ว');
    if (h.created_by !== req.user.uid && !isManager(req.user)) throw httpErr(403, 'ยกเลิกได้เฉพาะผู้สร้างหรือผู้จัดการ');
    db.prepare(`UPDATE quotation_headers SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(req.user.uid, h.id);
    log(db, h.id, 'cancel', txt(req.body?.reason, 500), req.user.uid);
    return full(h.id);
  })));

  return router;
};
module.exports.buildDoc = buildDoc;
