const nodemailer = require('nodemailer');

// ห่อ nodemailer สำหรับส่งอีเมลรีเซ็ตรหัสผ่าน (2026-09-15) — ธีม/เลย์เอาต์เดียวกับระบบ E-Memo พี่น้อง
// (ดู ememo-firebase/server/lib/email-templates.js) เพื่อให้พนักงานคุ้นตา สีแบรนด์เดียวกับที่แอปนี้ใช้
// อยู่แล้ว (--N:#1E3A5F, --N2:#D4AF37 ใน index.html)
const COMPANY = 'บริษัท ไทยซอสเซส มาร์เก็ตติ้ง จำกัด';

let transporter = null;
let transporterError = null;

function getTransporter() {
  if (transporter || transporterError) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    transporterError = new Error('SMTP_CONFIG_MISSING');
    return null;
  }
  const port = Number(process.env.SMTP_PORT || 465);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'mail.tgm.co.th',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: false },
  });
  return transporter;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderResetEmail({ name, resetLink }) {
  const greeting = name ? `คุณ${escapeHtml(name)}` : 'ผู้ใช้งาน';
  const safeLink = escapeHtml(resetLink);
  const subject = '[TSS Supply Chain] รีเซ็ตรหัสผ่าน';
  const html = `
<div style="font-family:'Noto Sans Thai',Sarabun,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;">
  <div style="background:#1E3A5F;padding:20px 28px;border-radius:8px 8px 0 0;">
    <div style="font-size:16px;font-weight:700;color:#fff;">${COMPANY}</div>
    <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:2px;">TSS Supply Chain</div>
  </div>
  <div style="border:1px solid #E5E7EB;border-top:3px solid #D4AF37;padding:28px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:#111;">
      เรียน ${greeting}<br/>
      เราได้รับคำขอรีเซ็ตรหัสผ่านสำหรับบัญชีของท่านในระบบ TSS Supply Chain
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${safeLink}" style="background:#D4AF37;color:#111;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">
        ตั้งรหัสผ่านใหม่
      </a>
    </div>
    <p style="margin:0 0 12px;font-size:12px;color:#6B7280;line-height:1.7;">
      หากปุ่มไม่ทำงาน ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์:<br/>
      <a href="${safeLink}" style="color:#1E3A5F;word-break:break-all;">${safeLink}</a>
    </p>
    <p style="margin:0 0 4px;font-size:11px;color:#9CA3AF;">ลิงก์มีอายุ 1 ชั่วโมง</p>
    <p style="margin:0;font-size:11px;color:#9CA3AF;">หากท่านไม่ได้เป็นผู้ขอรีเซ็ตรหัสผ่าน สามารถละเว้นอีเมลฉบับนี้ได้</p>
    <div style="border-top:1px solid #F3F4F6;margin-top:24px;padding-top:14px;font-size:10px;color:#D1D5DB;text-align:center;">
      ${COMPANY} - TSS Supply Chain
    </div>
  </div>
</div>`;
  const text = `เรียน ${name || 'ผู้ใช้งาน'}\n\nเราได้รับคำขอรีเซ็ตรหัสผ่านสำหรับบัญชีของท่านในระบบ TSS Supply Chain\n\nตั้งรหัสผ่านใหม่: ${resetLink}\n\nลิงก์มีอายุ 1 ชั่วโมง หากท่านไม่ได้เป็นผู้ขอ สามารถละเว้นอีเมลฉบับนี้ได้`;
  return { subject, html, text };
}

// ส่งอีเมลรีเซ็ตรหัสผ่าน — ถ้ายังไม่ตั้งค่า SMTP (SMTP_USER/SMTP_PASSWORD) จะไม่ error หน้าเว็บ แค่ log
// ลิงก์ไว้ใน server log แทน (ให้ทีมงานส่งเองได้ระหว่างรอตั้งค่าจริง — ตามที่ยืนยันไว้ในแผน)
async function sendResetPasswordEmail({ to, name, resetLink }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[mailer] SMTP ยังไม่ได้ตั้งค่า — ลิงก์รีเซ็ตรหัสผ่านสำหรับ ${to}: ${resetLink}`);
    return { sent: false, reason: 'SMTP_CONFIG_MISSING' };
  }
  const rendered = renderResetEmail({ name, resetLink });
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `"TSS Supply Chain" <${process.env.SMTP_USER}>`,
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return { sent: true };
  } catch (e) {
    console.error('[mailer] sendResetPasswordEmail failed:', e.message);
    console.warn(`[mailer] ลิงก์รีเซ็ตรหัสผ่านสำหรับ ${to} (ส่งอีเมลไม่สำเร็จ): ${resetLink}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendResetPasswordEmail };
