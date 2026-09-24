const express = require('express');
const promoMail = require('../lib/promoApprovalMail');
const { applyHeaderChange, parseRow, publicBaseUrl } = require('./promoDraftHeaders');
const { escapeHtml } = require('../lib/mailer');

// อนุมัติใบเคาะราคาจากลิงก์ในอีเมล (2026-09-23, แบบ e-memo) — ไม่ต้อง login ใช้ token ส่วนตัวของผู้อนุมัติแทน
// GET  /api/promo_approve/:token?action=approve|reject  → หน้ายืนยัน (ไม่เปลี่ยนสถานะ กันระบบสแกนลิงก์กดแทน)
// POST /api/promo_approve/:token  (action, comment)     → บันทึกผลจริง ผ่าน applyHeaderChange/validateChange
//      ตัวเดียวกับการอนุมัติในระบบ (ลายเซ็น snapshot, ประวัติขั้น, escalate ผู้บริหาร, แจ้งอีเมลขั้นถัดไป)
// token ใช้ได้เฉพาะตอนเอกสารยังรออนุมัติ อยู่ขั้นเดียวกับที่ถูกแจ้ง และผู้อนุมัติยังไม่ได้ตัดสินใจ
const e = v => escapeHtml(v == null ? '' : String(v));

function page(title, inner) {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#EEF1F5;padding:18px 12px;font-family:'Noto Sans Thai',Sarabun,Arial,sans-serif}
textarea{width:100%;box-sizing:border-box;min-height:80px;border:1px solid #CDD5E0;border-radius:6px;padding:8px;font:inherit;font-size:14px}
button{border:0;border-radius:6px;padding:11px 26px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}</style></head>
<body>${inner}</body></html>`;
}

function loadState(db, token) {
  const t = db.prepare('SELECT * FROM promo_approval_tokens WHERE token = ?').get(token);
  if (!t) return { error: 'ลิงก์นี้ไม่ถูกต้องหรือถูกยกเลิกแล้ว' };
  const raw = db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no = ?').get(t.draft_no);
  if (!raw) return { error: 'ไม่พบเอกสารนี้แล้ว' };
  const header = parseRow({ ...raw });
  const user = db.prepare('SELECT uid, name, role, is_active FROM sc_users WHERE uid = ?').get(t.uid);
  const levels = Array.isArray(header.levels_json) ? header.levels_json : [];
  const me = (levels[header.current_level || 0]?.approvers || []).find(a => a.uid === t.uid);
  let closed = '';
  if (!user || !user.is_active) closed = 'บัญชีผู้อนุมัตินี้ถูกระงับแล้ว';
  else if (t.used_at) closed = 'ท่านได้บันทึกผลผ่านลิงก์นี้ไปแล้ว';
  else if (header.status !== t.status || (header.current_level || 0) !== t.level_index) closed = 'เอกสารนี้ผ่านขั้นที่ท่านได้รับแจ้งไปแล้ว';
  else if (!me || me.status !== 'pending') closed = 'ท่านได้ตัดสินใจในขั้นนี้ไปแล้ว';
  return { t, raw, header, user, closed };
}

const STATUS_TH = { draft: 'ร่าง', pending_approval: 'รออนุมัติ', pending_exec_approval: 'รอผู้บริหารอนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', keyed_to_express: 'คีย์เข้า Express แล้ว' };

module.exports = function promoEmailApproveRoutes(db) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '20kb' }));

  router.get('/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const st = loadState(db, req.params.token);
    if (st.error) return res.status(404).send(page('ลิงก์ไม่ถูกต้อง', promoMail.shell(`<p style="font-size:14px">${e(st.error)}</p>`)));
    const openUrl = `${promoMail.appUrl()}/?draft=${encodeURIComponent(st.header.draft_no)}`;
    const sum = promoMail.docSummary(db, st.header);
    if (st.closed) {
      return res.send(page('ใบเคาะราคา', promoMail.shell(`
        <p style="font-size:14px;margin:0 0 8px"><b>${e(st.closed)}</b><br/>สถานะเอกสารตอนนี้: <b>${e(STATUS_TH[st.header.status] || st.header.status)}</b></p>
        ${promoMail.summaryBlockHtml(st.header, sum, '')}
        <div style="text-align:center;margin-top:16px"><a href="${e(openUrl)}" style="background:#D4AF37;color:#111;padding:11px 24px;border-radius:6px;text-decoration:none;font-weight:700">🔎 เปิดดูในระบบ</a></div>`)));
    }
    const reject = req.query.action === 'reject';
    const levels = st.header.levels_json || [];
    const lv = levels[st.header.current_level || 0] || {};
    const step = `${st.header.status === 'pending_exec_approval' ? 'ผู้บริหาร · ' : ''}ขั้นที่ ${(st.header.current_level || 0) + 1}${lv.label ? ' · ' + lv.label : ''}`;
    res.send(page(reject ? 'ยืนยันไม่อนุมัติ' : 'ยืนยันอนุมัติ', promoMail.shell(`
      <p style="font-size:14px;margin:0 0 6px">คุณ${e(st.user.name)} — ยืนยันการ${reject ? '<b style="color:#A32D2D">ไม่อนุมัติ</b>' : '<b style="color:#0A5940">อนุมัติ</b>'}ใบเคาะราคานี้</p>
      ${promoMail.summaryBlockHtml(st.header, sum, step)}
      ${promoMail.itemsTableHtml(sum.items)}
      ${promoMail.prevCommentsHtml(st.header)}
      <form method="post" action="" style="margin-top:14px">
        <input type="hidden" name="action" value="${reject ? 'reject' : 'approve'}">
        ${!reject && lv.audit_verdict && sum.items.length ? `<div style="margin:0 0 10px;font-size:13px"><b>ผลตรวจสอบรายสินค้า (ต้องเลือกทุกรายการ)</b>
          <table style="width:100%;border-collapse:collapse;margin-top:4px">${sum.items.map((l, i) => `<tr>
            <td style="border-bottom:1px solid #E5E7EB;padding:5px 6px;font-size:12.5px"><input type="hidden" name="vsku_${i}" value="${e(l.sku)}"><b>${e(l.sku)}</b> ${e(l.sku_name || '')}</td>
            <td style="border-bottom:1px solid #E5E7EB;padding:5px 6px;white-space:nowrap;font-size:12.5px">
              <label style="margin-right:12px"><input type="radio" name="verdict_${i}" value="profit" required> ✅ ขายได้</label>
              <label><input type="radio" name="verdict_${i}" value="loss"> ⚠️ ขาดทุน</label></td></tr>`).join('')}</table></div>` : ''}
        <label style="font-size:13px;font-weight:600">ความเห็น ${reject ? '(ควรระบุเหตุผล)' : '(ไม่บังคับ)'}</label>
        <textarea name="comment" maxlength="1000" placeholder="${reject ? 'ระบุเหตุผลที่ไม่อนุมัติ' : 'ความเห็นเพิ่มเติม'}"></textarea>
        <div style="text-align:center;margin-top:14px">
          <button type="submit" style="background:${reject ? '#A32D2D' : '#0A5940'};color:#fff">${reject ? '❌ ยืนยันไม่อนุมัติ' : '✅ ยืนยันอนุมัติ'}</button>
        </div>
      </form>
      <p style="text-align:center;font-size:12px;margin-top:14px"><a href="${e(openUrl)}" style="color:#1E3A5F">หรือเปิดดูรายละเอียดทั้งหมดในระบบ</a></p>`)));
  });

  router.post('/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const action = req.body?.action === 'reject' ? 'reject' : 'approve';
    const comment = String(req.body?.comment || '').replace(/<[^>]*>/g, '').trim().slice(0, 1000);
    // ผลตรวจสอบรายสินค้า (ขั้นตรวจสอบ): vsku_<i> = รหัสสินค้า, verdict_<i> = profit | loss — ตรวจครบ/ถูกต้องที่ validateChange
    const lineVerdicts = {};
    Object.keys(req.body || {}).filter(k => /^vsku_\d+$/.test(k)).forEach(k => {
      const v = req.body['verdict_' + k.slice(5)];
      if (['profit', 'loss'].includes(v)) lineVerdicts[String(req.body[k])] = v;
    });
    let before, after, st;
    try {
      db.exec('BEGIN IMMEDIATE');
      st = loadState(db, req.params.token);
      if (st.error || st.closed) { db.exec('ROLLBACK'); return res.status(409).send(page('บันทึกไม่ได้', promoMail.shell(`<p style="font-size:14px">${e(st.error || st.closed)}</p>`))); }
      before = st.header;
      after = applyHeaderChange(db, st.raw, { status: action === 'reject' ? 'rejected' : st.raw.status, approval_comment: comment, ...(action !== 'reject' && Object.keys(lineVerdicts).length ? { approval_line_verdicts: lineVerdicts } : {}) }, st.user);
      db.prepare("UPDATE promo_approval_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token = ?").run(req.params.token);
      db.prepare('INSERT INTO audit_log (uid, role, action, target) VALUES (?, ?, ?, ?)')
        .run(st.user.uid, st.user.role, 'PROMO_DRAFT_EMAIL_' + (action === 'reject' ? 'REJECT' : 'APPROVE'), st.header.draft_no);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      return res.status(400).send(page('บันทึกไม่สำเร็จ', promoMail.shell(`<p style="font-size:14px">บันทึกไม่สำเร็จ: ${e(err.message)}</p>`)));
    }
    promoMail.afterChange(db, before, after, publicBaseUrl(req)).catch(err => console.warn('[promoMail]', err.message));
    const openUrl = `${promoMail.appUrl()}/?draft=${encodeURIComponent(after.draft_no)}`;
    res.send(page('บันทึกแล้ว', promoMail.shell(`
      <p style="font-size:15px;margin:0 0 8px"><b style="color:${action === 'reject' ? '#A32D2D' : '#0A5940'}">${action === 'reject' ? '❌ บันทึกไม่อนุมัติแล้ว' : '✅ บันทึกอนุมัติแล้ว'}</b></p>
      <p style="font-size:13px;margin:0 0 8px">สถานะเอกสารตอนนี้: <b>${e(STATUS_TH[after.status] || after.status)}</b>${after.status === 'pending_approval' || after.status === 'pending_exec_approval' ? ' — ระบบแจ้งผู้อนุมัติขั้นถัดไปทางอีเมลแล้ว' : ''}</p>
      <div style="text-align:center;margin-top:14px"><a href="${e(openUrl)}" style="background:#D4AF37;color:#111;padding:11px 24px;border-radius:6px;text-decoration:none;font-weight:700">🔎 เปิดดูในระบบ</a></div>`)));
  });

  return router;
};
