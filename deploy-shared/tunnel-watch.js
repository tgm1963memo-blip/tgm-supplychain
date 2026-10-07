'use strict';

// เฝ้าที่อยู่ Cloudflare quick tunnel แล้ว deploy เว็บใหม่อัตโนมัติเมื่อเปลี่ยน (2026-10-07, ผู้ใช้ขอ "ทำข้อ 3 ไว้ก่อน")
// quick tunnel ได้ที่อยู่สุ่มใหม่ทุกครั้งที่ service/เครื่อง DB รีสตาร์ท (เกิดจริง 2026-10-06 17:11) — เว็บบน Vercel ฝังที่อยู่ไว้
// ตอน build (deploy-shared/api-config.js) จึงเชื่อมต่อไม่ได้จนกว่าจะ deploy ใหม่ · สคริปต์นี้รันทุก 5 นาที (Task Scheduler):
//   1) อ่านที่อยู่ล่าสุดจาก log ของ tunnel (server/tunnel-quick-stderr*.log ไฟล์ใหม่สุด)
//   2) ตรวจว่าที่อยู่ใหม่ตอบ /api/health ได้จริง
//   3) ต่างจากที่ตั้งไว้ → แก้ api-config.js → build ทั้ง 2 แอป → vercel --prod → alias
// เป็นทางแก้ชั่วคราว — ทางถาวรคือ named tunnel + โดเมนของบริษัท (ที่อยู่ไม่เปลี่ยน)
// รันเอง: node deploy-shared/tunnel-watch.js [--dry-run]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server');
const CONFIG = path.join(__dirname, 'api-config.js');
const LOG = path.join(__dirname, 'tunnel-watch.log');
const LOCK = path.join(__dirname, '.tunnel-watch.lock');
const APPS = [
  { dir: path.join(ROOT, 'vercel-deploy'), proj: 'tgm-supplychain', alias: 'tss-supplychain.vercel.app' },
  { dir: path.join(ROOT, 'planning-deploy'), proj: 'tss-planning', alias: 'tss-planning.vercel.app' },
];
const DRY = process.argv.includes('--dry-run');
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
    // เก็บ log ไม่เกิน ~200KB
    if (fs.statSync(LOG).size > 200 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8').slice(-100 * 1024));
  } catch (_) { /* ignore */ }
}

// ที่อยู่ล่าสุด = ที่อยู่สุดท้ายในไฟล์ log ของ tunnel ที่แก้ไขล่าสุด
function latestTunnelUrl() {
  const files = fs.readdirSync(SERVER).filter(f => /^tunnel-quick-stderr.*\.log$/i.test(f) || /^quicktunnel-stderr.*\.log$/i.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(SERVER, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const m = fs.readFileSync(path.join(SERVER, f), 'utf8').match(URL_RE);
    if (m && m.length) return m[m.length - 1];
  }
  return null;
}
function currentConfigUrl() {
  const m = fs.readFileSync(CONFIG, 'utf8').match(/DEFAULT_API_BASE = '([^']+)'/);
  return m ? m[1] : null;
}
async function healthy(url) {
  try {
    const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    return r.ok && j && j.ok === true;
  } catch { return false; }
}
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  // กันรันซ้อน (deploy ใช้เวลาหลายนาที) — lock ค้างเกิน 30 นาทีถือว่าตาย
  try {
    const st = fs.statSync(LOCK);
    if (Date.now() - st.mtimeMs < 30 * 60 * 1000) return;
  } catch (_) { /* ไม่มี lock */ }
  const tunnel = latestTunnelUrl();
  const cfg = currentConfigUrl();
  if (!tunnel) { log('ไม่พบที่อยู่ tunnel ใน log'); return; }
  if (tunnel === cfg) return; // ไม่เปลี่ยน — เงียบ ไม่เขียน log ทุก 5 นาที
  if (!(await healthy(tunnel))) { log(`ที่อยู่ใหม่ ${tunnel} ยังตอบ /api/health ไม่ได้ — รอรอบถัดไป`); return; }
  log(`ที่อยู่ tunnel เปลี่ยน: ${cfg} → ${tunnel}${DRY ? ' (dry-run)' : ''}`);
  if (DRY) return;
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const src = fs.readFileSync(CONFIG, 'utf8');
    fs.writeFileSync(CONFIG, src.replace(/DEFAULT_API_BASE = '[^']+'/, `DEFAULT_API_BASE = '${tunnel}'`));
    for (const app of APPS) {
      run('node', ['build.js'], app.dir);
      const out = run('vercel.cmd', ['--prod', '--yes'], path.join(app.dir, 'public'));
      const urls = out.match(new RegExp(`https://${app.proj}-[a-z0-9]+-[a-z0-9-]+\\.vercel\\.app`, 'g')) || [];
      const dep = urls[urls.length - 1];
      if (!dep) throw new Error(`${app.proj}: ไม่พบ URL ของ deployment ในผลลัพธ์ vercel`);
      run('vercel.cmd', ['alias', 'set', dep, app.alias], path.join(app.dir, 'public'));
      log(`${app.proj}: deploy ${dep} → ${app.alias}`);
    }
    // ตรวจว่าเว็บจริงใช้ที่อยู่ใหม่แล้ว
    for (const app of APPS) {
      const html = await (await fetch(`https://${app.alias}/`, { signal: AbortSignal.timeout(30000) })).text().catch(() => '');
      log(`${app.alias}: ${html.includes(tunnel) ? 'ใช้ที่อยู่ใหม่แล้ว ✓' : 'ยังไม่เห็นที่อยู่ใหม่ ✗'}`);
    }
  } catch (e) {
    log(`deploy ไม่สำเร็จ: ${e.message}${e.stderr ? ' · ' + String(e.stderr).slice(-500) : ''}`);
  } finally {
    try { fs.unlinkSync(LOCK); } catch (_) { /* ignore */ }
  }
}
main().catch(e => log(`ผิดพลาด: ${e.message}`));
