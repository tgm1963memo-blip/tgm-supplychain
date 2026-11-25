'use strict';

// ยอดขาย Shop พระรามสาม จาก Choco POS (mybusiness.chococrm.com) — 2026-11-25, ผู้ใช้เลือก "login เข้าไปดึง"
// Choco ไม่มี API สาธารณะ: ใช้ API เดียวกับหน้า Backoffice (สำรวจด้วย scripts/choco-discover.js)
//   POST /Account/Login?version=2 {ProviderRef, BrandRef:'', Username, Password} → data.access_token (Bearer)
//   POST /order/list {Page, Limit, Filters:[from_dt, to_dt], Ordering} → data.data_list[], data.total_page
// ยอดขาย = บิลสถานะ 9 (ชำระแล้ว) · ตัด 2 (ยกเลิก/ค้าง) และ 11 (void) · จัดวันตามเวลาเปิดบิล (เวลาไทย)
// บัญชีนี้มีร้านเดียว "TGM SHOP RAMA3" เริ่มใช้ Choco 27 พ.ค. 2569 — ช่วงก่อนหน้านั้นไม่มีข้อมูล (covered=false)
// ถ้า API เปลี่ยน/ล็อกอินไม่ได้ จะโยน error ให้ผู้เรียกใช้ยอดในระบบแทน (รายงานยังส่งได้)

const BASE = 'https://crmpos-bo-api.azurewebsites.net/backoffice/v1.0';
const PROVIDER_REF = 'PVnOkoGcuwKO51'; // ค่าคงที่ของหน้า mybusiness.chococrm.com (ส่งตอนล็อกอินทุกครั้ง)
const CHOCO_START = '2026-05-27';
const DONE = 9;

const configured = () => !!(process.env.CHOCO_EMAIL && process.env.CHOCO_PASSWORD);

async function call(path, body, token) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let j = null;
  try { j = await res.json(); } catch { /* ไม่ใช่ JSON */ }
  if (!res.ok || !j || j.status !== 'success') {
    const msg = j?.error?.locale?.['th-th']?.title || j?.error?.system || `HTTP ${res.status}`;
    throw new Error(`Choco ${path}: ${msg}`);
  }
  return j.data;
}

async function login() {
  const d = await call('/Account/Login?version=2', {
    ProviderRef: PROVIDER_REF, BrandRef: '', Username: process.env.CHOCO_EMAIL, Password: process.env.CHOCO_PASSWORD,
  });
  if (!d?.access_token) throw new Error('Choco: ล็อกอินแล้วไม่ได้ access token');
  return d.access_token;
}

// วันที่เวลาไทย (YYYY-MM-DD) ของเวลา UTC จาก API
const thDate = (iso) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);

// ยอดบิลชำระแล้วในช่วง from..to (YYYY-MM-DD รวมทั้งสองวัน) → { total, bills, covered }
async function salesTotal(token, from, to) {
  if (to < CHOCO_START) return { total: 0, bills: 0, covered: false };
  let total = 0, bills = 0;
  for (let page = 1; page <= 500; page++) {
    const d = await call('/order/list', {
      Page: page, Limit: 100,
      // ขอเผื่อหน้า/หลัง 1 วัน (ตัวกรองของ API อาจเป็นเวลา UTC) แล้วกรองวันไทยเองด้านล่าง
      Filters: [{ Key: 'from_dt', Value: `${shiftDay(from, -1)} 00:00:00` }, { Key: 'to_dt', Value: `${shiftDay(to, 1)} 23:59:59` }],
      Ordering: [{ Seq: 1, Key: 'created_dt', Direction: 'asc' }],
    }, token);
    for (const o of d.data_list || []) {
      if (o.order_status !== DONE || !o.opened_time) continue;
      const day = thDate(o.opened_time);
      if (day < from || day > to) continue;
      total += Number(o.total) || 0;
      bills++;
    }
    if (page >= (d.total_page || 1)) break;
  }
  return { total, bills, covered: from >= CHOCO_START };
}

function shiftDay(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// แทนยอดแถว Shop พระรามสาม ในรายงานด้วยยอด Choco (rep จาก lib/weeklySalesReport.js) — แก้ rep ในที่ แล้วคืน rep
// ปีที่ Choco ไม่มีข้อมูลครบช่วง (ก่อน 27 พ.ค. 2569) ใช้ยอดในระบบเดิมพร้อมหมายเหตุ · ดึงไม่ได้ = คงยอดเดิม + หมายเหตุสาเหตุ
async function applyChocoToReport(rep) {
  const r = (rep.shops || []).find((s) => s.channel === 'shop_rama3');
  if (!r) return rep;
  if (!configured()) { r.note = 'ยอดในระบบ — ยังไม่ได้ตั้งบัญชี Choco POS'; return rep; }
  try {
    const token = await login();
    const ty = await salesTotal(token, rep.from, rep.to);
    const ly = await salesTotal(token, rep.ly_from, rep.ly_to);
    const notes = [];
    if (ty.covered) r.ty = ty.total; else notes.push('ปีนี้ใช้ยอดในระบบ');
    if (ly.covered) r.ly = ly.total; else notes.push('ปีก่อนใช้ยอดในระบบ (Choco เริ่ม 27 พ.ค. 2569)');
    r.note = `Choco POS ${ty.bills.toLocaleString('en-US')} บิล${notes.length ? ` · ${notes.join(' · ')}` : ''}`;
    r.source = 'choco';
  } catch (e) {
    console.warn('[chocoPos]', e.message);
    r.note = `ยอดในระบบ — ดึง Choco ไม่ได้ (${String(e.message).slice(0, 60)})`;
  }
  return rep;
}

module.exports = { configured, login, salesTotal, applyChocoToReport, CHOCO_START };
