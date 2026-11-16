'use strict';

// LINE Messaging API (2026-11-13) — LINE Notify ปิดบริการแล้ว จึงส่งผ่านบอทของ LINE Official Account
// ตั้งค่าใน .env: LINE_CHANNEL_ACCESS_TOKEN (long-lived) + LINE_CHANNEL_SECRET (ตรวจลายเซ็น webhook)
// ข้อจำกัดของ LINE: push ได้ครั้งละ ≤ 5 ข้อความ · รูปต้องเป็น HTTPS URL ที่ LINE ดึงได้จากภายนอก (≤ 10MB, preview ≤ 1MB)

const crypto = require('crypto');

const API = 'https://api.line.me/v2/bot';

function lineConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET);
}

async function call(method, path, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN ใน .env');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ส่งข้อความเข้ากลุ่ม/ห้อง/ผู้ใช้ (to = groupId / roomId / userId)
function pushMessages(to, messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 5) throw new Error('LINE push ได้ครั้งละ 1–5 ข้อความ');
  return call('POST', '/message/push', { to, messages });
}

// ชื่อกลุ่ม (ใช้แสดงในหน้าตั้งค่า) — ห้อง (room) ไม่มีชื่อ
async function groupName(groupId) {
  try { return (await call('GET', `/group/${encodeURIComponent(groupId)}/summary`)).groupName || ''; } catch { return ''; }
}

// ตรวจ x-line-signature = base64(HMAC-SHA256(channel secret, raw body))
function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try { got = Buffer.from(String(signature), 'base64'); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { lineConfigured, pushMessages, groupName, verifySignature };
