const crypto = require('crypto');
const { sendMail, COMPANY, escapeHtml } = require('./mailer');

// แจ้งอนุมัติใบเคาะราคาทางอีเมล (2026-09-23, แบบเดียวกับ e-memo):
// - เอกสารเข้าขั้นอนุมัติใหม่ (ส่งอนุมัติ / ผ่านขั้นก่อนหน้า / escalate ผู้บริหาร) → ส่งอีเมลถึงผู้อนุมัติของขั้นนั้น
//   ทุกคนที่ยังรอตัดสินใจและมีอีเมล พร้อมลิงก์ส่วนตัว (token) สำหรับ "อนุมัติ" / "ไม่อนุมัติ" จากอีเมล
//   และลิงก์ "เปิดในระบบ" (?draft=<draft_no>)
// - อนุมัติครบ / ไม่อนุมัติ → แจ้งผู้จัดทำ
// ลิงก์ในอีเมลเปิดหน้ายืนยันก่อนเสมอ (GET ไม่เปลี่ยนสถานะ — กันระบบสแกนลิงก์ของอีเมลกดแทน) ดู routes/promoEmailApprove.js

const e = v => escapeHtml(v == null ? '' : String(v));
const appUrl = () => (process.env.APP_PUBLIC_URL || 'https://tss-supplychain.vercel.app').replace(/\/+$/, '');
const parse = v => { if (typeof v !== 'string') return v || []; try { return JSON.parse(v); } catch { return []; } };
const fmtD = d => d ? new Date(d).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmt2 = v => v == null || v === '' ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ข้อมูลสรุปเอกสารสำหรับใส่ในอีเมล/หน้ายืนยัน (header + บรรทัดสินค้าไม่ซ้ำ SKU + กลุ่มลูกค้า)
function docSummary(db, header) {
  const lines = db.prepare('SELECT * FROM promo_drafts WHERE draft_no = ? ORDER BY created_at').all(header.draft_no);
  const bySku = new Map();
  lines.forEach(l => { if (!bySku.has(l.sku)) bySku.set(l.sku, l); });
  const branches = new Set(lines.map(l => l.cust_code));
  const corps = new Map();
  lines.forEach(l => { if (!corps.has(l.cust_code)) corps.set(l.cust_code, (l.corporate || '').trim() || 'ไม่ระบุกลุ่ม'); });
  const corpCount = new Map();
  corps.forEach(c => corpCount.set(c, (corpCount.get(c) || 0) + 1));
  const creator = db.prepare('SELECT name FROM sc_users WHERE uid = ?').get(header.created_by)?.name || header.created_by || '—';
  return {
    items: [...bySku.values()],
    branchCount: branches.size,
    corps: [...corpCount.entries()].sort((a, b) => b[1] - a[1]),
    creator,
  };
}

function itemsTableHtml(items) {
  const shown = items.slice(0, 15);
  const th = 'style="background:#1E3A5F;color:#fff;padding:6px 8px;font-size:12px;text-align:center"';
  const td = 'style="border-bottom:1px solid #E5E7EB;padding:6px 8px;font-size:12px;text-align:center"';
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 4px">
    <thead><tr><th ${th}>รหัสสินค้า</th><th ${th}>ชื่อสินค้า</th><th ${th}>ราคาปกติ</th><th ${th}>Compensate</th><th ${th}>ราคาโปร</th><th ${th}>ประมาณการ</th></tr></thead>
    <tbody>${shown.map(l => `<tr>
      <td ${td}>${e(l.sku)}</td><td ${td.replace('text-align:center', 'text-align:left')}>${e(l.sku_name)}</td>
      <td ${td}>${fmt2(l.normal_price)}</td><td ${td}>${fmt2(l.compensate)}</td><td ${td}><b>${fmt2(l.unit_price)}</b></td>
      <td ${td}>${l.estimated_qty != null ? Number(l.estimated_qty).toLocaleString('th-TH') : '—'}</td></tr>`).join('')}</tbody>
  </table>${items.length > shown.length ? `<div style="font-size:11px;color:#6B7280">...และอีก ${items.length - shown.length} รายการ (ดูทั้งหมดในระบบ)</div>` : ''}`;
}

function shell(inner) {
  return `<div style="font-family:'Noto Sans Thai',Sarabun,Arial,sans-serif;max-width:680px;margin:0 auto;background:#fff;">
  <div style="background:#1E3A5F;padding:18px 26px;border-radius:8px 8px 0 0;">
    <div style="font-size:16px;font-weight:700;color:#fff;">${COMPANY}</div>
    <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:2px;">TSS Supply Chain · ใบเคาะราคา</div>
  </div>
  <div style="border:1px solid #E5E7EB;border-top:3px solid #D4AF37;padding:24px 26px;border-radius:0 0 8px 8px;">
    ${inner}
    <div style="border-top:1px solid #F3F4F6;margin-top:22px;padding-top:12px;font-size:10px;color:#9CA3AF;text-align:center;">
      อีเมลนี้ส่งอัตโนมัติจากระบบ TSS Supply Chain — กรุณาอย่าตอบกลับ
    </div>
  </div>
</div>`;
}

function summaryBlockHtml(header, sum, stepLabel) {
  const row = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#6B7280;font-size:13px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0;font-size:13px;color:#111">${v}</td></tr>`;
  const itemType = parse(header.item_type);
  return `<table style="border-collapse:collapse;margin:6px 0 10px">
    ${row('เลขที่เอกสาร', `<b style="font-family:monospace">${e(header.doc_no || header.draft_no)}</b>`)}
    ${row('ชื่อรายการ', `<b>${e(header.promo_name || '—')}</b>`)}
    ${row('ผู้จัดทำ', e(sum.creator))}
    ${row('ลูกค้า', `${sum.corps.map(([c, n]) => `${e(c)} (${n} สาขา)`).join(', ') || '—'}`)}
    ${row('ช่วงโปร', `${fmtD(header.start_date)} – ${fmtD(header.due_date)}`)}
    ${row('เงื่อนไข / ลักษณะ', `${e(header.condition_type || '—')}${Array.isArray(itemType) && itemType.length ? ' · ' + e(itemType.join(', ')) : ''}`)}
    ${header.purpose ? row('วัตถุประสงค์', e(header.purpose)) : ''}
    ${stepLabel ? row('ขั้นอนุมัติ', `<b style="color:#1E3A5F">${e(stepLabel)}</b>`) : ''}
  </table>`;
}

