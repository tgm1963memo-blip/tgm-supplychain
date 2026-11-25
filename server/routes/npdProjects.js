'use strict';
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { genId } = require('../lib/crud');
const { nextDocNo } = require('../lib/docNumber');
const { sendMail, escapeHtml } = require('../lib/mailer');

// พัฒนาสินค้าใหม่ (NPD) — 2026-11-25 แยกจากเมนู "ของตัวอย่าง" ตาม flow 13 ขั้นที่ผู้ใช้ยืนยัน (แผน vivid-churning-rainbow)
// โครงตาม routes/mktPromoDocs.js: ทุกการเปลี่ยนสถานะทำที่ server ภายใน BEGIN IMMEDIATE + ตรวจว่าผู้กดอยู่ในรายชื่อของขั้นนั้น
//   ① Sales สร้าง → ② หัวหน้าที่เลือกตอนส่ง → ③ พี่หลินบันทึกผลคุณอ้อย (เซ็นกระดาษ ต้องแนบสแกน) → ④ คุณโอ
//   ไม่ผ่านที่ ②③④ = ส่งกลับให้ Sales แก้ (บังคับเหตุผล) · ส่งใหม่เริ่มที่หัวหน้าเสมอ (ผู้ใช้เลือก 2026-11-25)
//   ⑤ คุณโอผ่าน → แจ้ง RD + Sales อัตโนมัติ · ⑥ RD รับเรื่อง · ⑦ RD ส่งตัวอย่าง → Sales กดได้รับ · ⑧ ส่งให้ลูกค้า
//   ⑨ Feedback: ผ่าน / ปรับสูตร (เปิดรอบใหม่ round+1 ลิงก์ root_id/prev_id) / ยกเลิกโปรเจกต์
//   ⑩ Sales กรอก lot แรก (≥40 กก. ตามแบบฟอร์ม Testing Report) + forecast · ⑪ RD แนบ spec + ส่งทุนเบื้องต้น (คู่ขนาน)
//   ⑫ บัญชีต้นทุนบันทึกทุนที่คำนวณ · ⑬ Sales เสนอราคา → คุณโอ: ผ่าน (→ บัญชีโรงงานเปิดรหัส → เปิดขาย)
//      / ไม่ผ่าน เลือกได้ 4 ทาง: คุยราคาใหม่ · ปรับ spec-ทุน · เริ่มตัวอย่างรอบใหม่ · ยกเลิก (ผู้ใช้เลือก 2026-11-25)
// ผู้รับผิดชอบ lin/o/rd/cost_acct/factory_acct มาจาก npd_settings (แอดมินตั้ง) · แอดมินทำแทนทุกขั้นได้ (log ระบุ)
// ข้อมูลทุน (cost_json) เห็นเฉพาะ RD / บัญชีต้นทุน / คุณโอ / พี่หลิน (เพิ่ม 2026-11-25 ผู้ใช้สั่ง) / แอดมิน — สอดคล้องกติกาทุนเดิม (2026-10-27)
const CREATE_ROLES = ['superadmin', 'admin', 'manager', 'sales', 'sales_manager', 'sales_officer', 'sales_worker'];
const HEAD_ROLES = ['superadmin', 'admin', 'manager', 'sales_manager'];
const ADMIN_ROLES = ['superadmin', 'admin'];
const SETTING_KEYS = { lin: 'พี่หลิน (บันทึกผลคุณอ้อย)', o: 'คุณโอ', rd: 'ทีม RD', cost_acct: 'บัญชีต้นทุนโรงงาน', factory_acct: 'บัญชีโรงงาน (เปิดรหัสสินค้า)' };
const STATUS = {
  draft: 'ร่าง', returned: 'ส่งกลับแก้ไข', pending_head: 'รอหัวหน้าอนุมัติ', pending_paper: 'รอผลอนุมัติคุณอ้อย (พี่หลิน)',
  pending_o: 'รอคุณโออนุมัติ', rd_queue: 'รอ RD รับเรื่อง', rd_dev: 'RD กำลังพัฒนา', sample_sent: 'RD ส่งตัวอย่างแล้ว',
  sample_received: 'Sales ได้รับตัวอย่าง', at_customer: 'ลูกค้ากำลังทดสอบ', first_lot: 'รอ Sales แจ้ง lot แรก/forecast',
  spec_cost: 'RD ทำ spec + ทุน', price_quote: 'รอ Sales เสนอราคา', price_review: 'รอคุณโอพิจารณาราคา',
  sku_setup: 'รอบัญชีโรงงานเปิดรหัสสินค้า', launched: 'เปิดขายแล้ว', revised: 'ปิดรอบ (เปิดรอบใหม่แล้ว)', cancelled: 'ยกเลิก',
};
const CLOSED = ['launched', 'revised', 'cancelled'];
const EDITABLE = ['draft', 'returned'];
const MIN_FIRST_LOT_KG = 40;
const ATT_KINDS = { scan_paper: 'สแกนเอกสารอนุมัติ', rd_doc: 'เอกสารส่งตัวอย่าง (RD)', rd_spec: 'Spec (RD)', customer: 'เอกสารลูกค้า', other: 'อื่นๆ' };
// ฟิลด์สินค้าตามแบบฟอร์มโรงงาน FM-RDC-RDD-12 — ตรงกับ _srBlankItem('new') ใน index.html (ฟอร์มเดิมของเมนูของตัวอย่าง)
const ITEM_KEYS = ['name', 'qty', 'unit', 'targetPrice', 'forecastKg', 'refSku', 'refName', 'competitor', 'note',
  'brand', 'brandOther', 'pack1G', 'pack1Qty', 'pack1Type', 'pack2G', 'pack2Qty', 'pack2Type', 'outer', 'outerQty', 'boxType',
  'casing', 'casingOther', 'sliceMm', 'pcsPerKg', 'diameterMm', 'weightG', 'lengthVal', 'lengthUnit', 'storage', 'storageDays',
  'coaPhys', 'coaChem', 'coaMicro', 'coaYear', 'draftSpec', 'detail'];
