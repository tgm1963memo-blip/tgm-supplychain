'use strict';
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { sendMail, escapeHtml } = require('../lib/mailer');

// ใบเคาะราคา การตลาด (ออนไลน์) — 2026-11-23 · ต้นแบบจาก sheet "ใบโขก" (mock ที่ผู้ใช้รีวิวแล้ว)
// ผู้ออก: บริษัท ไทย ซอสเซส มาร์เก็ตติ้ง จำกัด · 1 ใบ ต่อ 1 ลูกค้า (ช่องทางออนไลน์)
// โครงเนื้อหา: ส่วน 1, 2, 3 … (ผู้เสนอเลือกหัวข้อ In Store / Live / เงื่อนไขค่าส่ง / อื่นๆ) แต่ละส่วนมีระยะเวลา + ลักษณะโปร
//   และส่วนย่อย 1.1, 1.2 … เป็น ตารางสินค้า / ตารางอิสระ / ข้อความ — เก็บเป็น body_json ก้อนเดียว
// กติกาที่ server บังคับ (ไม่เชื่อค่าจาก client):
//   · ผู้เสนอ = ผู้ใช้ที่ login (created_by / created_by_name จาก session)
//   · เลขใบเคาะ MKT#### ออกตอนบันทึกครั้งแรก · เลขใบ Promotion M##### ออกตอนอนุมัติครบ — ภายใน BEGIN IMMEDIATE
//     ต่อจากทะเบียน Excel เดิม (ล่าสุด MKT0044 / M00232 ณ 2026-11-23)
//   · ชื่อสินค้ามาจาก products ณ ตอนบันทึก · รหัสไม่พบ = บันทึกได้ (ร่าง) แต่ส่งอนุมัติไม่ได้
//   · ขั้นอนุมัติเรียงตามลำดับ แต่ละขั้นมีผู้อนุมัติได้หลายคน (คนใดคนหนึ่งอนุมัติ = ผ่านขั้น) · ผู้เสนออนุมัติเองไม่ได้
//   · อนุมัติครบ = ออกเลข M + ส่งอีเมลแจ้ง CC (แทนการถ่ายสำเนากระดาษ)
const MKT_SEED = 44, PRO_SEED = 232;
const CREATE_ROLES = ['superadmin', 'admin', 'marketing', 'marketing_manager', 'sales_manager'];
const ALL_ROLES = ['superadmin', 'admin', 'marketing_manager'];
const ADMIN_ROLES = ['superadmin', 'admin'];
const CHANNELS = [
  { code: '01-OS-0001', name: 'Shopee', gp: 48.33 }, { code: '01-OL-0001', name: 'Lazada', gp: 47.26 },
  // TikTok (2026-11-23, ผู้ใช้ขอเพิ่ม) — ยังไม่ทราบ GP มาตรฐาน ตั้งต้น 0 ผู้เสนอแก้ในใบได้
  { code: '01-OT-0001', name: 'TikTok', gp: 0 },
  { code: '01-OF-0001', name: 'Facebook Shop', gp: 0 }, { code: '01-OE-0001', name: 'E-commerce', gp: 0 },
  { code: '01-ON-0001', name: 'Line Official', gp: 0 }, { code: '01-OM-0001', name: 'Line My Shop', gp: 0 },
  { code: '01-OU-0001', name: 'Thaimart', gp: 0 },
];
const SEC_TYPES = { instore: 'In Store', live: 'Live', ship: 'เงื่อนไขค่าส่ง', other: 'อื่นๆ' };
const PROD_TYPES = ['instore', 'live'];
const DEFAULT_ROUTES = [
  { id: 'mkt-online', name: 'การตลาดออนไลน์ (มาตรฐาน)', sort: 1,
    levels: ['ธุรการ', 'ผู้จัดการ', 'ผู้ตรวจสอบ', 'ผู้อนุมัติ'] },
  { id: 'mkt-npd', name: 'การตลาด · NPD / มีค่าใช้จ่ายการตลาด', sort: 2,
    levels: ['ธุรการ', 'ผู้จัดการ', 'ผู้ตรวจสอบ', 'ผู้อนุมัติ', 'ผู้บริหาร'] },
];
const EDITABLE = ['draft', 'rejected'];
const MAX_SECS = 20, MAX_SUBS = 30, MAX_ITEMS = 300, MAX_ROWS = 60, MAX_COLS = 12;

const httpErr = (status, msg, extra) => Object.assign(new Error(msg), { status, ...extra });
const txt = (v, max = 300) => { const s = String(v ?? '').replace(/[ \t]+/g, ' ').trim(); return s ? s.slice(0, max) : ''; };
const longTxt = (v, max = 3000) => String(v ?? '').replace(/\r/g, '').slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function log(db, id, action, detail, uid) {
  db.prepare('INSERT INTO mkt_promo_logs (doc_id, action, detail, by_uid) VALUES (?, ?, ?, ?)')
    .run(id, action, detail == null ? null : String(detail).slice(0, 1000), uid);
}
// เลขรันทั้งระบบ (ไม่รีเซ็ตรายเดือน) ต่อจากทะเบียน Excel — เรียกใน transaction เท่านั้น
function nextNo(db, col, prefix, width, seed) {
  const rows = db.prepare(`SELECT ${col} AS no FROM mkt_promo_docs WHERE ${col} LIKE ?`).all(`${prefix}%`);
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r.no).slice(prefix.length)) || 0), seed);
  return prefix + String(max + 1).padStart(width, '0');
}