// ความเห็นของผู้อนุมัติขั้นก่อนหน้า (ประวัติ + ขั้นปัจจุบันที่มีคนตัดสินใจแล้ว) — ให้ขั้นถัดไปเห็นในอีเมล/หน้ายืนยัน
function prevCommentsHtml(header) {
  const levels = [...parse(header.approval_history_json), ...parse(header.levels_json)];
  const rows = levels.flatMap((lv, i) => (lv.approvers || []).filter(a => a.ts && (a.status === 'approved' || a.status === 'rejected'))
    .map(a => ({ step: `ขั้นที่ ${i + 1}${lv.label ? ' · ' + lv.label : ''}`, name: a.name || a.uid, ok: a.status === 'approved', ts: a.ts, comment: a.comment || '' })));
  if (!rows.length) return '';
  return `<div style="margin:10px 0 4px"><div style="font-size:13px;font-weight:700;color:#1E3A5F;margin-bottom:4px">ความเห็นจากขั้นก่อนหน้า</div>
    ${rows.map(r => `<div style="border-left:3px solid ${r.ok ? '#0A5940' : '#A32D2D'};background:#F7F9FC;padding:6px 10px;margin-bottom:4px;font-size:12.5px">
      <b>${e(r.name)}</b> <span style="color:#6B7280">· ${e(r.step)} · ${r.ok ? 'อนุมัติ' : 'ไม่อนุมัติ'} · ${new Date(r.ts).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })} น.</span>
      ${r.comment ? `<div style="margin-top:2px">💬 ${e(r.comment)}</div>` : ''}</div>`).join('')}</div>`;
}

function renderApprovalRequestEmail({ header, sum, approverName, stepLabel, approveUrl, rejectUrl, openUrl }) {
  const btn = (href, bg, color, label) => `<a href="${e(href)}" style="background:${bg};color:${color};padding:11px 22px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;margin:4px 6px">${label}</a>`;
  const subject = `[รออนุมัติ] ใบเคาะราคา ${header.doc_no || header.draft_no} — ${header.promo_name || ''}`.trim();
  const html = shell(`
    <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#111">เรียน คุณ${e(approverName)}<br/>
      มีใบเคาะราคารอการอนุมัติจากท่าน</p>
    ${summaryBlockHtml(header, sum, stepLabel)}
    ${itemsTableHtml(sum.items)}
    ${prevCommentsHtml(header)}
    <div style="text-align:center;margin:22px 0 8px">
      ${btn(approveUrl, '#0A5940', '#fff', '✅ อนุมัติ')}
      ${btn(rejectUrl, '#A32D2D', '#fff', '❌ ไม่อนุมัติ')}
      ${btn(openUrl, '#D4AF37', '#111', '🔎 เปิดดูในระบบ')}
    </div>
    <p style="margin:6px 0 0;font-size:11.5px;color:#6B7280;line-height:1.7;text-align:center">
      กด "อนุมัติ" หรือ "ไม่อนุมัติ" จะเปิดหน้ายืนยันให้ใส่ความเห็นก่อนบันทึก · หรือกด "เปิดดูในระบบ" เพื่อดูรายละเอียดทั้งหมดและอนุมัติในระบบ
    </p>`);
  const text = `เรียน คุณ${approverName}\nมีใบเคาะราคารอการอนุมัติ: ${header.doc_no || header.draft_no} ${header.promo_name || ''}\nขั้น: ${stepLabel}\n\nอนุมัติ: ${approveUrl}\nไม่อนุมัติ: ${rejectUrl}\nเปิดในระบบ: ${openUrl}`;
  return { subject, html, text };
}

