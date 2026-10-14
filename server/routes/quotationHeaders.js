const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { nextDocNo } = require('../lib/docNumber');
const { TIERS } = require('./priceTiers');
const { sendMail, escapeHtml } = require('../lib/mailer');

// ใบเสนอราคา (2026-10-08, รอบ 2 ของแผน "ใบเสนอราคา + ราคาพิเศษ") — หัวเอกสาร + บรรทัดสินค้า + log
// แทนไฟล์ Excel "ไฟล์เสนอราคาฐาน X" (ชีต ฟอร์มต้นฉบับ ที่ VLOOKUP จาก Master Price)
// กติกาที่ server บังคับเสมอ (ไม่เชื่อค่าจาก client):
//   · ชื่อสินค้า/หน่วย/base_price มาจาก price_tiers ณ ตอนบันทึก (ราคาของฐานที่เลือกในหัวเอกสาร)
//   · รอบ 3 (2026-10-09): ราคาเสนอต่ำกว่าราคาฐาน min_price_tier ของผู้สร้าง = บรรทัดนั้น needs_approval (ไม่ปฏิเสธแล้ว)
//     ยกเว้นลูกค้ามีราคาพิเศษที่อนุมัติไว้แล้ว และราคาเสนอ ≥ ราคาพิเศษ · มีบรรทัดต้องอนุมัติ = ออกเอกสารเองไม่ได้ ต้องส่งขออนุมัติ
//     draft → (submit เลือกผู้อนุมัติ) pending_approval → approve = issued + บันทึก customer_special_prices
//                                                       → reject = rejected (ผู้สร้างแก้แล้วส่งใหม่) · recall = กลับเป็น draft
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
// ลูกค้าเดิมใช้รหัส · ลูกค้าใหม่ (ยังไม่มีรหัส) ใช้ชื่อแบบตัดช่องว่าง/ตัวพิมพ์เล็ก
const custKeyOf = (code, name) => code ? `C:${String(code).trim()}` : `N:${String(name || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
const EDITABLE = ['draft', 'rejected'];

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
  const belowTier = tierIdx(tier) < tierIdx(min);
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
  // รหัสลูกค้า (2026-10-12, security review): ราคาพิเศษผูกกับรหัส — รหัสต้องมีจริงใน master และอยู่ในสิทธิ์ผู้สร้าง
  // ชื่อที่พิมพ์ต้องเป็นลูกค้ารายเดียวกับรหัส (ไม่ตรง = ใช้ชื่อจาก master) กันใช้รหัสลูกค้าอื่นที่มีราคาพิเศษเลี่ยงการขออนุมัติ
  if (head.customer_code) {
    const m = db.prepare(`SELECT name FROM customers WHERE code = ? UNION ALL SELECT name FROM bplus_customers WHERE code = ? LIMIT 1`).get(head.customer_code, head.customer_code);
    if (!m) throw httpErr(400, `ไม่พบรหัสลูกค้า ${head.customer_code} ในระบบ — เลือกลูกค้าจากรายการ หรือเว้นรหัสว่างสำหรับลูกค้าใหม่`);
    const cs = require('../lib/customerScope');
    if (!cs.canSeeCust(cs.resolveScope(db, user), head.customer_code)) throw httpErr(403, 'รหัสลูกค้านี้ไม่อยู่ในความดูแลของผู้สร้างเอกสาร');
    const norm = v => String(v || '').replace(/\(.*?\)|บริษัท|จำกัด|มหาชน|\s+/g, '').toLowerCase();
    const a = norm(head.customer_name), mm = norm(m.name);
    if (mm && !(a.includes(mm) || mm.includes(a))) head.customer_name = String(m.name).replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length) throw httpErr(400, 'กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ');
  if (raw.length > MAX_LINES) throw httpErr(400, `สินค้าเกิน ${MAX_LINES} รายการ`);
  const get = db.prepare('SELECT * FROM price_tiers WHERE code = ?');
  const special = db.prepare('SELECT price FROM customer_special_prices WHERE cust_key = ? AND product_code = ? AND is_active = 1');
  const custKey = custKeyOf(head.customer_code, head.customer_name);
  const errors = [];
  const lines = raw.map((l, i) => {
    const code = String(l?.product_code ?? '').trim();
    const p = code ? get.get(code) : null;
    if (!p) { errors.push(`แถว ${i + 1}: ไม่พบรหัส "${code}" ในราคากลาง`); return null; }
    if (!p.is_active) { errors.push(`แถว ${i + 1}: ${code} ยกเลิกขายแล้ว`); return null; }
    const base = p[col(tier)];
    const floor = p[col(min)];
    const sp = special.get(custKey, code)?.price ?? null;
    // ไม่ระบุราคา = ราคาพิเศษของลูกค้า (ถ้ามี) ไม่งั้นราคาฐานที่เลือก
    const q = l?.quoted_price === '' || l?.quoted_price == null ? (sp ?? base) : Number(l.quoted_price);
    if (!(Number.isFinite(q) && q > 0)) { errors.push(`แถว ${i + 1}: ${code} ไม่มีราคาฐาน ${tier} — กรุณาระบุราคาเสนอ`); return null; }
    const quoted = Math.round(q * 100) / 100;
    // ต่ำกว่าสิทธิ์ = ต่ำกว่าราคาฐาน min ของผู้สร้าง (ไม่มีราคาฐาน min → ดูจากฐานที่เลือกต่ำกว่าสิทธิ์หรือไม่)
    const below = floor != null ? quoted < floor : belowTier;
    const coveredBySpecial = sp != null && quoted >= sp;
    return {
      seq: i + 1, product_code: code, name_th: p.name_th, name_en: p.name_en, unit: p.unit, base_price: base, quoted_price: quoted,
      price_source: sp != null && quoted === sp ? 'special' : base != null && quoted === base ? 'tier' : 'manual',
      tier_used: tier, needs_approval: below && !coveredBySpecial ? 1 : 0,
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

// อีเมลแจ้งผู้อนุมัติ (ใช้กล่องอีเมลเดียวกับใบเคาะราคา — lib/mailer.js) · ไม่มี SMTP = แค่ log ไม่ error
const appUrl = () => (process.env.APP_PUBLIC_URL || 'https://tss-supplychain.vercel.app').replace(/\/+$/, '');
async function notifyApprover({ to, name, h, need }) {
  const e = v => escapeHtml(v == null ? '' : String(v));
  const subject = `Approve Quotation: ${h.customer_name} [${h.doc_no}]`;
  const rows = need.slice(0, 20).map(l => `<tr><td style="padding:4px 8px">${e(l.product_code)}</td><td style="padding:4px 8px">${e(l.name_th)}</td>
    <td style="padding:4px 8px;text-align:right">${e(l.base_price ?? '—')}</td><td style="padding:4px 8px;text-align:right"><b>${e(l.quoted_price)}</b></td></tr>`).join('');
  const html = `<div style="font-family:Sarabun,Arial,sans-serif;max-width:640px">
    <p>เรียน คุณ${e(name)}<br>มีใบเสนอราคา <b>${e(h.doc_no)}</b> ลูกค้า <b>${e(h.customer_name)}</b> (ฐาน ${e(h.price_tier)}) ขออนุมัติราคาต่ำกว่าสิทธิ์ ${need.length} รายการ</p>
    <table style="border-collapse:collapse;font-size:13px"><tr style="background:#1E3A5F;color:#fff"><th style="padding:4px 8px">รหัส</th><th style="padding:4px 8px">สินค้า</th><th style="padding:4px 8px">ราคาฐาน</th><th style="padding:4px 8px">ราคาเสนอ</th></tr>${rows}</table>
    <p><a href="${e(appUrl())}" style="background:#1E3A5F;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">เปิดระบบเพื่ออนุมัติ (เมนู ใบเสนอราคา)</a></p></div>`;
  return sendMail({ to, subject, html, text: `${subject}\nขออนุมัติ ${need.length} รายการ · เปิดระบบ: ${appUrl()}` });
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
  const creatorOf = h => db.prepare('SELECT uid, name, role, min_price_tier FROM sc_users WHERE uid = ?').get(h.created_by) || { uid: h.created_by, min_price_tier: 'E' };
  // คำนวณบรรทัดใหม่จากราคากลาง/ราคาพิเศษปัจจุบัน ด้วยสิทธิ์ของผู้สร้าง (ใช้ตอนออก/ส่ง/อนุมัติ)
  const recheck = h => { const cur = full(h.id); return buildDoc(db, { ...cur, lines: cur.lines.map(l => ({ product_code: l.product_code, quoted_price: l.quoted_price })) }, creatorOf(h)); };
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
        h.created_by, h.created_at, h.updated_at, h.issued_at, h.approver_uid, (SELECT COUNT(*) FROM quotation_lines l WHERE l.header_id = h.id AND l.needs_approval = 1) AS need_count, (SELECT COUNT(*) FROM quotation_lines l WHERE l.header_id = h.id) AS line_count
      FROM quotation_headers h ${mine ? 'WHERE h.created_by = ?' : ''} ORDER BY h.created_at DESC LIMIT 2000`).all(...(mine ? [req.user.uid] : []));
  }));

  // ── ราคาพิเศษประจำลูกค้า / ผู้อนุมัติ (ต้องประกาศก่อน /:id) ──
  router.get('/special-prices', (req, res) => send(res, () => {
    const code = txt(req.query.customer_code, 40);
    // ราคาพิเศษของลูกค้าที่ไม่อยู่ในสิทธิ์ = ไม่ส่ง (2026-10-12, security review) · ผู้จัดการเห็นได้ทั้งหมด
    if (code && !isManager(req.user)) { const cs = require('../lib/customerScope'); if (!cs.canSeeCust(cs.resolveScope(db, req.user), code)) return []; }
    const key = custKeyOf(code, req.query.customer_name);
    return db.prepare('SELECT product_code, price, approved_by, approved_at, source_quotation_id FROM customer_special_prices WHERE cust_key = ? AND is_active = 1').all(key);
  }));
  router.get('/special-prices/all', (req, res) => send(res, () => {
    if (!isManager(req.user)) throw httpErr(403, 'เฉพาะผู้จัดการ');
    return db.prepare(`SELECT sp.*, q.doc_no, pt.name_th FROM customer_special_prices sp LEFT JOIN quotation_headers q ON q.id = sp.source_quotation_id
      LEFT JOIN price_tiers pt ON pt.code = sp.product_code WHERE sp.is_active = 1 ORDER BY sp.customer_name, sp.product_code LIMIT 5000`).all();
  }));
  router.post('/special-prices/:id/deactivate', (req, res) => send(res, () => tx(db, () => {
    if (!isManager(req.user)) throw httpErr(403, 'เฉพาะผู้จัดการ');
    const r = db.prepare(`UPDATE customer_special_prices SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(Number(req.params.id));
    if (!r.changes) throw httpErr(404, 'ไม่พบราคาพิเศษ');
    return { ok: true };
  })));
  router.get('/approvers', (req, res) => send(res, () => db.prepare(`SELECT uid, name, role, email FROM sc_users WHERE is_active = 1 AND role IN (${MANAGER_ROLES.map(() => '?').join(',')}) AND uid <> ? ORDER BY name`)
    .all(...MANAGER_ROLES, req.user.uid).map(u => ({ uid: u.uid, name: u.name, role: u.role, has_email: !!u.email }))));

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
    if (!EDITABLE.includes(h.status)) throw httpErr(400, 'แก้ไขได้เฉพาะใบเสนอราคาที่เป็นร่าง หรือถูกตีกลับ');
    if (h.created_by !== req.user.uid && !isManager(req.user)) throw httpErr(403, 'แก้ไขได้เฉพาะผู้สร้าง');
    // สิทธิ์ฐานคิดจากผู้สร้างเสมอ (ผู้จัดการแก้ให้ก็ไม่ได้ทำให้ราคาต่ำกว่าสิทธิ์ผ่านเอง)
    const { head, lines } = buildDoc(db, req.body, creatorOf(h));
    db.prepare(`UPDATE quotation_headers SET ${Object.keys(head).map(k => `${k} = ?`).join(',')}, status = 'draft', updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
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
    const { lines } = recheck(h);
    const need = lines.filter(l => l.needs_approval);
    if (need.length) throw httpErr(400, `มี ${need.length} รายการราคาต่ำกว่าสิทธิ์ (${need.slice(0, 5).map(l => l.product_code).join(', ')}) — ต้องส่งขออนุมัติก่อน`);
    writeLines(db, h.id, lines);
    db.prepare(`UPDATE quotation_headers SET status = 'issued', issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(req.user.uid, h.id);
    log(db, h.id, 'issue', h.doc_no, req.user.uid);
    return full(h.id);
  })));

  // ── ขออนุมัติราคาต่ำกว่าสิทธิ์ (รอบ 3) ──
  router.post('/:id/submit', (req, res) => {
    let out, mail;
    try {
      out = tx(db, () => {
        const h = load(req.params.id, req.user);
        if (h.status !== 'draft') throw httpErr(400, 'ส่งขออนุมัติได้เฉพาะใบเสนอราคาที่เป็นร่าง');
        if (h.created_by !== req.user.uid && !['admin', 'superadmin'].includes(req.user.role)) throw httpErr(403, 'ส่งขออนุมัติได้เฉพาะผู้สร้าง');
        const ap = db.prepare('SELECT uid, name, role, email, is_active FROM sc_users WHERE uid = ?').get(String(req.body?.approver_uid || ''));
        if (!ap || !ap.is_active || !MANAGER_ROLES.includes(ap.role)) throw httpErr(400, 'กรุณาเลือกผู้อนุมัติ (ผู้จัดการฝ่ายขายขึ้นไป)');
        if (ap.uid === h.created_by) throw httpErr(400, 'ผู้สร้างเป็นผู้อนุมัติเองไม่ได้');
        const { lines } = recheck(h);
        const need = lines.filter(l => l.needs_approval);
        if (!need.length) throw httpErr(400, 'ทุกรายการอยู่ในสิทธิ์ของคุณ — ออกใบเสนอราคาได้เลย ไม่ต้องขออนุมัติ');
        writeLines(db, h.id, lines);
        db.prepare(`UPDATE quotation_headers SET status = 'pending_approval', approver_uid = ?, submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reject_reason = NULL,
          updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(ap.uid, req.user.uid, h.id);
        log(db, h.id, 'submit', `ขออนุมัติ ${need.length} รายการ → ${ap.name || ap.uid}`, req.user.uid);
        mail = ap.email ? { to: ap.email, name: ap.name || ap.uid, h, need } : null;
        return full(h.id);
      });
    } catch (e) { return res.status(e.status || 500).json({ error: e.message, errors: e.errors }); }
    res.json(out);
    if (mail) notifyApprover(mail).catch(e => console.warn('[quotationMail]', e.message));
  });

  router.post('/:id/recall', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status !== 'pending_approval') throw httpErr(400, 'เรียกคืนได้เฉพาะใบที่รออนุมัติ');
    if (h.created_by !== req.user.uid && !['admin', 'superadmin'].includes(req.user.role)) throw httpErr(403, 'เรียกคืนได้เฉพาะผู้สร้าง');
    db.prepare(`UPDATE quotation_headers SET status = 'draft', approver_uid = NULL, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(req.user.uid, h.id);
    log(db, h.id, 'recall', null, req.user.uid);
    return full(h.id);
  })));

  const canDecide = (h, u) => h.approver_uid === u.uid || ['admin', 'superadmin'].includes(u.role);
  router.post('/:id/approve', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status !== 'pending_approval') throw httpErr(400, 'ใบเสนอราคานี้ไม่ได้รออนุมัติ');
    if (!canDecide(h, req.user)) throw httpErr(403, 'อนุมัติได้เฉพาะผู้อนุมัติที่ผู้สร้างเลือกไว้');
    if (h.created_by === req.user.uid) throw httpErr(403, 'ผู้สร้างอนุมัติใบของตัวเองไม่ได้');
    const { lines } = recheck(h);
    writeLines(db, h.id, lines);
    // ราคาที่อนุมัติ → ราคาพิเศษประจำลูกค้า (ทับราคาเดิมของลูกค้า×สินค้าเดียวกัน)
    const up = db.prepare(`INSERT INTO customer_special_prices (cust_key, customer_code, customer_name, product_code, price, source_quotation_id, approved_by, approved_at, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(cust_key, product_code) DO UPDATE SET price = excluded.price, customer_code = excluded.customer_code, customer_name = excluded.customer_name,
        source_quotation_id = excluded.source_quotation_id, approved_by = excluded.approved_by, approved_at = excluded.approved_at, is_active = 1, updated_at = excluded.updated_at`);
    const key = custKeyOf(h.customer_code, h.customer_name);
    const need = lines.filter(l => l.needs_approval);
    for (const l of need) up.run(key, h.customer_code || null, h.customer_name, l.product_code, l.quoted_price, h.id, req.user.uid);
    db.prepare(`UPDATE quotation_headers SET status = 'issued', approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), issued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(req.user.uid, req.user.uid, h.id);
    log(db, h.id, 'approve', `${need.length} รายการ → ราคาพิเศษลูกค้า${txt(req.body?.comment, 500) ? ' · ' + txt(req.body.comment, 500) : ''}`, req.user.uid);
    return full(h.id);
  })));

  router.post('/:id/reject', (req, res) => send(res, () => tx(db, () => {
    const h = load(req.params.id, req.user);
    if (h.status !== 'pending_approval') throw httpErr(400, 'ใบเสนอราคานี้ไม่ได้รออนุมัติ');
    if (!canDecide(h, req.user)) throw httpErr(403, 'ตีกลับได้เฉพาะผู้อนุมัติที่ผู้สร้างเลือกไว้');
    const reason = txt(req.body?.reason, 500);
    if (!reason) throw httpErr(400, 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    db.prepare(`UPDATE quotation_headers SET status = 'rejected', reject_reason = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(reason, req.user.uid, h.id);
    log(db, h.id, 'reject', reason, req.user.uid);
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
