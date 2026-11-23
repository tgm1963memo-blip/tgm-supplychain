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
const STATE = path.join(__dirname, '.tunnel-watch-state.json');
// ที่อยู่เดิมแต่ tunnel ตาย (เกิดจริง 2026-11-12: cloudflared ยังรันแต่ต่อ edge ไม่ได้ "control stream encountered a failure"
// ที่อยู่ trycloudflare หายจาก DNS ทั้งที่ server ในเครื่องปกติ) → รีสตาร์ท service ให้ได้ที่อยู่ใหม่ แล้วรอบถัดไปจะ deploy เอง
// ต้องให้ user TSS มีสิทธิ์ start/stop service นี้ (ตั้งครั้งเดียวด้วย sc.exe sdset ใน PowerShell แบบ admin)
const TUNNEL_SERVICE = 'TGMQuickTunnel';
const FAILS_BEFORE_RESTART = 2;          // ล้ม 2 รอบติด (~10 นาที) ค่อยรีสตาร์ท
const RESTART_COOLDOWN_MS = 20 * 60 * 1000;
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
function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(st) { try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (_) { /* ignore */ } }
async function localHealthy() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch { return false; }
}
// ที่อยู่ปัจจุบันตอบไม่ได้ทั้งที่ server ในเครื่องปกติ → tunnel ค้าง → รีสตาร์ท
async function checkStaleTunnel(url) {
  const st = readState();
  if (await healthy(url)) { if (st.fails) writeState({ ...st, fails: 0 }); return; }
  if (!(await localHealthy())) { log(`${url} ตอบไม่ได้ แต่ server ในเครื่อง (127.0.0.1:3000) ก็ล่มด้วย — ปัญหาอยู่ที่ server ไม่ใช่ tunnel`); return; }
  const fails = (st.fails || 0) + 1;
  writeState({ ...st, fails });
  log(`tunnel ${url} ตอบไม่ได้ (server ในเครื่องปกติ) ครั้งที่ ${fails}`);
  if (fails < FAILS_BEFORE_RESTART || DRY) return;
  if (st.lastRestart && Date.now() - st.lastRestart < RESTART_COOLDOWN_MS) return;
  try {
    run('powershell.exe', ['-NoProfile', '-Command', `Restart-Service ${TUNNEL_SERVICE} -Force -ErrorAction Stop`], ROOT);
    log(`รีสตาร์ท ${TUNNEL_SERVICE} แล้ว — รอบถัดไปจะ deploy ที่อยู่ใหม่`);
  } catch (e) {
    log(`รีสตาร์ท ${TUNNEL_SERVICE} ไม่ได้ (ยังไม่ได้ให้สิทธิ์?): ${String(e.stderr || e.message).slice(-300)}`);
  }
  writeState({ fails: 0, lastRestart: Date.now() });
}
// ADDED (2026-11-23): ngrok ที่ tss-wms (tgm-wms.vercel.app) ใช้เรียก tgm-supplychain — โดเมนคงที่ จึงไม่ต้อง deploy ใหม่
// แต่ ngrok.exe (task NgrokTunnel-Supplychain, เริ่มตอน logon) เคยค้างทั้งที่ process ยังอยู่: 23/11 ตอบ ERR_NGROK_3200 /
// 16-21 วิ ตั้งแต่เปิดค้างไว้ 11/11 · ล้ม 2 รอบติด (~10 นาที) ทั้งที่ server ในเครื่องปกติ → หยุด ngrok แล้วสั่ง task ใหม่
const NGROK = { url: 'https://tactless-decency-liquefy.ngrok-free.dev', task: 'NgrokTunnel-Supplychain' };
const NGROK_STATE = path.join(__dirname, '.tunnel-watch-ngrok.json');
async function checkNgrok() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(NGROK_STATE, 'utf8')); } catch (_) { /* ไม่มี state */ }
  const save = s => { try { fs.writeFileSync(NGROK_STATE, JSON.stringify(s)); } catch (_) { /* ignore */ } };
  let ok = false;
  try {
    const r = await fetch(NGROK.url + '/api/health', { headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(15000) });
    ok = r.ok;
  } catch { ok = false; }
  if (ok) { if (st.fails) { log(`ngrok ${NGROK.url} กลับมาตอบได้`); save({ ...st, fails: 0 }); } return; }
  if (!(await localHealthy())) { log('ngrok ตอบไม่ได้ แต่ server ในเครื่องก็ล่มด้วย — ไม่รีสตาร์ท ngrok'); return; }
  const fails = (st.fails || 0) + 1;
  save({ ...st, fails });
  log(`ngrok ${NGROK.url} ตอบไม่ได้ (server ในเครื่องปกติ) ครั้งที่ ${fails}`);
  if (fails < FAILS_BEFORE_RESTART || DRY) return;
  if (st.lastRestart && Date.now() - st.lastRestart < RESTART_COOLDOWN_MS) return;
  try {
    // เรียก powershell ตรง (ไม่ผ่าน cmd แบบ run()) เพราะคำสั่งมี | และ ;
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Stop-ScheduledTask -TaskName '${NGROK.task}' -ErrorAction SilentlyContinue; Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName '${NGROK.task}' -ErrorAction Stop`],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60 * 1000 });
    log(`รีสตาร์ท ngrok (task ${NGROK.task}) แล้ว`);
  } catch (e) {
    log(`รีสตาร์ท ngrok ไม่ได้: ${String(e.stderr || e.message).slice(-300)}`);
  }
  save({ fails: 0, lastRestart: Date.now() });
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
  await checkNgrok().catch(e => log(`ตรวจ ngrok ผิดพลาด: ${e.message}`));
  const tunnel = latestTunnelUrl();
  const cfg = currentConfigUrl();
  if (!tunnel) { log('ไม่พบที่อยู่ tunnel ใน log'); return; }
  if (tunnel === cfg) return checkStaleTunnel(tunnel); // ไม่เปลี่ยน — แค่ตรวจว่ายังใช้ได้ (เงียบถ้าปกติ)
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