function renderResultEmail({ header, sum, outcome, byName, comment, openUrl }) {
  const ok = outcome === 'approved';
  const subject = `[${ok ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ'}] ใบเคาะราคา ${header.doc_no || header.draft_no} — ${header.promo_name || ''}`.trim();
  const html = shell(`
    <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#111">เรียน คุณ${e(sum.creator)}<br/>
      ใบเคาะราคาของท่าน <b style="color:${ok ? '#0A5940' : '#A32D2D'}">${ok ? 'ได้รับการอนุมัติครบทุกขั้นแล้ว' : 'ไม่ได้รับการอนุมัติ'}</b>${byName ? ` โดย ${e(byName)}` : ''}</p>
    ${comment ? `<div style="background:#F7F9FC;border:1px solid #E5E7EB;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:8px"><b>ความเห็น:</b> ${e(comment)}</div>` : ''}
    ${summaryBlockHtml(header, sum, '')}
    ${ok && header.promo_no ? `<p style="font-size:13px;margin:4px 0">เลขที่ใบโปรโมชั่น: <b style="font-family:monospace">${e(header.promo_no)}</b> — คีย์เข้า Express แล้วกดปิดสถานะในระบบ</p>` : ''}
    <div style="text-align:center;margin:18px 0 4px">
      <a href="${e(openUrl)}" style="background:#D4AF37;color:#111;padding:11px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">🔎 เปิดดูในระบบ</a>
    </div>`);
  const text = `${subject}\n${comment ? 'ความเห็น: ' + comment + '\n' : ''}เปิดในระบบ: ${openUrl}`;
  return { subject, html, text };
}

function issueToken(db, draftNo, uid, status, levelIndex) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO promo_approval_tokens (token, draft_no, uid, status, level_index) VALUES (?, ?, ?, ?, ?)')
    .run(token, draftNo, uid, status, levelIndex);
  return token;
}

// แจ้งผู้อนุมัติของขั้นปัจจุบัน (ที่ยัง pending) — เรียกหลังเอกสารเข้าขั้นใหม่
async function notifyCurrentApprovers(db, header, baseUrl) {
  const levels = parse(header.levels_json);
  const idx = header.current_level || 0;
  const lv = levels[idx];
  if (!lv) return [];
  const sum = docSummary(db, header);
  const stepLabel = `${header.status === 'pending_exec_approval' ? 'ผู้บริหาร · ' : ''}ขั้นที่ ${idx + 1}${lv.label ? ' · ' + lv.label : ''}`;
  const results = [];
  for (const a of (lv.approvers || []).filter(x => x.status === 'pending')) {
    const u = db.prepare('SELECT name, email, is_active FROM sc_users WHERE uid = ?').get(a.uid);
    if (!u?.email || !u.is_active) { results.push({ uid: a.uid, sent: false, reason: 'NO_EMAIL' }); continue; }
    const token = issueToken(db, header.draft_no, a.uid, header.status, idx);
    const link = act => `${baseUrl}/api/promo_approve/${token}?action=${act}`;
    const mail = renderApprovalRequestEmail({ header, sum, approverName: u.name || a.name, stepLabel,
      approveUrl: link('approve'), rejectUrl: link('reject'), openUrl: `${appUrl()}/?draft=${encodeURIComponent(header.draft_no)}` });
    results.push({ uid: a.uid, ...(await sendMail({ to: u.email, ...mail })) });
  }
  return results;
}

async function notifyCreator(db, header, outcome, byUid, comment) {
  const creator = db.prepare('SELECT email FROM sc_users WHERE uid = ?').get(header.created_by);
  if (!creator?.email) return { sent: false, reason: 'NO_EMAIL' };
  const byName = byUid ? (db.prepare('SELECT name FROM sc_users WHERE uid = ?').get(byUid)?.name || byUid) : '';
  const mail = renderResultEmail({ header, sum: docSummary(db, header), outcome, byName, comment,
    openUrl: `${appUrl()}/?draft=${encodeURIComponent(header.draft_no)}` });
  return sendMail({ to: creator.email, ...mail });
}

// เรียกหลังบันทึกการเปลี่ยนแปลงหัวเอกสาร (PATCH ปกติ หรืออนุมัติผ่านอีเมล) — before/after เป็น row ที่ parse แล้ว
async function afterChange(db, before, after, baseUrl) {
  if (!after) return;
  const pending = ['pending_approval', 'pending_exec_approval'];
  const levelChanged = before.status !== after.status || (before.current_level || 0) !== (after.current_level || 0);
  if (pending.includes(after.status) && levelChanged) await notifyCurrentApprovers(db, after, baseUrl);
  if (before.status !== after.status && (after.status === 'approved' || after.status === 'rejected')) {
    const acted = [...parse(after.approval_history_json), ...parse(after.levels_json)].flatMap(l => l.approvers || [])
      .filter(a => a.ts).sort((x, y) => String(y.ts).localeCompare(String(x.ts)))[0];
    await notifyCreator(db, after, after.status, after.updated_by || acted?.uid, acted?.comment || '');
  }
}

module.exports = { afterChange, notifyCurrentApprovers, docSummary, renderApprovalRequestEmail, renderResultEmail, summaryBlockHtml, itemsTableHtml, prevCommentsHtml, shell, appUrl };