const ITEM_REQ = [['name', 'ชื่อสินค้า'], ['targetPrice', 'ราคาขายลูกค้า'], ['forecastKg', 'ยอดสั่งซื้อ/เดือน'], ['qty', 'จำนวนตัวอย่าง'],
  ['brand', 'Brand'], ['pack1G', 'Packing size (g.)'], ['pack1Qty', 'Packing size (Pack)'], ['pack1Type', 'ซองบรรจุ'],
  ['outer', 'บรรจุภัณฑ์รวม'], ['casing', 'Type of Casing'], ['sliceMm', 'Slice thickness'], ['pcsPerKg', 'Pieces / Kg'],
  ['diameterMm', 'Diameter'], ['weightG', 'Weight / Piece'], ['lengthVal', 'Length'], ['storage', 'Storage'], ['storageDays', 'Shelf life'],
  ['detail', 'รายละเอียดเพิ่มเติม'], ['coaPhys', 'COA ด้านกายภาพ'], ['coaChem', 'COA ด้านเคมี'], ['coaMicro', 'COA ด้านจุลินทรีย์'],
  ['coaYear', 'COA รายปี'], ['draftSpec', 'Draft Spec.']];
const HEADER_KEYS = ['contact', 'phone', 'purpose', 'deliveryDate', 'address', 'note', 'custGroup', 'gpTarget'];
const MAX_ITEMS = 20;

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const txt = (v, max = 300) => { const s = String(v ?? '').replace(/[ \t]+/g, ' ').trim(); return s ? s.slice(0, max) : ''; };
const longTxt = (v, max = 3000) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : 0; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isMonth = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } };
const nowIso = () => new Date().toISOString();

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ทำความสะอาดเนื้อหาคำขอจาก client → { cust_code, cust_name, header, items, issues }
// ร่างบันทึกได้แม้ยังไม่ครบ · issues ใช้ตอนส่งอนุมัติ (บังคับครบตามแบบฟอร์มโรงงาน เหมือน _srFmMissing ฝั่งหน้าเว็บ)
function buildRequest(db, b) {
  b = b || {};
  const cust_code = txt(b.cust_code, 40);
  const c = cust_code ? db.prepare('SELECT name FROM customers WHERE code = ?').get(cust_code) : null;
  const cust_name = c ? c.name : txt(b.cust_name, 200);
  const hIn = b.header || {};
  const header = {};
  for (const k of HEADER_KEYS) header[k] = k === 'note' || k === 'address' ? longTxt(hIn[k], 1000) : txt(hIn[k], 200);
  if (header.deliveryDate && !isDate(header.deliveryDate)) header.deliveryDate = '';
  // ค่าใช้จ่ายอื่นๆ (ค่าแม่พิมพ์/บรรจุภัณฑ์ใหม่ ฯลฯ) — เหมือน new_info.costs ของฟอร์มเดิม
  header.costs = (Array.isArray(hIn.costs) ? hIn.costs : []).slice(0, 20)
    .map(c => ({ item: txt(c?.item, 200), amount: pos(c?.amount), note: txt(c?.note, 300) })).filter(c => c.item || c.amount);
  const itemsIn = Array.isArray(b.items) ? b.items : [];
  if (itemsIn.length > MAX_ITEMS) throw httpErr(400, `สินค้าเกิน ${MAX_ITEMS} รายการ`);
  const items = itemsIn.map(it => {
    const o = {};
    for (const k of ITEM_KEYS) o[k] = k === 'detail' || k === 'note' ? longTxt(it?.[k], 2000) : txt(it?.[k], 200);
    return o;
  }).filter(o => ITEM_KEYS.some(k => !['qty', 'unit', 'lengthUnit'].includes(k) && o[k]));
  const issues = [];
  if (!cust_code && !cust_name) issues.push('ยังไม่ได้เลือกลูกค้า');
  if (cust_code && !c) issues.push(`ไม่พบรหัสลูกค้า ${cust_code}`);
  for (const [k, l] of [['contact', 'ผู้ติดต่อ'], ['phone', 'เบอร์โทร'], ['purpose', 'วัตถุประสงค์'], ['deliveryDate', 'วันที่ต้องการรับ'], ['custGroup', 'กลุ่มลูกค้า']]) {
    if (!header[k]) issues.push(`ยังไม่ได้กรอก${l}`);
  }
  if (!items.length) issues.push('ยังไม่มีสินค้า เพิ่มอย่างน้อย 1 รายการ');
  items.forEach((it, i) => {
    const req = [...ITEM_REQ];
    if (it.brand === 'other') req.push(['brandOther', 'Brand อื่นๆ']);
    if (it.casing === 'other') req.push(['casingOther', 'ไส้อื่นๆ']);
    if (it.outer) req.push(['outerQty', 'จำนวนบรรจุภัณฑ์รวม']);
    if (it.outer === 'box') req.push(['boxType', 'กล่องมีตรา/ไม่มีตรา']);
    if (it.pack2G || it.pack2Qty || it.pack2Type) req.push(['pack2G', 'Packing size 2 (g.)'], ['pack2Qty', 'Packing size 2 (Pack)'], ['pack2Type', 'ซองบรรจุ 2']);
    const miss = req.filter(([k]) => !it[k] || (k === 'qty' && !(pos(it.qty) > 0))).map(([, l]) => l);
    if (miss.length) issues.push(`สินค้า #${i + 1} ยังกรอกไม่ครบ: ${miss.slice(0, 4).join(', ')}${miss.length > 4 ? ' …' : ''}`);
  });
  return { cust_code: c ? cust_code : (cust_code || null), cust_name, header, items, issues };
}

const appUrl = () => (process.env.APP_PUBLIC_URL || 'https://tss-supplychain.vercel.app').replace(/\/+$/, '');
const e = v => escapeHtml(v == null ? '' : String(v));

const attTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } }).single('file');
// ตรวจเนื้อไฟล์จริง (magic bytes) — กันไฟล์ html/script ปลอมชนิด (บทเรียน stored-XSS 2026-09-15)
function sniffOk(buf, mime) {
  const starts = (...b) => b.every((x, i) => buf[i] === x);
  if (mime === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47);
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  if (mime.includes('openxmlformats')) return starts(0x50, 0x4b, 0x03, 0x04);
  return false;
}

// ผู้รับผิดชอบรายขั้น (npd_settings) + คีย์ของคนที่ต้องทำขั้นปัจจุบัน — ใช้ทั้งใน route นี้และกระดิ่งแจ้งเตือน (routes/inbox.js)
function settingsOf(db) {
  const out = {};
  for (const k of Object.keys(SETTING_KEYS)) out[k] = parseJson(db.prepare('SELECT value FROM npd_settings WHERE key = ?').get(k)?.value, []);
  return out;
}
const STEP_KEYS = { draft: ['owner'], returned: ['owner'], pending_head: ['head'], pending_paper: ['lin'], pending_o: ['o'], rd_queue: ['rd'],
  rd_dev: ['rd'], sample_sent: ['owner'], sample_received: ['owner'], at_customer: ['owner'], first_lot: ['owner'],
  price_quote: ['owner'], price_review: ['o'], sku_setup: ['factory_acct'] };
// spec_cost มีงานคู่ขนาน: RD (spec + ทุนเบื้องต้น) แล้วบัญชีต้นทุน (หลัง RD ส่งทุน)
function stepKeys(status, f) {
  f = f || {};
  if (status === 'spec_cost') return [...(!f.spec_at || !f.rd_cost_at ? ['rd'] : []), ...(f.rd_cost_at && !f.acct_cost_at ? ['cost_acct'] : [])];
  return STEP_KEYS[status] || [];
}
const keyUids = (p, key, s) => key === 'owner' ? [p.created_by] : key === 'head' ? (p.head_uid ? [p.head_uid] : []) : (s[key] || []);
// งาน NPD ที่รอผู้ใช้คนนี้ (ไม่นับร่าง/ส่งกลับของตัวเอง — อยู่ในเมนูอยู่แล้ว ไม่ใช่งานรออนุมัติ)
function awaitingFor(db, uid) {
  const s = settingsOf(db);
  return db.prepare("SELECT id, doc_no, legacy_no, status, flags_json, created_by, created_by_name, head_uid, cust_name, items_json, status_at FROM npd_projects WHERE status NOT IN ('draft', 'returned', 'launched', 'revised', 'cancelled')").all()
    .filter(p => stepKeys(p.status, parseJson(p.flags_json, {})).some(k => keyUids(p, k, s).includes(uid)));
}