// ตรวจ + ทำความสะอาดเนื้อหาเอกสารจาก client → { head, body, issues }
function buildDoc(db, b) {
  b = b || {};
  const ch = CHANNELS.find(c => c.code === b.customer_code);
  if (!ch) throw httpErr(400, 'กรุณาเลือกลูกค้า (ช่องทางขาย)');
  const cust = db.prepare('SELECT name FROM customers WHERE code = ?').get(ch.code);
  const head = {
    doc_date: isDate(b.doc_date) ? b.doc_date : new Date().toISOString().slice(0, 10),
    customer_code: ch.code, customer_name: ch.name, customer_master_name: cust ? cust.name : null,
    gp: Math.min(100, num(b.gp)), title: txt(b.title, 200), purpose: txt(b.purpose, 100),
    route_id: txt(b.route_id, 40) || DEFAULT_ROUTES[0].id,
  };
  if (!head.title) throw httpErr(400, 'กรุณาระบุชื่อรายการ');
  const getP = db.prepare('SELECT code, name, unit FROM products WHERE code = ?');
  const issues = [];
  let nItems = 0;
  const secsIn = Array.isArray(b.secs) ? b.secs : [];
  if (secsIn.length > MAX_SECS) throw httpErr(400, `ส่วนเกิน ${MAX_SECS} ส่วน`);
  const secs = secsIn.map((s, si) => {
    const type = SEC_TYPES[s?.type] ? s.type : 'other';
    const no = `ส่วน ${si + 1}`;
    const sec = { type, title: txt(s?.title, 120), d1: isDate(s?.d1) ? s.d1 : '', d2: isDate(s?.d2) ? s.d2 : '', ptype: txt(s?.ptype, 120), subs: [] };
    if (type === 'other' && !sec.title) issues.push(`${no}: ยังไม่ได้ตั้งชื่อหัวข้อ`);
    if (!sec.d1 || !sec.d2) issues.push(`${no}: ยังไม่ได้ใส่ระยะเวลา`); else if (sec.d2 < sec.d1) issues.push(`${no}: วันสิ้นสุดอยู่ก่อนวันเริ่ม`);
    const subsIn = Array.isArray(s?.subs) ? s.subs.slice(0, MAX_SUBS) : [];
    sec.subs = subsIn.map((u, ui) => {
      const lab = `${si + 1}.${ui + 1}`;
      const kind = ['items', 'table', 'text'].includes(u?.kind) ? u.kind : 'text';
      if (kind === 'items' && !PROD_TYPES.includes(type)) return { kind: 'text', title: txt(u?.title, 160), text: '' };
      if (kind === 'text') return { kind, title: txt(u?.title, 160), text: longTxt(u?.text) };
      if (kind === 'table') {
        const cols = (Array.isArray(u?.cols) ? u.cols : []).slice(0, MAX_COLS).map(c => txt(c, 80));
        if (!cols.length) cols.push('');
        const rows = (Array.isArray(u?.rows) ? u.rows : []).slice(0, MAX_ROWS).map(r => cols.map((_, j) => txt(Array.isArray(r) ? r[j] : '', 200)));
        return { kind, title: txt(u?.title, 160), cols, rows };
      }
      const items = (Array.isArray(u?.items) ? u.items : []).map((x, r) => {
        const code = txt(x?.code, 40), promo = num(x?.promo), normal = num(x?.normal), tgt = Math.round(num(x?.tgt));
        if (!code && !promo) return null; // แถวว่าง ตัดทิ้ง
        const row = `${lab} แถว ${r + 1}`;
        const p = code ? getP.get(code) : null;
        if (!code) issues.push(`${row}: ยังไม่ได้กรอกรหัสสินค้า`);
        else if (!p) issues.push(`${row}: ไม่พบรหัส ${code} ในระบบ`);
        if (code && !(promo > 0)) issues.push(`${row}: ยังไม่ได้กรอกราคาโปร`);
        return { code, name: p ? p.name : '', unit: p ? p.unit : '', normal, promo, tgt };
      }).filter(Boolean);
      nItems += items.length;
      return { kind, title: txt(u?.title, 160), items };
    });
    return sec;
  });
  if (nItems > MAX_ITEMS) throw httpErr(400, `สินค้ารวมเกิน ${MAX_ITEMS} รายการ`);
  if (!secs.length) issues.push('ยังไม่มีส่วนในใบนี้ เพิ่มอย่างน้อย 1 ส่วน');
  const aff = [5, 10, 12, 15].filter(r => (Array.isArray(b.aff) ? b.aff.map(Number) : []).includes(r));
  const body = { secs, aff, note: longTxt(b.note, 1000) };
  return { head, body, issues };
}

// ผู้รับ CC จาก client → ทำความสะอาด (uid ต้องมีจริง · อีเมลต้องรูปแบบถูก)
function cleanCc(db, list) {
  const getU = db.prepare('SELECT uid, name FROM sc_users WHERE uid = ? AND is_active = 1');
  const out = [], seen = new Set();
  for (const c of (Array.isArray(list) ? list : []).slice(0, 40)) {
    const uid = txt(c?.uid, 60), email = txt(c?.email, 160).toLowerCase();
    const u = uid ? getU.get(uid) : null;
    if (uid && !u) continue;
    if (!u && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const key = u ? 'u:' + u.uid : 'e:' + email;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ role: txt(c?.role, 80), uid: u ? u.uid : '', name: u ? u.name : '', email: u ? '' : email, on: c?.on !== false, src: c?.src === 'route' ? 'route' : 'doc' });
  }
  return out;
}

