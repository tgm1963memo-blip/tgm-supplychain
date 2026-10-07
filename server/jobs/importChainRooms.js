'use strict';

// ยอดขายรายสาขาห้าง จากบริษัท "ห้อง SKU" ใน Express (2026-10-07, ผู้ใช้ขอ) — TOPS-53 / MAKRO / GOWHOLES
// ห้องเหล่านี้บันทึกยอดตามสาขาห้าง (เช่น 30-KK-0004 ท็อปส์บางรัก, 01-NB-0001 แม็คโครลาดพร้าว) ขณะที่ห้อง VAT (TSS/TGM)
// วางบิลเข้ารหัส DC/สำนักงานใหญ่ (30-PL, 30-PN …) ที่ส่วนใหญ่อยู่ใต้รหัส Sales ออฟฟิศ — ตรวจกับข้อมูลจริง ส.ค. 69:
// MAKRO ห้อง SKU 22.15 ล้าน ≈ ห้อง VAT DC 21.82 ล้าน
// กติกาที่ผู้ใช้ยืนยัน 2026-10-07:
//   · ไม่รวมในยอดบริษัท (ซ้ำกับห้อง VAT) — เก็บแยกตาราง chain_sales_* ไม่เขียนลง invoice_sales_*
//   · ใช้เฉพาะมุมมองราย Sales: แทนยอดรหัส DC ห้อง VAT ด้วยยอดรายสาขาที่จับคู่รหัส Sales ตามไฟล์ (lib/chainSales.js)
//   · ดึงตั้งแต่ 2025 · ห้อง SKU บันทึก SLMCOD เป็นชื่อคน (ชาญณรงค์/TSS/อนิตา) → เก็บไว้เป็น raw_slm อ้างอิงเท่านั้น
// ARTRN ของ TOPS-53 ใหญ่ ~1GB (2.5 ล้านแถวตั้งแต่ 2010) → อ่านเป็นชุด ทีละ 50,000 แถว และอ่านใหม่เฉพาะเมื่อไฟล์เปลี่ยน
// (mtime) และไม่ถี่กว่า CHAIN_SYNC_MIN_INTERVAL_MIN นาที (ค่าเริ่ม 60)
const fs = require('fs');
const path = require('path');
const { DBFFile } = require('dbffile');

const CHAINS = [
  { key: 'TOPS', company: 'TOPS-53' },
  { key: 'MAKRO', company: 'MAKRO' },
  { key: 'GO', company: 'GOWHOLES' },
];
const FROM_DATE = '2025-01-01';
const INVOICE_RECTYP = new Set(['0', '1', '3', '4', '5']); // กติกาเดียวกับ syncInvoiceSales (5 = ลดหนี้ ติดลบ)
const MIN_INTERVAL_MS = (Number(process.env.CHAIN_SYNC_MIN_INTERVAL_MIN) || 60) * 60 * 1000;
const OPTS = { encoding: 'cp874', readMode: 'loose' };

function findFile(folder, baseName) {
  try {
    const hit = fs.readdirSync(folder).find((f) => f.toUpperCase() === baseName.toUpperCase());
    return hit ? path.join(folder, hit) : null;
  } catch { return null; }
}
const iso = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

async function syncChain(db, root, chain) {
  const folder = path.join(root, chain.company);
  const file = findFile(folder, 'ARTRN.DBF');
  if (!file) return 0;
  const source = `chain/${chain.company}/ARTRN.DBF`;
  const mtimeMs = fs.statSync(file).mtimeMs;
  const prev = db.prepare('SELECT mtime_ms, synced_at FROM sync_file_state WHERE source = ?').get(source);
  if (prev && prev.mtime_ms === mtimeMs) return 0;
  if (prev && prev.synced_at && Date.now() - Date.parse(prev.synced_at) < MIN_INTERVAL_MS) return 0;

  const dbf = await DBFFile.open(file, OPTS);
  if (!dbf.recordCount) return 0; // share หลุดกลางรอบ = 0 แถว → ข้าม ไม่ลบของเดิม
  const monthly = new Map(), daily = new Map();
  for (;;) {
    const recs = await dbf.readRecords(50000);
    if (!recs.length) break;
    for (const r of recs) {
      if (!INVOICE_RECTYP.has(r.RECTYP)) continue;
      const d = iso(r.DOCDAT);
      if (!d || d < FROM_DATE) continue;
      const cust = clean(r.CUSCOD) || '(none)';
      const raw = clean(r.SLMCOD);
      const v = (r.RECTYP === '5' ? -1 : 1) * (Number(r.NETVAL) || 0);
      for (const [map, key] of [[monthly, `${d.slice(0, 7)}\u0001${cust}\u0001${raw}`], [daily, `${d}\u0001${cust}\u0001${raw}`]]) {
        const cur = map.get(key) || { amount: 0, n: 0 };
        cur.amount += v;
        if (r.RECTYP !== '5') cur.n += 1;
        map.set(key, cur);
      }
    }
  }
  // ชื่อสาขาจาก ARMAS ของห้องนั้น (รหัสสาขาห้องเหล่านี้ไม่มีใน customers ของห้อง VAT)
  let custs = [];
  const armas = findFile(folder, 'ARMAS.DBF');
  if (armas) {
    try { custs = await (await DBFFile.open(armas, OPTS)).readRecords(); } catch (e) { console.warn(`[chainRooms] ${chain.company} ARMAS: ${e.message}`); }
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM chain_sales_monthly WHERE chain = ?').run(chain.key);
    db.prepare('DELETE FROM chain_sales_daily WHERE chain = ?').run(chain.key);
    const im = db.prepare('INSERT INTO chain_sales_monthly (chain, ym, cust_code, raw_slm, amount, invoice_count) VALUES (?, ?, ?, ?, ?, ?)');
    const idy = db.prepare('INSERT INTO chain_sales_daily (chain, d, cust_code, raw_slm, amount, invoice_count) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [k, v] of monthly) { const [p, c, s] = k.split('\u0001'); im.run(chain.key, p, c, s, v.amount, v.n); }
    for (const [k, v] of daily) { const [p, c, s] = k.split('\u0001'); idy.run(chain.key, p, c, s, v.amount, v.n); }
    if (custs.length) {
      const uc = db.prepare(`INSERT INTO chain_customers (code, chain, name, raw_slm, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(code) DO UPDATE SET chain = excluded.chain, name = excluded.name, raw_slm = excluded.raw_slm, updated_at = excluded.updated_at`);
      for (const c of custs) { const code = clean(c.CUSCOD); if (code) uc.run(code, chain.key, clean(c.CUSNAM), clean(c.SLMCOD)); }
    }
    db.prepare(`INSERT INTO sync_file_state (source, mtime_ms, synced_at) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET mtime_ms = excluded.mtime_ms, synced_at = excluded.synced_at`).run(source, mtimeMs, new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(`[chainRooms] ${chain.company}: ${monthly.size} monthly rows, ${daily.size} daily rows, ${custs.length} customers`);
  return monthly.size;
}

// เรียกจาก jobs/syncWorker.js ต่อท้าย Express/Bplus ใน worker เดียวกัน · ไม่ throw (ห้องหนึ่งพังไม่กระทบห้องอื่น)
async function runChainImport(db, root) {
  let n = 0;
  if (!root || !fs.existsSync(root)) return 0;
  for (const chain of CHAINS) {
    try { n += await syncChain(db, root, chain); } catch (e) { console.warn(`[chainRooms] ${chain.company} failed: ${e.message}`); }
  }
  return n;
}

module.exports = { runChainImport, syncChain, CHAINS, FROM_DATE };
