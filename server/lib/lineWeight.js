'use strict';

// น้ำหนัก (กก.) ของบรรทัดขาย — ย้ายออกจาก routes/dashboardExec.js (2026-11-16) เพื่อให้ตารางรายสินค้าของ Sales Overview
// (routes/invoiceDetail.js /pivot) คิดทุนต่อกก. ด้วยกติกาเดียวกับ Dashboard ผู้บริหาร · โค้ดเดิมไม่เปลี่ยนพฤติกรรม

const { DatabaseSync } = require('node:sqlite');
const { weightFromName } = require('./weightFromName');

// น้ำหนักต่อหน่วยจาก tgm-wms (skus.weight_per_unit = กก. ต่อ 1 หน่วยสต็อก) — เปิด WMS DB แบบอ่านอย่างเดียว
// แยกจาก connection หลัก และ cache 10 นาที (ค่าน้ำหนักแทบไม่เปลี่ยน)
let weightCache = { at: 0, map: null };
function loadWeights() {
  if (weightCache.map && Date.now() - weightCache.at < 10 * 60 * 1000) return weightCache.map;
  const map = new Map();
  const dbPath = process.env.WMS_DB_PATH;
  if (dbPath) {
    let wdb = null;
    try {
      wdb = new DatabaseSync(dbPath, { readOnly: true });
      for (const r of wdb.prepare('SELECT sku_code, weight_per_unit FROM skus WHERE weight_per_unit > 0').all()) {
        map.set(String(r.sku_code).trim(), Number(r.weight_per_unit));
      }
    } catch (e) {
      console.warn('[lineWeight] load WMS weights failed:', e.message);
    } finally {
      try { wdb && wdb.close(); } catch (_) { /* ignore */ }
    }
  }
  weightCache = { at: Date.now(), map };
  return map;
}
const KG_UNIT_RE = /^(กก|กิโล|kg)/i;

// ตัวคำนวณต่อ db (cache ชื่อสินค้า / น้ำหนักชุดโปร 10 นาที) → { lineKg(r, weights), skuNames() }
// r: { sku, unit_code, qty, qty_base }
const perDb = new WeakMap();
function lineWeights(db) {
  if (perDb.has(db)) return perDb.get(db);
  // KG ของ 1 บรรทัดขาย: หน่วยกิโลกรัม → qty · มีน้ำหนักใน WMS → qty_base × weight_per_unit
  // · ไม่มีใน WMS → น้ำหนักจากชื่อสินค้า × qty (lib/weightFromName.js, 2026-10-14) — ลองชื่อรหัสคู่ A-xxx / xxx ด้วย
  //   (เช่น TS0197 "แฮมหมู ตรา เอโร่" ไม่บอกน้ำหนัก แต่ A-TS0197 "แฮมหมู ตราเอโร่ 1000 กรัม") · ไม่รู้ = null (ไม่นับ KG)
  let skuNameCache = { at: 0, map: null };
  const nameKgMemo = new Map();
  function skuNames() {
    if (skuNameCache.map && Date.now() - skuNameCache.at < 10 * 60 * 1000) return skuNameCache.map;
    const map = new Map();
    for (const r of db.prepare('SELECT code, name FROM bplus_skus').all()) if (r.name) map.set(r.code, r.name);
    for (const r of db.prepare('SELECT code, name FROM products').all()) if (r.name) map.set(r.code, r.name);
    skuNameCache = { at: Date.now(), map };
    nameKgMemo.clear();
    return map;
  }
  // ชุดราคาพิเศษฝากขาย (90022-x "ทีจีเอ็มอาหารพร้อมทาน 99บาท" ฯลฯ) ไม่มีน้ำหนักในชื่อ แต่ invoice_line_components บอกสินค้าจริง
  // ในแต่ละบิล → น้ำหนักเฉลี่ยต่อแพ็ค = KG ของสินค้าลูกทั้งหมด ÷ จำนวนแพ็ค (ใช้เมื่อรู้น้ำหนักสินค้าลูก ≥ 70% ของจำนวน)
  let bundleCache = { at: 0, map: null };
  function bundleWeights(weights) {
    if (bundleCache.map && Date.now() - bundleCache.at < 10 * 60 * 1000) return bundleCache.map;
    const parentQty = new Map(db.prepare(`SELECT l.sku, SUM(l.qty) AS q FROM invoice_lines l
      WHERE EXISTS (SELECT 1 FROM invoice_line_components c WHERE c.company = l.company AND c.doc_num = l.doc_num AND c.seq_num = l.seq_num)
      GROUP BY l.sku`).all().map((r) => [r.sku, Number(r.q) || 0]));
    const acc = new Map();
    for (const r of db.prepare(`SELECT parent_sku, child_code, MAX(child_name) AS child_name, SUM(child_qty) AS q FROM invoice_line_components
      GROUP BY parent_sku, child_code`).all()) {
      const a = acc.get(r.parent_sku) || { kg: 0, known: 0, all: 0 };
      const q = Number(r.q) || 0;
      const w = weights.has(r.child_code) ? weights.get(r.child_code) : weightFromName(r.child_name, '');
      a.all += q;
      if (w != null) { a.known += q; a.kg += q * w; }
      acc.set(r.parent_sku, a);
    }
    const map = new Map();
    for (const [sku, a] of acc) {
      const pq = parentQty.get(sku);
      if (pq > 0 && a.all > 0 && a.known / a.all >= 0.7) map.set(sku, a.kg / (a.known / a.all) / pq);
    }
    bundleCache = { at: Date.now(), map };
    return map;
  }
  function lineKg(r, weights) {
    if (KG_UNIT_RE.test(r.unit_code || '')) return Number(r.qty) || 0;
    if (weights.has(r.sku)) return (Number(r.qty_base) || 0) * weights.get(r.sku);
    const bundles = bundleWeights(weights);
    if (bundles.has(r.sku)) return (Number(r.qty) || 0) * bundles.get(r.sku);
    const names = skuNames();
    const key = `${r.sku}|${r.unit_code || ''}`;
    if (!nameKgMemo.has(key)) {
      const sku = String(r.sku || '');
      const twin = sku.startsWith('A-') ? sku.slice(2) : `A-${sku}`;
      let w = weightFromName(names.get(sku), r.unit_code);
      if (w == null && weights.has(twin) && !/^(กล่อง|ลัง|ลง|กล)/.test(r.unit_code || '')) w = weights.get(twin);
      if (w == null) w = weightFromName(names.get(twin), r.unit_code);
      nameKgMemo.set(key, w);
    }
    const w = nameKgMemo.get(key);
    return w == null ? null : (Number(r.qty) || 0) * w;
  }
  const out = { lineKg, skuNames };
  perDb.set(db, out);
  return out;
}

module.exports = { loadWeights, lineWeights, KG_UNIT_RE };