module.exports = function npdProjectsRoutes(db) {
  const router = express.Router();
  router.use(requireAuth(db));

  const settings = () => settingsOf(db);
  const isAdmin = u => ADMIN_ROLES.includes(u.role);
  const inSetting = (u, k, s = settings()) => (s[k] || []).includes(u.uid);
  const isActor = (u, s = settings()) => Object.keys(SETTING_KEYS).some(k => inSetting(u, k, s));
  const canSeeAll = u => isAdmin(u) || HEAD_ROLES.includes(u.role) || isActor(u);
  const canSeeCost = u => isAdmin(u) || ['rd', 'cost_acct', 'o', 'lin'].some(k => inSetting(u, k));
  // ผู้มีสิทธิ์ทำขั้นตาม key: owner / head / คีย์ใน npd_settings
  const uidsFor = (p, key, s = settings()) => keyUids(p, key, s);
  const can = (p, u, keys) => isAdmin(u) || keys.some(k => uidsFor(p, k).includes(u.uid));

  const shape = (r, u) => {
    if (!r) return r;
    const p = { ...r, header: parseJson(r.header_json, {}), items: parseJson(r.items_json, []), flags: parseJson(r.flags_json, {}),
      test: parseJson(r.test_json, null), first_lot: parseJson(r.first_lot_json, null), price: parseJson(r.price_json, null),
      cost: canSeeCost(u) ? parseJson(r.cost_json, null) : undefined, status_label: STATUS[r.status] || r.status };
    for (const k of ['header_json', 'items_json', 'flags_json', 'test_json', 'first_lot_json', 'price_json', 'cost_json']) delete p[k];
    return p;
  };
  const raw = id => db.prepare('SELECT * FROM npd_projects WHERE id = ?').get(String(id || ''));
  const load = (id, u) => {
    const r = raw(id);
    if (!r) throw httpErr(404, 'ไม่พบโปรเจกต์ NPD');
    if (!canSeeAll(u) && r.created_by !== u.uid && r.head_uid !== u.uid) throw httpErr(403, 'ไม่มีสิทธิ์ดูโปรเจกต์นี้');
    return r;
  };
  const full = (id, u) => {
    const p = shape(raw(id), u);
    p.logs = db.prepare('SELECT * FROM npd_logs WHERE project_id = ? ORDER BY id').all(id);
    p.attachments = db.prepare('SELECT id, kind, label, filename, mime_type, length(content) AS size_bytes, uploaded_by, created_at FROM npd_attachments WHERE project_id = ? ORDER BY created_at').all(id);
    const root = p.root_id || p.id;
    p.chain = db.prepare('SELECT id, doc_no, legacy_no, round, status FROM npd_projects WHERE id = ? OR root_id = ? ORDER BY round, created_at').all(root, root);
    p.issues = EDITABLE.includes(p.status) ? buildRequest(db, { cust_code: p.cust_code, cust_name: p.cust_name, header: p.header, items: p.items }).issues : [];
    p.next_actors = nextActors(p);
    return p;
  };
  // "อยู่ที่ใคร" ของขั้นปัจจุบัน → [{key, uids}] (spec_cost มี 2-3 งานคู่ขนาน)
  function nextActors(p) {
    const keys = stepKeys(p.status, p.flags);
    const s = settings();
    const nm = db.prepare('SELECT name FROM sc_users WHERE uid = ?');
    return keys.map(k => { const uids = uidsFor(p, k, s); return { key: k, uids, names: uids.map(u => nm.get(u)?.name || u) }; });
  }
  const log = (p, action, from, to, detail, u) => db.prepare('INSERT INTO npd_logs (project_id, action, from_status, to_status, detail, by_uid, by_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, action, from, to, detail == null ? null : String(detail).slice(0, 1000), u ? u.uid : null, u ? (u.name || u.uid) : null);
  const setStatus = (p, to, u, extra = {}) => {
    const cols = Object.keys(extra);
    db.prepare(`UPDATE npd_projects SET status = ?, status_at = ?, updated_by = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ?`)
      .run(to, nowIso(), u.uid, nowIso(), ...cols.map(c => extra[c]), p.id);
  };
  const send = (res, fn) => { try { res.json(fn()); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

  // อีเมลแจ้งผู้รับผิดชอบขั้นถัดไป (fire-and-forget หลังตอบ client — ส่งไม่สำเร็จไม่กระทบการทำงาน)
  async function mailKeys(id, keys, what) {
    const p = raw(id);
    if (!p) return;
    const s = settings();
    const uids = [...new Set(keys.flatMap(k => uidsFor(p, k, s)))];
    if (!uids.length) return;
    const to = db.prepare(`SELECT email FROM sc_users WHERE uid IN (${uids.map(() => '?').join(',')}) AND is_active = 1 AND email IS NOT NULL AND email <> ''`).all(...uids).map(r => r.email);
    if (!to.length) return;
    const no = p.doc_no || p.legacy_no || p.id;
    const items = parseJson(p.items_json, []).map(it => it.name).filter(Boolean).join(', ');
    const subject = `[NPD ${no}] ${what}`;
    const html = `<div style="font-family:Sarabun,Arial,sans-serif;max-width:640px"><p><b>${e(what)}</b></p>
      <p>โปรเจกต์ ${e(no)} (รอบที่ ${e(p.round)}) · ลูกค้า ${e(p.cust_name || p.cust_code || '-')}<br>สินค้า: ${e(items || '-')}<br>ผู้ขอ: ${e(p.created_by_name || p.created_by)}<br>สถานะ: ${e(STATUS[p.status] || p.status)}</p>
      <p><a href="${e(appUrl())}" style="background:#1B2064;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">เปิดระบบ (เมนู พัฒนาสินค้าใหม่ NPD)</a></p></div>`;
    return sendMail({ to: to.join(','), subject, html, text: `${subject}\n${appUrl()}` });
  }

  // เปิดรอบใหม่จากโปรเจกต์เดิม (⑨ ปรับสูตร / ⑬ เริ่มตัวอย่างใหม่) — ร่างใหม่ของ Sales เจ้าของเดิม คัดลอกคำขอเดิม
  function newRound(p, u) {
    const id = genId('NPD');
    const round = db.prepare('SELECT MAX(round) AS r FROM npd_projects WHERE id = ? OR root_id = ?').get(p.root_id || p.id, p.root_id || p.id).r + 1;
    db.prepare(`INSERT INTO npd_projects (id, status, round, root_id, prev_id, cust_code, cust_name, header_json, items_json, created_by, created_by_name, updated_by)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, round, p.root_id || p.id, p.id, p.cust_code, p.cust_name, p.header_json, p.items_json, p.created_by, p.created_by_name, u.uid);
    log({ id }, 'new_round', null, 'draft', `ต่อจาก ${p.doc_no || p.id} (รอบที่ ${p.round})`, u);
    return id;
  }

  // ── ตารางการกระทำ: from = สถานะที่กดได้ · who = คีย์ผู้รับผิดชอบ · run คืน { to, extra, detail, notify:[[keys, ข้อความ]] }
  const reason = b => { const r = txt(b?.reason, 500); if (!r) throw httpErr(400, 'กรุณาระบุเหตุผล'); return r; };
  const needAtt = (p, kind, label) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM npd_attachments WHERE project_id = ? AND kind = ? AND created_at >= ?').get(p.id, kind, p.status_at).n;
    if (!n) throw httpErr(400, `กรุณาแนบ${label}ก่อน`);
    return n;
  };
  const back = (label) => ({ from: null, who: null, run: (p, b) => {
    const r = reason(b);
    return { to: 'returned', extra: { return_reason: r, returned_from: p.status }, detail: `${label} ไม่ผ่าน · ${r}`, notify: [[['owner'], `${label} ไม่ผ่าน ส่งกลับให้แก้ไข: ${r}`]] };
  } });
  const ACTIONS = {
    submit: { from: EDITABLE, who: ['owner'], run: (p, b, u) => {
      const shaped = shape(p, u);
      const { issues } = buildRequest(db, { cust_code: p.cust_code, cust_name: p.cust_name, header: shaped.header, items: shaped.items });
      if (issues.length) throw httpErr(400, `ยังส่งไม่ได้ ต้องแก้ ${issues.length} จุด: ${issues.slice(0, 4).join(' · ')}`);
      const head = txt(b?.head_uid, 60) || p.head_uid;
      const hu = head ? db.prepare('SELECT uid, role FROM sc_users WHERE uid = ? AND is_active = 1').get(head) : null;
      if (!hu || !HEAD_ROLES.includes(hu.role)) throw httpErr(400, 'กรุณาเลือกหัวหน้าผู้อนุมัติ');
      if (hu.uid === p.created_by) throw httpErr(400, 'ผู้ขอเป็นผู้อนุมัติเองไม่ได้');
      const extra = { head_uid: hu.uid, submitted_at: nowIso(), return_reason: null, returned_from: null };
      if (!p.doc_no) extra.doc_no = nextDocNo(db, 'npd_projects', 'doc_no', 'NP');
      return { to: 'pending_head', extra, detail: p.status === 'returned' ? 'ส่งใหม่หลังแก้ไข' : 'ส่งขออนุมัติ', notify: [[['head'], 'มีคำขอตัวอย่างสินค้าใหม่รอคุณอนุมัติ']] };
    } },
    recall: { from: ['pending_head'], who: ['owner'], run: () => ({ to: 'draft', detail: 'เรียกคืน' }) },
    head_approve: { from: ['pending_head'], who: ['head'], run: (p, b) => ({ to: 'pending_paper', detail: txt(b?.comment, 500) || null,
      notify: [[['lin'], 'หัวหน้าอนุมัติแล้ว — พิมพ์คำขอให้คุณอ้อยเซ็น แล้วสแกนแนบในระบบ']] }) },
    head_return: { from: ['pending_head'], who: ['head'], run: back('หัวหน้า').run },
    paper_pass: { from: ['pending_paper'], who: ['lin'], run: (p, b) => {
      const n = needAtt(p, 'scan_paper', 'สแกนเอกสารที่คุณอ้อยเซ็นแล้ว');
      return { to: 'pending_o', detail: `คุณอ้อยอนุมัติ (แนบสแกน ${n} ไฟล์)${txt(b?.comment, 500) ? ' · ' + txt(b.comment, 500) : ''}`, notify: [[['o'], 'คุณอ้อยอนุมัติแล้ว รอคุณโออนุมัติ']] };
    } },
    paper_return: { from: ['pending_paper'], who: ['lin'], run: back('คุณอ้อย').run },
    o_approve: { from: ['pending_o'], who: ['o'], run: (p, b) => ({ to: 'rd_queue', detail: txt(b?.comment, 500) || null,
      notify: [[['rd'], 'คำขอตัวอย่างสินค้าใหม่อนุมัติครบแล้ว — รอ RD รับเรื่อง'], [['owner'], 'คำขออนุมัติครบแล้ว ส่งต่อ RD แล้ว']] }) },
    o_return: { from: ['pending_o'], who: ['o'], run: back('คุณโอ').run },
    rd_accept: { from: ['rd_queue'], who: ['rd'], run: () => ({ to: 'rd_dev', detail: 'RD รับเรื่อง', notify: [[['owner'], 'RD รับเรื่องและเริ่มพัฒนาตัวอย่างแล้ว']] }) },
    rd_send: { from: ['rd_dev'], who: ['rd'], run: (p, b) => ({ to: 'sample_sent', detail: txt(b?.note, 500) || null,
      notify: [[['owner'], 'RD ส่งสินค้าตัวอย่างแล้ว — กด "ได้รับตัวอย่าง" เมื่อได้รับของ']] }) },
    sales_receive: { from: ['sample_sent'], who: ['owner'], run: () => ({ to: 'sample_received', detail: 'ได้รับตัวอย่างจาก RD' }) },
    to_customer: { from: ['sample_received'], who: ['owner'], run: (p, b) => {
      const d = isDate(b?.date) ? b.date : nowIso().slice(0, 10);
      return { to: 'at_customer', extra: { test_json: JSON.stringify({ sent_date: d }) }, detail: `ส่งให้ลูกค้าทดสอบ ${d}` };
    } },
    feedback: { from: ['at_customer'], who: ['owner'], run: (p, b, u) => {
      const decision = ['pass', 'revise', 'cancel'].includes(b?.decision) ? b.decision : null;
      if (!decision) throw httpErr(400, 'กรุณาเลือกผลการทดสอบ');
      const fb = { ...parseJson(p.test_json, {}), date: isDate(b?.date) ? b.date : nowIso().slice(0, 10), decision, result: txt(b?.result, 20),
        sampleCode: txt(b?.sampleCode, 60), satisfaction: txt(b?.satisfaction, 20), failReason: txt(b?.failReason, 60), feedback: longTxt(b?.feedback, 2000) };
      if (decision !== 'pass' && !fb.feedback) throw httpErr(400, 'กรุณากรอกความเห็นลูกค้า/เหตุผล');
      const extra = { test_json: JSON.stringify(fb) };
      if (decision === 'pass') return { to: 'first_lot', extra, detail: 'ลูกค้าทดสอบผ่าน' };
      if (decision === 'cancel') return { to: 'cancelled', extra: { ...extra, cancel_reason: fb.feedback, cancelled_at: nowIso() }, detail: `ยกเลิกโปรเจกต์ · ${fb.feedback}` };
      const nid = newRound(p, u);
      return { to: 'revised', extra, detail: `ไม่ผ่าน ปรับสูตร → เปิดรอบใหม่ ${nid} · ${fb.feedback}`, new_id: nid };
    } },
    first_lot: { from: ['first_lot'], who: ['owner'], run: (p, b) => {
      const kg = pos(b?.kg);
      if (kg < MIN_FIRST_LOT_KG) throw httpErr(400, `จำนวนผลิต lot แรกต้องไม่น้อยกว่า ${MIN_FIRST_LOT_KG} กก.`);
      const forecast = (Array.isArray(b?.forecast) ? b.forecast : []).slice(0, 24).map(f => ({ month: isMonth(f?.month) ? f.month : '', kg: pos(f?.kg) })).filter(f => f.month && f.kg);
      if (!forecast.length) throw httpErr(400, 'กรุณากรอก forecast ยอดขายอย่างน้อย 1 เดือน');
      const fl = { kg, date: isDate(b?.date) ? b.date : '', forecast, note: longTxt(b?.note, 1000) };
      return { to: 'spec_cost', extra: { first_lot_json: JSON.stringify(fl), flags_json: '{}' }, detail: `lot แรก ${kg} กก. · forecast ${forecast.length} เดือน`,
        notify: [[['rd'], 'Sales แจ้ง lot แรก/forecast แล้ว — รอ RD ทำ spec และทุนเบื้องต้น']] };
    } },
    // ⑪ งานคู่ขนาน — ไม่เปลี่ยนสถานะจนกว่าทั้ง spec + ทุนบัญชีครบ (advanceSpecCost)
    rd_spec: { from: ['spec_cost'], who: ['rd'], run: (p, b, u) => {
      const n = needAtt(p, 'rd_spec', 'ไฟล์ Spec');
      const f = { ...parseJson(p.flags_json, {}), spec_at: nowIso(), spec_by: u.uid };
      return { flags: f, detail: `ส่ง Spec (แนบ ${n} ไฟล์)`, notify: [[['lin', 'o'], 'RD ส่ง Spec สินค้าใหม่แล้ว']] };
    } },
    rd_cost: { from: ['spec_cost'], who: ['rd'], run: (p, b, u) => {
      const amt = pos(b?.amount);
      if (!amt) throw httpErr(400, 'กรุณากรอกทุนเบื้องต้น (บาท/กก.)');
      const cost = { ...parseJson(p.cost_json, {}), rd: { amount: amt, note: longTxt(b?.note, 1000), by: u.uid, at: nowIso() } };
      const f = { ...parseJson(p.flags_json, {}), rd_cost_at: nowIso() };
      return { flags: f, extra: { cost_json: JSON.stringify(cost) }, detail: 'ส่งทุนเบื้องต้นให้บัญชีต้นทุน', notify: [[['cost_acct'], 'RD ส่งทุนเบื้องต้นแล้ว — รอบัญชีต้นทุนคำนวณ']] };
    } },
    acct_cost: { from: ['spec_cost'], who: ['cost_acct'], run: (p, b, u) => {
      const f0 = parseJson(p.flags_json, {});
      if (!f0.rd_cost_at) throw httpErr(400, 'RD ยังไม่ได้ส่งทุนเบื้องต้น');
      const amt = pos(b?.amount);
      if (!amt) throw httpErr(400, 'กรุณากรอกทุนที่คำนวณ (บาท/กก.)');
      const cost = { ...parseJson(p.cost_json, {}), acct: { amount: amt, note: longTxt(b?.note, 1000), by: u.uid, at: nowIso() } };
      return { flags: { ...f0, acct_cost_at: nowIso() }, extra: { cost_json: JSON.stringify(cost) }, detail: 'บัญชีต้นทุนบันทึกทุนแล้ว', notify: [[['o'], 'บัญชีต้นทุนคำนวณทุนสินค้าใหม่แล้ว']] };
    } },
    price_propose: { from: ['price_quote'], who: ['owner'], run: (p, b, u) => {
      const price = pos(b?.price);
      if (!price) throw httpErr(400, 'กรุณากรอกราคาขายที่เสนอ (บาท/กก.)');
      const pr = parseJson(p.price_json, {}) || {};
      const hist = [...(pr.history || []), { price, note: longTxt(b?.note, 1000), by: u.uid, at: nowIso() }];
      return { to: 'price_review', extra: { price_json: JSON.stringify({ ...pr, proposed: price, note: longTxt(b?.note, 1000), history: hist }) },
        detail: `เสนอราคา ${price} บาท/กก.`, notify: [[['o'], 'Sales เสนอราคาขายสินค้าใหม่ รอคุณโอพิจารณา']] };
    } },
    price_decide: { from: ['price_review'], who: ['o'], run: (p, b, u) => {
      const d = b?.decision;
      const pr = parseJson(p.price_json, {}) || {};
      if (d === 'approve') {
        return { to: 'sku_setup', extra: { price_json: JSON.stringify({ ...pr, approved: pr.proposed, approved_by: u.uid, approved_at: nowIso() }) },
          detail: `อนุมัติราคา ${pr.proposed} บาท/กก.`, notify: [[['factory_acct'], 'คุณโออนุมัติราคาแล้ว — เปิดรหัสสินค้าและเปิดขาย'], [['owner'], 'คุณโออนุมัติราคาขายแล้ว']] };
      }
      const r = reason(b);
      if (d === 'renegotiate') return { to: 'price_quote', detail: `ไม่ผ่าน คุยราคาใหม่ · ${r}`, notify: [[['owner'], `คุณโอให้เสนอราคาใหม่: ${r}`]] };
      if (d === 'respec') return { to: 'spec_cost', extra: { flags_json: '{}' }, detail: `ไม่ผ่าน ปรับ spec/ทุน · ${r}`, notify: [[['rd'], `คุณโอให้ปรับ spec/ทุน: ${r}`], [['owner'], `คุณโอให้ RD ปรับ spec/ทุน: ${r}`]] };
      if (d === 'cancel') return { to: 'cancelled', extra: { cancel_reason: r, cancelled_at: nowIso() }, detail: `ยกเลิกโปรเจกต์ · ${r}`, notify: [[['owner'], `คุณโอยกเลิกโปรเจกต์: ${r}`]] };
      if (d === 'new_round') {
        const nid = newRound(p, u);
        return { to: 'revised', detail: `ไม่ผ่าน เริ่มตัวอย่างรอบใหม่ ${nid} · ${r}`, new_id: nid, notify: [[['owner'], `คุณโอให้เริ่มขอตัวอย่างรอบใหม่: ${r}`]] };
      }
      throw httpErr(400, 'กรุณาเลือกผลการพิจารณา');
    } },
    sku_open: { from: ['sku_setup'], who: ['factory_acct'], run: (p, b) => {
      const code = txt(b?.sku_code, 40);
      if (!code) throw httpErr(400, 'กรุณากรอกรหัสสินค้าที่เปิดในระบบ');
      const prod = db.prepare('SELECT name FROM products WHERE code = ?').get(code);
      // รหัสใหม่อาจยังไม่ sync จาก Express (รอบ 5 นาที) — ยอมให้บันทึก ใช้ชื่อที่กรอกแทน
      return { to: 'launched', extra: { sku_code: code, sku_name: prod ? prod.name : txt(b?.sku_name, 200), launched_at: nowIso() }, detail: `เปิดรหัส ${code}`,
        notify: [[['owner', 'o', 'lin'], `เปิดขายสินค้าใหม่แล้ว รหัส ${code}`]] };
    } },
    cancel: { from: null, who: ['owner'], run: (p, b) => {
      const r = reason(b);
      return { to: 'cancelled', extra: { cancel_reason: r, cancelled_at: nowIso() }, detail: `ยกเลิกโปรเจกต์ · ${r}` };
    } },
  };

  router.get('/meta', (req, res) => send(res, () => {
    const s = settings();
    return {
      status: STATUS, att_kinds: ATT_KINDS, setting_keys: SETTING_KEYS, min_first_lot_kg: MIN_FIRST_LOT_KG,
      can_create: CREATE_ROLES.includes(req.user.role), is_admin: isAdmin(req.user), can_see_cost: canSeeCost(req.user),
      my_keys: Object.keys(SETTING_KEYS).filter(k => (s[k] || []).includes(req.user.uid)), settings: s,
      heads: db.prepare(`SELECT uid, name, role FROM sc_users WHERE is_active = 1 AND role IN (${HEAD_ROLES.map(() => '?').join(',')}) ORDER BY name`).all(...HEAD_ROLES),
      users: isAdmin(req.user) ? db.prepare('SELECT uid, name, role FROM sc_users WHERE is_active = 1 ORDER BY name').all() : undefined,
    };
  }));

  router.put('/settings', (req, res) => send(res, () => tx(db, () => {
    if (!isAdmin(req.user)) throw httpErr(403, 'เฉพาะแอดมิน');
    const getU = db.prepare('SELECT uid FROM sc_users WHERE uid = ? AND is_active = 1');
    const up = db.prepare("INSERT INTO npd_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at");
    for (const k of Object.keys(SETTING_KEYS)) {
      if (!Array.isArray(req.body?.[k])) continue;
      const uids = [...new Set(req.body[k].map(String))].filter(u => getU.get(u)).slice(0, 20);
      up.run(k, JSON.stringify(uids), req.user.uid);
    }
    return settings();
  })));

  router.get('/', (req, res) => send(res, () => {
    const all = canSeeAll(req.user);
    const rows = db.prepare(`SELECT * FROM npd_projects ${all ? '' : 'WHERE created_by = ? OR head_uid = ?'} ORDER BY created_at DESC LIMIT 2000`).all(...(all ? [] : [req.user.uid, req.user.uid]));
    return rows.map(r => {
      const p = shape(r, req.user);
      const actors = nextActors(p);
      return { id: p.id, doc_no: p.doc_no, legacy_no: p.legacy_no, status: p.status, status_label: p.status_label, round: p.round, root_id: p.root_id,
        cust_code: p.cust_code, cust_name: p.cust_name, items: p.items.map(it => it.name).filter(Boolean), created_by: p.created_by, created_by_name: p.created_by_name,
        created_at: p.created_at, status_at: p.status_at, sku_code: p.sku_code, next_actors: actors,
        awaiting_me: !CLOSED.includes(p.status) && actors.some(a => a.uids.includes(req.user.uid)) };
    });
  }));

  router.get('/:id', (req, res) => send(res, () => { load(req.params.id, req.user); return full(req.params.id, req.user); }));

  router.post('/', (req, res) => send(res, () => tx(db, () => {
    if (!CREATE_ROLES.includes(req.user.role)) throw httpErr(403, 'ไม่มีสิทธิ์สร้างคำขอสินค้าใหม่');
    const b = buildRequest(db, req.body);
    const id = genId('NPD');
    db.prepare(`INSERT INTO npd_projects (id, status, cust_code, cust_name, header_json, items_json, created_by, created_by_name, updated_by)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`).run(id, b.cust_code, b.cust_name, JSON.stringify(b.header), JSON.stringify(b.items), req.user.uid, req.user.name || req.user.uid, req.user.uid);
    log({ id }, 'create', null, 'draft', null, req.user);
    return full(id, req.user);
  })));

  router.put('/:id', (req, res) => send(res, () => tx(db, () => {
    const p = load(req.params.id, req.user);
    if (!EDITABLE.includes(p.status)) throw httpErr(400, 'แก้ไขได้เฉพาะร่าง หรือคำขอที่ถูกส่งกลับ');
    if (p.created_by !== req.user.uid && !isAdmin(req.user)) throw httpErr(403, 'แก้ไขได้เฉพาะผู้ขอ');
    const b = buildRequest(db, req.body);
    db.prepare('UPDATE npd_projects SET cust_code = ?, cust_name = ?, header_json = ?, items_json = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(b.cust_code, b.cust_name, JSON.stringify(b.header), JSON.stringify(b.items), req.user.uid, nowIso(), p.id);
    log(p, 'update', p.status, p.status, null, req.user);
    return full(p.id, req.user);
  })));

  // ลบได้เฉพาะร่างที่ยังไม่เคยออกเลข (ไม่ใช่รอบต่อ — รอบต่อให้ยกเลิกแทน ประวัติ chain จะได้ไม่ขาด)
  router.delete('/:id', (req, res) => send(res, () => tx(db, () => {
    const p = load(req.params.id, req.user);
    if (p.status !== 'draft' || p.doc_no || p.prev_id) throw httpErr(400, 'ลบได้เฉพาะร่างที่ยังไม่เคยส่ง — กรณีอื่นใช้ "ยกเลิก"');
    if (p.created_by !== req.user.uid && !isAdmin(req.user)) throw httpErr(403, 'ลบได้เฉพาะผู้ขอ');
    db.prepare('DELETE FROM npd_attachments WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM npd_logs WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM npd_projects WHERE id = ?').run(p.id);
    return { ok: true };
  })));

  router.post('/:id/act/:action', (req, res) => {
    const act = ACTIONS[req.params.action];
    if (!act) return res.status(400).json({ error: 'ไม่รู้จักการกระทำนี้' });
    let out, notify = [], id;
    try {
      out = tx(db, () => {
        const p = load(req.params.id, req.user);
        id = p.id;
        const from = act.from || Object.keys(STATUS).filter(s => !CLOSED.includes(s));
        if (!from.includes(p.status)) throw httpErr(400, `ทำรายการนี้ไม่ได้ในสถานะ "${STATUS[p.status] || p.status}"`);
        if (!can(p, req.user, act.who)) throw httpErr(403, 'คุณไม่ใช่ผู้รับผิดชอบขั้นนี้');
        const r = act.run(p, req.body || {}, req.user) || {};
        const self = act.who.some(k => uidsFor(p, k).includes(req.user.uid));
        const detail = [r.detail, self ? null : '(แอดมินทำแทน)'].filter(Boolean).join(' ') || null;
        if (r.flags) {
          // ⑪/⑫ ครบทั้ง spec และทุนบัญชี → ไปขั้นเสนอราคา
          const done = r.flags.spec_at && r.flags.acct_cost_at;
          r.extra = { ...(r.extra || {}), flags_json: JSON.stringify(r.flags) };
          if (done) { r.to = 'price_quote'; (r.notify = r.notify || []).push([['owner'], 'Spec และทุนพร้อมแล้ว — เสนอราคาขายให้คุณโอ']); }
        }
        if (r.to) setStatus(p, r.to, req.user, r.extra || {});
        else if (r.extra) {
          const cols = Object.keys(r.extra);
          db.prepare(`UPDATE npd_projects SET updated_by = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')} WHERE id = ?`).run(req.user.uid, nowIso(), ...cols.map(c => r.extra[c]), p.id);
        }
        log(p, req.params.action, p.status, r.to || p.status, detail, req.user);
        notify = r.notify || [];
        const f = full(p.id, req.user);
        if (r.new_id) f.new_id = r.new_id;
        return f;
      });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    res.json(out);
    for (const [keys, what] of notify) mailKeys(id, keys, what).catch(x => console.warn('[npdMail]', x.message));
  });

  // ── ไฟล์แนบ: สแกนเอกสาร (พี่หลิน) · เอกสาร/Spec RD · เอกสารลูกค้า (Sales) ──
  const ATT_WHO = { scan_paper: ['lin'], rd_doc: ['rd'], rd_spec: ['rd'], customer: ['owner'], other: ['owner', 'head', 'lin', 'o', 'rd', 'cost_acct', 'factory_acct'] };
  router.post('/:id/attachments', (req, res) => upload(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกินไป (จำกัด 15MB ต่อไฟล์)' : `อัปโหลดไม่สำเร็จ: ${err.message}` });
    send(res, () => {
      const p = load(req.params.id, req.user);
      if (CLOSED.includes(p.status)) throw httpErr(400, 'โปรเจกต์ปิดแล้ว แนบไฟล์ไม่ได้');
      const kind = ATT_KINDS[req.body?.kind] ? req.body.kind : 'other';
      if (!can(p, req.user, ATT_WHO[kind])) throw httpErr(403, `ไม่มีสิทธิ์แนบ${ATT_KINDS[kind]}`);
      const f = req.file;
      if (!f) throw httpErr(400, 'ไม่พบไฟล์');
      if (!attTypes.has(f.mimetype)) throw httpErr(400, 'รองรับ PDF, รูปภาพ, Excel, Word');
      if (!sniffOk(f.buffer, f.mimetype)) throw httpErr(400, 'เนื้อไฟล์ไม่ตรงกับชนิดไฟล์ที่แนบ');
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      db.prepare('INSERT INTO npd_attachments (id, project_id, kind, label, filename, mime_type, content, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(genId('NPA'), p.id, kind, txt(req.body?.label, 160) || ATT_KINDS[kind], name, f.mimetype, f.buffer, req.user.uid, nowIso());
      log(p, 'attach', p.status, p.status, `${ATT_KINDS[kind]}: ${name}`, req.user);
      return full(p.id, req.user).attachments;
    });
  }));
  router.delete('/:id/attachments/:aid', (req, res) => send(res, () => {
    const p = load(req.params.id, req.user);
    if (CLOSED.includes(p.status)) throw httpErr(400, 'โปรเจกต์ปิดแล้ว ลบไฟล์ไม่ได้');
    const a = db.prepare('SELECT id, filename, uploaded_by, created_at FROM npd_attachments WHERE id = ? AND project_id = ?').get(req.params.aid, p.id);
    if (!a) throw httpErr(404, 'ไม่พบไฟล์');
    if (a.uploaded_by !== req.user.uid && !isAdmin(req.user)) throw httpErr(403, 'ลบได้เฉพาะผู้แนบ');
    // ไฟล์ที่ใช้ยืนยันขั้นที่ผ่านไปแล้ว (แนบก่อนเปลี่ยนสถานะล่าสุด) ลบไม่ได้ — เป็นหลักฐานการอนุมัติ
    if (a.created_at < p.status_at && !isAdmin(req.user)) throw httpErr(400, 'ไฟล์นี้เป็นหลักฐานของขั้นที่ผ่านไปแล้ว ลบไม่ได้');
    db.prepare('DELETE FROM npd_attachments WHERE id = ?').run(a.id);
    log(p, 'detach', p.status, p.status, a.filename, req.user);
    return full(p.id, req.user).attachments;
  }));
  router.get('/:id/attachments/:aid/content', (req, res) => {
    try {
      const p = load(req.params.id, req.user);
      const row = db.prepare('SELECT filename, mime_type, content FROM npd_attachments WHERE id = ? AND project_id = ?').get(req.params.aid, p.id);
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
module.exports.STATUS = STATUS;
module.exports.awaitingFor = awaitingFor;
module.exports.buildRequest = buildRequest;