const appUrl = () => (process.env.APP_PUBLIC_URL || 'https://tss-supplychain.vercel.app').replace(/\/+$/, '');
const e = v => escapeHtml(v == null ? '' : String(v));
const fmt = n => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
function summaryHtml(d) {
  const secs = (d.body.secs || []).map((s, si) => {
    const items = s.subs.filter(u => u.kind === 'items').flatMap(u => u.items);
    return `<li><b>ส่วน ${si + 1} · ${e(s.title || SEC_TYPES[s.type])}</b> — ${e(s.d1)} ถึง ${e(s.d2)} · ${e(s.ptype || '-')}${items.length ? ` · สินค้า ${items.length} รายการ` : ''}</li>`;
  }).join('');
  return `<ul style="padding-left:18px;margin:6px 0">${secs}</ul>`;
}
async function mailApprovers(db, d, uids, levelLabel) {
  const to = db.prepare(`SELECT email FROM sc_users WHERE uid IN (${uids.map(() => '?').join(',')}) AND is_active = 1 AND email IS NOT NULL AND email <> ''`).all(...uids).map(r => r.email);
  if (!to.length) return;
  const subject = `ขออนุมัติใบเคาะราคา การตลาด ${d.doc_no} · ${d.title}`;
  const html = `<div style="font-family:Sarabun,Arial,sans-serif;max-width:640px"><p>มีใบเคาะราคา การตลาด <b>${e(d.doc_no)}</b> ลูกค้า <b>${e(d.customer_name)} (${e(d.customer_code)})</b> รอคุณอนุมัติในขั้น <b>${e(levelLabel)}</b></p>
    <p>ผู้เสนอ: ${e(d.created_by_name)}<br>ชื่อรายการ: ${e(d.title)}</p>${summaryHtml(d)}
    <p><a href="${e(appUrl())}" style="background:#1B2064;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">เปิดระบบเพื่ออนุมัติ (เมนู ใบเคาะราคา การตลาด)</a></p></div>`;
  return sendMail({ to: to.join(','), subject, html, text: `${subject}\nเปิดระบบ: ${appUrl()}` });
}
// อนุมัติครบ → แจ้ง CC (แทนสำเนากระดาษ)
async function mailCc(db, d) {
  const getE = db.prepare('SELECT email FROM sc_users WHERE uid = ? AND is_active = 1');
  const cc = (d.cc || []).filter(c => c.on).map(c => c.uid ? getE.get(c.uid)?.email : c.email).filter(Boolean);
  const to = [];
  if (d.cc_owner) {
    const uids = [d.created_by, ...(d.levels || []).map(l => l.by).filter(Boolean)];
    for (const u of uids) { const m = getE.get(u)?.email; if (m) to.push(m); }
  }
  const all = [...new Set([...to, ...cc])];
  if (!all.length) return { sent: false, reason: 'NO_RECIPIENT', count: 0 };
  const subject = `[อนุมัติแล้ว] ใบโปรโมชัน ${d.promo_no} · ${d.title}`;
  const html = `<div style="font-family:Sarabun,Arial,sans-serif;max-width:680px"><p>เรียนทุกท่าน</p>
    <p>ใบโปรโมชัน <b>${e(d.promo_no)}</b> (อ้างอิงใบเคาะ ${e(d.doc_no)}) ได้รับอนุมัติครบทุกขั้นแล้ว</p>
    <p>ลูกค้า: ${e(d.customer_name)} (${e(d.customer_code)})<br>ชื่อรายการ: ${e(d.title)}<br>ผู้เสนอ: ${e(d.created_by_name)}</p>${summaryHtml(d)}
    <p><a href="${e(appUrl())}" style="background:#1B2064;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">ดูรายละเอียดในระบบ (เมนู ใบเคาะราคา การตลาด)</a></p></div>`;
  const toList = to.length ? [...new Set(to)] : all.slice(0, 1);
  const ccList = all.filter(m => !toList.includes(m));
  const r = await sendMail({ to: toList.join(','), cc: ccList, subject, html, text: `${subject}\n${appUrl()}` });
  return { ...r, count: all.length };
}

const attTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single('file');
// ตรวจเนื้อไฟล์จริงแบบหยาบ (magic bytes) — กันไฟล์ html/script ปลอมชนิด
function sniffOk(buf, mime) {
  const h = buf.subarray(0, 8);
  const starts = (...b) => b.every((x, i) => h[i] === x);
  if (mime === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47);
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/gif') return starts(0x47, 0x49, 0x46);
  if (mime === 'image/webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (mime.includes('openxmlformats')) return starts(0x50, 0x4b, 0x03, 0x04);
  if (mime === 'application/vnd.ms-excel') return starts(0xd0, 0xcf, 0x11, 0xe0);
  if (mime === 'text/csv') return !/<\s*(script|html|iframe)/i.test(buf.subarray(0, 4096).toString('utf8'));
  return false;
}

module.exports = function mktPromoDocsRoutes(db) {
  const router = express.Router();
  router.use(requireAuth(db));

  const isAll = u => ALL_ROLES.includes(u.role);
  const canCreate = u => CREATE_ROLES.includes(u.role);
  const shape = h => h && ({ ...h, body: parseJson(h.body_json, { secs: [], aff: [], note: '' }), levels: parseJson(h.levels_json, []), cc: parseJson(h.cc_json, []),
    body_json: undefined, levels_json: undefined, cc_json: undefined });
  const isApprover = (d, uid) => (d.levels || []).some(l => (l.uids || []).includes(uid));
  const load = (id, user) => {
    const d = shape(db.prepare('SELECT * FROM mkt_promo_docs WHERE id = ?').get(String(id || '')));
    if (!d) throw httpErr(404, 'ไม่พบใบเคาะราคา');
    if (!isAll(user) && !canPaper(user) && d.created_by !== user.uid && !isApprover(d, user.uid)) throw httpErr(403, 'ไม่มีสิทธิ์ดูใบเคาะราคานี้');
    return d;
  };
  const full = id => {
    const d = shape(db.prepare('SELECT * FROM mkt_promo_docs WHERE id = ?').get(id));
    d.logs = db.prepare('SELECT l.*, u.name AS by_name FROM mkt_promo_logs l LEFT JOIN sc_users u ON u.uid = l.by_uid WHERE doc_id = ? ORDER BY l.id').all(id);
    d.attachments = db.prepare('SELECT id, label, filename, mime_type, length(content) AS size_bytes, uploaded_by, created_at FROM mkt_promo_attachments WHERE doc_id = ? ORDER BY created_at').all(id);
    d.issues = buildDoc(db, { ...d, ...d.body }).issues;
    return d;
  };
  const send = (res, fn) => { try { res.json(fn()); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };
  const routes = () => db.prepare('SELECT * FROM mkt_promo_routes WHERE is_active = 1 ORDER BY sort, id').all()
    .map(r => ({ id: r.id, name: r.name, levels: parseJson(r.levels_json, []), cc: parseJson(r.cc_json, []) }));
  // ผู้บันทึก "อนุมัติจากเอกสารกระดาษ" (2026-11-23, ผู้ใช้สั่ง: ช่วงที่ใบโปรออนไลน์ยังไม่ได้อนุมัติในระบบ
  // ให้ถ่ายรูปเอกสารที่เซ็นแล้วแนบ แล้วผู้ใช้ที่กำหนดกดบันทึกเป็นอนุมัติได้เลย) — แอดมินแก้รายชื่อได้
  const paperApprovers = () => parseJson(db.prepare("SELECT value FROM mkt_promo_settings WHERE key = 'paper_approvers'").get()?.value, []);
  const canPaper = u => paperApprovers().includes(u.uid);
  const canWriteDoc = (d, u) => d.created_by === u.uid || ADMIN_ROLES.includes(u.role) || canPaper(u);

  // ข้อมูลประกอบฟอร์ม: ช่องทาง / เส้นทางอนุมัติ / ผู้ใช้ (เลือกผู้อนุมัติ+CC) / เลขถัดไป
  router.get('/meta', (req, res) => send(res, () => ({
    channels: CHANNELS, sec_types: SEC_TYPES, routes: routes(), can_create: canCreate(req.user) || canPaper(req.user), is_admin: ADMIN_ROLES.includes(req.user.role),
    can_paper_approve: canPaper(req.user), paper_approvers: ADMIN_ROLES.includes(req.user.role) ? paperApprovers() : undefined,
    users: db.prepare("SELECT uid, name, role, position, email IS NOT NULL AND email <> '' AS has_email FROM sc_users WHERE is_active = 1 ORDER BY name").all(),
    next: { doc_no: nextNo(db, 'doc_no', 'MKT', 4, MKT_SEED), promo_no: nextNo(db, 'promo_no', 'M', 5, PRO_SEED) },
  })));
  // รายการสินค้า (รหัส+ชื่อ) สำหรับช่องกรอกรหัส + ราคาปกติล่าสุดที่เคยใช้ในใบเคาะการตลาด
  router.get('/products', (req, res) => send(res, () => {
    const last = {};
    for (const r of db.prepare("SELECT body_json FROM mkt_promo_docs WHERE status <> 'cancelled' ORDER BY updated_at").all()) {
      for (const s of parseJson(r.body_json, {}).secs || []) for (const u of s.subs || []) for (const x of u.items || []) if (x.code && x.normal > 0) last[x.code] = x.normal;
    }
    return { products: db.prepare('SELECT code, name, unit FROM products WHERE is_active = 1 ORDER BY code').all(), last_normal: last };
  }));
  // ตั้งค่าเส้นทางอนุมัติ (admin)
  router.put('/routes/:id', (req, res) => send(res, () => tx(db, () => {
    if (!ADMIN_ROLES.includes(req.user.role)) throw httpErr(403, 'เฉพาะแอดมิน');
    const r = db.prepare('SELECT id FROM mkt_promo_routes WHERE id = ?').get(req.params.id);
    if (!r) throw httpErr(404, 'ไม่พบเส้นทาง');
    const getU = db.prepare('SELECT uid FROM sc_users WHERE uid = ? AND is_active = 1');
    const levels = (Array.isArray(req.body?.levels) ? req.body.levels : []).slice(0, 8)
      .map(l => ({ label: txt(l?.label, 60), uids: [...new Set((Array.isArray(l?.uids) ? l.uids : []).map(String))].filter(u => getU.get(u)).slice(0, 10) }))
      .filter(l => l.label);
    if (!levels.length) throw httpErr(400, 'ต้องมีอย่างน้อย 1 ขั้น');
    const cc = cleanCc(db, req.body?.cc).map(c => ({ ...c, src: 'route' }));
    db.prepare(`UPDATE mkt_promo_routes SET name = COALESCE(?, name), levels_json = ?, cc_json = ?, updated_by = ?, updated_at = ${now} WHERE id = ?`)
      .run(txt(req.body?.name, 120) || null, JSON.stringify(levels), JSON.stringify(cc), req.user.uid, r.id);
    return routes();
  })));

  router.put('/settings/paper-approvers', (req, res) => send(res, () => {
    if (!ADMIN_ROLES.includes(req.user.role)) throw httpErr(403, 'เฉพาะแอดมิน');
    const getU = db.prepare('SELECT uid FROM sc_users WHERE uid = ? AND is_active = 1');
    const uids = [...new Set((Array.isArray(req.body?.uids) ? req.body.uids : []).map(String))].filter(u => getU.get(u)).slice(0, 20);
    db.prepare(`INSERT INTO mkt_promo_settings (key, value, updated_by, updated_at) VALUES ('paper_approvers', ?, ?, ${now})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(JSON.stringify(uids), req.user.uid);
    return paperApprovers();
  }));

  router.get('/', (req, res) => send(res, () => {
    const rows = db.prepare(`SELECT id, doc_no, promo_no, status, doc_date, customer_code, customer_name, title, created_by, created_by_name, levels_json, cur_level, updated_at, approved_at
      FROM mkt_promo_docs ORDER BY created_at DESC LIMIT 2000`).all();
    return rows.map(r => {
      const levels = parseJson(r.levels_json, []);
      const cur = levels[r.cur_level];
      return { ...r, levels_json: undefined, level_count: levels.length, cur_label: cur ? cur.label : null,
        awaiting_me: r.status === 'pending' && !!cur && (cur.uids || []).includes(req.user.uid), _ap: levels.some(l => (l.uids || []).includes(req.user.uid)) };
    }).filter(r => isAll(req.user) || canPaper(req.user) || r.created_by === req.user.uid || r._ap).map(r => ({ ...r, _ap: undefined }));
  }));

  router.get('/:id', (req, res) => send(res, () => { load(req.params.id, req.user); return full(req.params.id); }));

  const writeBody = (req, head, body) => [head.doc_date, head.customer_code, head.customer_name, head.gp, head.title, head.purpose, head.route_id, JSON.stringify(body),
    JSON.stringify(cleanCc(db, req.body?.cc)), req.body?.cc_owner === false ? 0 : 1];

  router.post('/', (req, res) => send(res, () => tx(db, () => {
    if (!canCreate(req.user) && !canPaper(req.user)) throw httpErr(403, 'ไม่มีสิทธิ์สร้างใบเคาะราคา การตลาด');
    const { head, body } = buildDoc(db, req.body);
    const id = genId('MKT');
    const docNo = nextNo(db, 'doc_no', 'MKT', 4, MKT_SEED);
    db.prepare(`INSERT INTO mkt_promo_docs (id, doc_no, status, doc_date, customer_code, customer_name, gp, title, purpose, route_id, body_json, cc_json, cc_owner, levels_json, created_by, created_by_name, updated_by)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`).run(id, docNo, ...writeBody(req, head, body), req.user.uid, req.user.name || req.user.uid, req.user.uid);
    log(db, id, 'create', docNo, req.user.uid);
    return full(id);
  })));

  router.put('/:id', (req, res) => send(res, () => tx(db, () => {
    const d = load(req.params.id, req.user);
    if (!EDITABLE.includes(d.status)) throw httpErr(400, 'แก้ไขได้เฉพาะใบที่เป็นร่าง หรือถูกตีกลับ');
    if (!canWriteDoc(d, req.user)) throw httpErr(403, 'แก้ไขได้เฉพาะผู้เสนอ');
    const { head, body } = buildDoc(db, req.body);
    db.prepare(`UPDATE mkt_promo_docs SET doc_date = ?, customer_code = ?, customer_name = ?, gp = ?, title = ?, purpose = ?, route_id = ?, body_json = ?, cc_json = ?, cc_owner = ?,
      updated_by = ?, updated_at = ${now} WHERE id = ?`).run(...writeBody(req, head, body), req.user.uid, d.id);
    log(db, d.id, 'update', null, req.user.uid);
    return full(d.id);
  })));

  // ส่งอนุมัติ: body.levels = [{label, uids:[...]}] ตามเส้นทาง (ผู้เสนอแก้รายชื่อได้ ขั้นละ ≥1 คน ห้ามใส่ตัวเอง)
  router.post('/:id/submit', (req, res) => {
    let out, notify;
    try {
      out = tx(db, () => {
        const d = load(req.params.id, req.user);
        if (!EDITABLE.includes(d.status)) throw httpErr(400, 'ส่งอนุมัติได้เฉพาะใบที่เป็นร่าง หรือถูกตีกลับ');
        if (d.created_by !== req.user.uid) throw httpErr(403, 'ส่งอนุมัติได้เฉพาะผู้เสนอ');
        const { issues } = buildDoc(db, { ...d, ...d.body });
        if (issues.length) throw httpErr(400, `ยังส่งอนุมัติไม่ได้ ต้องแก้ ${issues.length} จุด: ${issues.slice(0, 5).join(' · ')}`);
        const route = routes().find(r => r.id === d.route_id);
        if (!route) throw httpErr(400, 'ไม่พบเส้นทางอนุมัติ — เลือกเส้นทางใหม่');
        const getU = db.prepare('SELECT uid, name FROM sc_users WHERE uid = ? AND is_active = 1');
        const given = Array.isArray(req.body?.levels) ? req.body.levels : [];
        const levels = route.levels.map((l, i) => {
          const uids = [...new Set((Array.isArray(given[i]?.uids) ? given[i].uids : l.uids || []).map(String))].filter(u => getU.get(u));
          if (uids.includes(d.created_by)) throw httpErr(400, `ขั้น ${l.label}: ผู้เสนอเป็นผู้อนุมัติเองไม่ได้`);
          if (!uids.length) throw httpErr(400, `ขั้น ${l.label}: ต้องมีผู้อนุมัติอย่างน้อย 1 คน`);
          return { label: l.label, uids, names: uids.map(u => getU.get(u).name), status: 'wait', by: null, at: null, comment: null };
        });
        db.prepare(`UPDATE mkt_promo_docs SET status = 'pending', levels_json = ?, cur_level = 0, submitted_at = ${now}, reject_reason = NULL, updated_by = ?, updated_at = ${now} WHERE id = ?`)
          .run(JSON.stringify(levels), req.user.uid, d.id);
        log(db, d.id, 'submit', levels.map(l => `${l.label}: ${l.names.join('/')}`).join(' → '), req.user.uid);
        const f = full(d.id);
        notify = { d: f, uids: levels[0].uids, label: levels[0].label };
        return f;
      });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json(out);
    if (notify) mailApprovers(db, notify.d, notify.uids, notify.label).catch(x => console.warn('[mktPromoMail]', x.message));
  });

  // ส่งอนุมัติ offline (2026-11-23, ผู้ใช้สั่ง: ยังไม่ได้ใช้ผ่านระบบ 100%) — ล็อกใบ + พิมพ์ไปเซ็นบนกระดาษตามขั้นของเส้นทาง
  // ไม่ต้องตั้งผู้อนุมัติในระบบ · เซ็นครบแล้วถ่ายรูปแนบ → ผู้บันทึกกด "บันทึกอนุมัติจากเอกสารกระดาษ" (paper-approve)
  router.post('/:id/submit-offline', (req, res) => send(res, () => tx(db, () => {
    const d = load(req.params.id, req.user);
    if (!EDITABLE.includes(d.status)) throw httpErr(400, 'ส่งอนุมัติได้เฉพาะใบที่เป็นร่าง หรือถูกตีกลับ');
    if (!canWriteDoc(d, req.user)) throw httpErr(403, 'ส่งอนุมัติได้เฉพาะผู้เสนอ');
    const { issues } = buildDoc(db, { ...d, ...d.body });
    if (issues.length) throw httpErr(400, `ยังส่งอนุมัติไม่ได้ ต้องแก้ ${issues.length} จุด: ${issues.slice(0, 5).join(' · ')}`);
    const route = routes().find(r => r.id === d.route_id) || routes()[0];
    // ช่องลงนามบนกระดาษตามขั้นของเส้นทาง (ไม่ผูกผู้ใช้ในระบบ)
    const levels = (route?.levels || []).map(l => ({ label: l.label, uids: [], names: [], status: 'offline', by: null, at: null, comment: null }));
    db.prepare(`UPDATE mkt_promo_docs SET status = 'offline', approval_mode = 'paper', levels_json = ?, cur_level = 0, submitted_at = ${now}, reject_reason = NULL,
      updated_by = ?, updated_at = ${now} WHERE id = ?`).run(JSON.stringify(levels), req.user.uid, d.id);
    log(db, d.id, 'submit_offline', `ส่งอนุมัติแบบ offline (กระดาษ) · ${levels.map(l => l.label).join(' → ')}`, req.user.uid);
    return full(d.id);
  })));

  router.post('/:id/recall', (req, res) => send(res, () => tx(db, () => {
    const d = load(req.params.id, req.user);
    if (!['pending', 'offline'].includes(d.status)) throw httpErr(400, 'เรียกคืนได้เฉพาะใบที่รออนุมัติ');
    if (d.created_by !== req.user.uid && !(d.status === 'offline' && canWriteDoc(d, req.user))) throw httpErr(403, 'เรียกคืนได้เฉพาะผู้เสนอ');
    db.prepare(`UPDATE mkt_promo_docs SET status = 'draft', cur_level = 0, updated_by = ?, updated_at = ${now} WHERE id = ?`).run(req.user.uid, d.id);
    log(db, d.id, 'recall', null, req.user.uid);
    return full(d.id);
  })));

  router.post('/:id/approve', (req, res) => {
    let out, after;
    try {
      out = tx(db, () => {
        const d = load(req.params.id, req.user);
        if (d.status !== 'pending') throw httpErr(400, 'ใบนี้ไม่ได้รออนุมัติ');
        const lv = d.levels[d.cur_level];
        if (!lv || !lv.uids.includes(req.user.uid)) throw httpErr(403, 'คุณไม่ใช่ผู้อนุมัติของขั้นนี้');
        if (d.created_by === req.user.uid) throw httpErr(403, 'ผู้เสนออนุมัติใบของตัวเองไม่ได้');
        const comment = txt(req.body?.comment, 500) || null;
        Object.assign(lv, { status: 'approved', by: req.user.uid, by_name: req.user.name || req.user.uid, at: new Date().toISOString(), comment });
        const last = d.cur_level >= d.levels.length - 1;
        if (last) {
          const promoNo = nextNo(db, 'promo_no', 'M', 5, PRO_SEED);
          db.prepare(`UPDATE mkt_promo_docs SET status = 'approved', promo_no = ?, levels_json = ?, approved_at = ${now}, updated_by = ?, updated_at = ${now} WHERE id = ?`)
            .run(promoNo, JSON.stringify(d.levels), req.user.uid, d.id);
          log(db, d.id, 'approve', `${lv.label} · อนุมัติครบ ออกเลข ${promoNo}${comment ? ' · ' + comment : ''}`, req.user.uid);
          after = { kind: 'cc', id: d.id };
        } else {
          db.prepare(`UPDATE mkt_promo_docs SET levels_json = ?, cur_level = cur_level + 1, updated_by = ?, updated_at = ${now} WHERE id = ?`).run(JSON.stringify(d.levels), req.user.uid, d.id);
          log(db, d.id, 'approve', `${lv.label}${comment ? ' · ' + comment : ''}`, req.user.uid);
          after = { kind: 'next', id: d.id, uids: d.levels[d.cur_level + 1].uids, label: d.levels[d.cur_level + 1].label };
        }
        return full(d.id);
      });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json(out);
    (async () => {
      if (after.kind === 'next') return mailApprovers(db, out, after.uids, after.label);
      const r = await mailCc(db, out);
      const sentTo = r.sent ? `ส่งแล้ว ${r.count} คน` : r.reason === 'NO_RECIPIENT' ? 'ไม่มีผู้รับ' : `ส่งไม่สำเร็จ (${r.reason})`;
      db.prepare(`UPDATE mkt_promo_docs SET cc_sent_at = ${now}, cc_sent_note = ? WHERE id = ?`).run(sentTo, after.id);
      log(db, after.id, 'cc_mail', sentTo, null);
    })().catch(x => console.warn('[mktPromoMail]', x.message));
  });

  // บันทึกอนุมัติจากเอกสารกระดาษ — ต้องแนบรูป/PDF เอกสารที่เซ็นอนุมัติแล้วอย่างน้อย 1 ไฟล์ · ข้ามขั้นอนุมัติในระบบ
  router.post('/:id/paper-approve', (req, res) => {
    let out;
    try {
      out = tx(db, () => {
        const d = load(req.params.id, req.user);
        if (!canPaper(req.user)) throw httpErr(403, 'ไม่มีสิทธิ์บันทึกอนุมัติจากเอกสารกระดาษ');
        if (!EDITABLE.includes(d.status) && !['pending', 'offline'].includes(d.status)) throw httpErr(400, 'บันทึกอนุมัติได้เฉพาะใบที่ยังไม่อนุมัติ');
        const { issues } = buildDoc(db, { ...d, ...d.body });
        if (issues.length) throw httpErr(400, `ยังบันทึกไม่ได้ ต้องแก้ ${issues.length} จุด: ${issues.slice(0, 5).join(' · ')}`);
        const scans = db.prepare("SELECT COUNT(*) AS n FROM mkt_promo_attachments WHERE doc_id = ? AND (mime_type LIKE 'image/%' OR mime_type = 'application/pdf')").get(d.id).n;
        if (!scans) throw httpErr(400, 'กรุณาแนบรูปถ่าย/PDF เอกสารที่เซ็นอนุมัติแล้วก่อน');
        const note = txt(req.body?.note, 500) || null;
        const promoNo = nextNo(db, 'promo_no', 'M', 5, PRO_SEED);
        const at = new Date().toISOString(), me = req.user.name || req.user.uid;
        // ใบที่ส่งแบบ offline มีช่องลงนามตามขั้นของเส้นทางอยู่แล้ว → คงช่องไว้ ระบุว่าลงนามในเอกสารแนบ · ใบอื่น = ช่องเดียว
        const levels = d.status === 'offline' && d.levels.length
          ? d.levels.map(l => ({ ...l, status: 'approved', by: null, by_name: '(ลงนามในเอกสารแนบ)', at, comment: null, recorded_by: req.user.uid, recorded_by_name: me, note }))
          : [{ label: 'อนุมัติจากเอกสารกระดาษ', uids: [req.user.uid], names: [me], status: 'approved', by: req.user.uid, by_name: me, at, comment: note, recorded_by: req.user.uid, recorded_by_name: me, note }];
        db.prepare(`UPDATE mkt_promo_docs SET status = 'approved', approval_mode = 'paper', promo_no = ?, levels_json = ?, cur_level = 0, submitted_at = COALESCE(submitted_at, ${now}),
          approved_at = ${now}, reject_reason = NULL, updated_by = ?, updated_at = ${now} WHERE id = ?`).run(promoNo, JSON.stringify(levels), req.user.uid, d.id);
        log(db, d.id, 'paper_approve', `อนุมัติจากเอกสารกระดาษ (แนบ ${scans} ไฟล์) · ออกเลข ${promoNo}${note ? ' · ' + note : ''}`, req.user.uid);
        return full(d.id);
      });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json(out);
    (async () => {
      const r = await mailCc(db, out);
      const sentTo = r.sent ? `ส่งแล้ว ${r.count} คน` : r.reason === 'NO_RECIPIENT' ? 'ไม่มีผู้รับ' : `ส่งไม่สำเร็จ (${r.reason})`;
      db.prepare(`UPDATE mkt_promo_docs SET cc_sent_at = ${now}, cc_sent_note = ? WHERE id = ?`).run(sentTo, out.id);
      log(db, out.id, 'cc_mail', sentTo, null);
    })().catch(x => console.warn('[mktPromoMail]', x.message));
  });

  router.post('/:id/reject', (req, res) => send(res, () => tx(db, () => {
    const d = load(req.params.id, req.user);
    if (d.status !== 'pending') throw httpErr(400, 'ใบนี้ไม่ได้รออนุมัติ');
    const lv = d.levels[d.cur_level];
    if (!lv || !lv.uids.includes(req.user.uid)) throw httpErr(403, 'คุณไม่ใช่ผู้อนุมัติของขั้นนี้');
    const reason = txt(req.body?.reason, 500);
    if (!reason) throw httpErr(400, 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    Object.assign(lv, { status: 'rejected', by: req.user.uid, by_name: req.user.name || req.user.uid, at: new Date().toISOString(), comment: reason });
    db.prepare(`UPDATE mkt_promo_docs SET status = 'rejected', levels_json = ?, reject_reason = ?, updated_by = ?, updated_at = ${now} WHERE id = ?`).run(JSON.stringify(d.levels), reason, req.user.uid, d.id);
    log(db, d.id, 'reject', `${lv.label} · ${reason}`, req.user.uid);
    return full(d.id);
  })));

  router.post('/:id/cancel', (req, res) => send(res, () => tx(db, () => {
    const d = load(req.params.id, req.user);
    if (d.status === 'cancelled') throw httpErr(400, 'ใบนี้ยกเลิกแล้ว');
    if (d.created_by !== req.user.uid && !ADMIN_ROLES.includes(req.user.role)) throw httpErr(403, 'ยกเลิกได้เฉพาะผู้เสนอหรือแอดมิน');
    db.prepare(`UPDATE mkt_promo_docs SET status = 'cancelled', cancelled_at = ${now}, updated_by = ?, updated_at = ${now} WHERE id = ?`).run(req.user.uid, d.id);
    log(db, d.id, 'cancel', txt(req.body?.reason, 500) || null, req.user.uid);
    return full(d.id);
  })));

  // ── ไฟล์แนบ (ตั้งชื่อที่จะแสดงบนเอกสารเองได้) ──
  router.post('/:id/attachments', (req, res) => upload(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกินไป (จำกัด 10MB ต่อไฟล์)' : `อัปโหลดไม่สำเร็จ: ${err.message}` });
    send(res, () => {
      const d = load(req.params.id, req.user);
      if (!canWriteDoc(d, req.user)) throw httpErr(403, 'แนบไฟล์ได้เฉพาะผู้เสนอ');
      if (!EDITABLE.includes(d.status) && d.status !== 'offline') throw httpErr(400, 'แนบไฟล์ได้เฉพาะใบที่เป็นร่าง ถูกตีกลับ หรือรออนุมัติ offline');
      const f = req.file;
      if (!f) throw httpErr(400, 'ไม่พบไฟล์');
      if (!attTypes.has(f.mimetype)) throw httpErr(400, 'รองรับ PDF, รูปภาพ, Excel, Word, CSV');
      if (!sniffOk(f.buffer, f.mimetype)) throw httpErr(400, 'เนื้อไฟล์ไม่ตรงกับชนิดไฟล์ที่แนบ');
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const id = genId('MKA');
      db.prepare('INSERT INTO mkt_promo_attachments (id, doc_id, label, filename, mime_type, content, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, d.id, txt(req.body?.label, 160) || name.replace(/\.[^.]+$/, ''), name, f.mimetype, f.buffer, req.user.uid);
      log(db, d.id, 'attach', name, req.user.uid);
      return full(d.id).attachments;
    });
  }));
  router.patch('/:id/attachments/:aid', (req, res) => send(res, () => {
    const d = load(req.params.id, req.user);
    if (!canWriteDoc(d, req.user)) throw httpErr(403, 'แก้ได้เฉพาะผู้เสนอ');
    const label = txt(req.body?.label, 160);
    if (!label) throw httpErr(400, 'กรุณาตั้งชื่อเอกสาร');
    const r = db.prepare('UPDATE mkt_promo_attachments SET label = ? WHERE id = ? AND doc_id = ?').run(label, req.params.aid, d.id);
    if (!r.changes) throw httpErr(404, 'ไม่พบไฟล์');
    return full(d.id).attachments;
  }));
  router.delete('/:id/attachments/:aid', (req, res) => send(res, () => {
    const d = load(req.params.id, req.user);
    if (!canWriteDoc(d, req.user)) throw httpErr(403, 'ลบได้เฉพาะผู้เสนอ');
    if (!EDITABLE.includes(d.status) && d.status !== 'offline') throw httpErr(400, 'ลบไฟล์ได้เฉพาะใบที่เป็นร่าง ถูกตีกลับ หรือรออนุมัติ offline');
    const r = db.prepare('DELETE FROM mkt_promo_attachments WHERE id = ? AND doc_id = ?').run(req.params.aid, d.id);
    if (!r.changes) throw httpErr(404, 'ไม่พบไฟล์');
    log(db, d.id, 'detach', req.params.aid, req.user.uid);
    return full(d.id).attachments;
  }));
  router.get('/:id/attachments/:aid/content', (req, res) => {
    try {
      const d = load(req.params.id, req.user);
      const row = db.prepare('SELECT filename, mime_type, content FROM mkt_promo_attachments WHERE id = ? AND doc_id = ?').get(req.params.aid, d.id);
      if (!row) return res.status(404).json({ error: 'ไม่พบไฟล์' });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', row.mime_type);
      const inline = /^(image\/|application\/pdf)/.test(row.mime_type);
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
      res.send(Buffer.from(row.content));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  });

  return router;
};
module.exports.DEFAULT_ROUTES = DEFAULT_ROUTES;
module.exports.buildDoc = buildDoc;
