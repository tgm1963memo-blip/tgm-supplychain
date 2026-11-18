'use strict';

// ทุน 3 ช่องจากไฟล์ Master SKU → ทุนที่มีผล ณ วันที่ขาย + ทุนจากการแปลงรหัส (2026-11-16)
// ตาราง sku_cost_rounds (db/migrations.js) · นำเข้า: routes/costRounds.js
//
// กติกา (ผู้ใช้ยืนยัน 2026-11-13):
//   1. ทุนของ SKU ณ วันที่ d = แถวที่ eff_date ล่าสุดที่ ≤ d · ถ้า d อยู่ก่อนทุนรอบแรก ใช้ทุนรอบแรกย้อนหลัง
//      แล้วติด estimated (ค่าประมาณ) — ไม่ซ่อนกำไรของเดือนก่อนมีทุน
//   2. ฐานทุน 3 แบบ: total (ช่อง H ทุนรวม, ค่าหลัก) / depr (ช่อง G รวมค่าเสื่อม) / base (ช่อง F ขั้นต้น DL+OH)
//      ช่อง F/G ว่างในไฟล์ → ใช้ทุนรวมแทน
//   3. SKU ที่ไม่มีทุนของตัวเองแต่เกิดจากการแปลงรหัส (เอกสาร FF ใน conversion_doc_lines: out = ต้นทาง, in = ผลลัพธ์)
//      ใช้ทุนของสินค้าต้นทาง: Σ(จำนวนต้นทาง × ทุนต้นทาง) ÷ จำนวนผลลัพธ์ (อัตราส่วนจากเอกสารแปลงล่าสุด) แล้วติด source = 'converted' + รหัสต้นทาง
//      (ผู้ใช้สั่ง 2026-11-13 "ให้ใส่ว่าเป็นราคาจากการแปลง") · มีทุนของตัวเองเมื่อไร ใช้ทุนจริงก่อนเสมอ
// ข้อมูลไม่พอ → ไม่เดา: หน่วยของทุนต้นทางเทียบกับหน่วยในเอกสารแปลงไม่ได้ / เอกสารมีผลลัพธ์หลายรหัส = คืน null
//   4. ชุดโปร "1 แถม 1" / "แพ็คคู่" ที่ไม่มีทุนและไม่มีเอกสารแปลง (ผู้ใช้สั่ง 2026-11-16 "เอาทุนมาคูณ 2 และแสดงเป็นทุนประมาณการ")
//      → ทุนต่อชุด = ทุนแพ็คเดี่ยว × 2 แล้วติด source = 'promo2x' + รหัสที่ใช้ · แพ็คเดี่ยวหาจากรหัสขึ้นต้นเดียวกัน (20284-A → 20284-*)
//      ที่น้ำหนักต่อแพ็คเท่ากับน้ำหนักในชื่อชุดโปร (เช่น "100กรัม (1แถม1)" → 20284-107 แพ็คx100) หลายรหัส = เฉลี่ย
//      ไม่เจอ → ทุนต่อกก. ของรหัสขึ้นต้นเดียวกันที่ชื่อสินค้าขึ้นต้นเหมือนกัน × น้ำหนัก · ชื่อไม่บอกน้ำหนัก / หน่วยขายเป็นกล่อง-ลัง = ไม่เดา
//      ยกเว้นรหัสใน PROMO_PAIR_GRAMS (น้ำหนักแพ็คเดี่ยวที่ตรวจจากหลักฐานอื่น — ดูหมายเหตุในตาราง)
//   5. ชุดราคาพิเศษ (90021-x / 90022-x / 90023-x ฯลฯ) ที่ไม่มีทุนของตัวเอง (ผู้ใช้สั่ง 2026-11-18 "คิดทุนชุดโปรจากสินค้าลูก")
//      → ทุนต่อชุด = Σ (จำนวนลูกต่อชุด × ทุนต่อแพ็คของลูก ณ วันขาย) · สัดส่วนลูกจาก sales_line_components ทั้งหมด
//      (ชุดเดียวกันใส่สินค้าต่างกันในแต่ละบิล จึงใช้ส่วนผสมเฉลี่ย) · ลูกที่ไม่มีทุน = ใช้ทุนเฉลี่ยของลูกที่มีทุนแทน
//      เมื่อรู้ทุนลูก ≥ BUNDLE_MIN_KNOWN ของจำนวนลูกทั้งหมด ไม่ถึง = ไม่เดา · ติด source = 'bundle' + estimated

const { unitLabel } = require('./productGroupMatch');

const BASIS_COL = { total: 'cost_total', depr: 'cost_depr', base: 'cost_base' };
const isBasis = b => Object.prototype.hasOwnProperty.call(BASIS_COL, b);
const KG = 'กก.';
const KG_RE = /^(กิโลกรัม|กก\.?|kgs?\.?)$/i;
// ไฟล์ Master SKU สะกดหน่วยหลายแบบ (แพ็ค/แพค/Pack/pack, PCS, Box) และ Bplus ใช้ชื่อเต็ม — รวมให้เป็นคำเดียวกับ unitLabel
const UNIT_ALIAS = {
  'แพค': 'แพ็ค', 'แพ็ค': 'แพ็ค', 'pack': 'แพ็ค', 'packs': 'แพ็ค', 'pcs': 'ชิ้น', 'pc': 'ชิ้น', 'pcs.': 'ชิ้น',
  'box': 'กล่อง', 'ctn': 'ลัง', 'carton': 'ลัง', 'set': 'เซ็ต', 'เซต': 'เซ็ต', 'ชุด': 'ชุด',
};

function normUnit(u) {
  const s = String(u ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s === '0') return null;
  if (KG_RE.test(s)) return KG;
  const l = unitLabel(s);
  return UNIT_ALIAS[l.toLowerCase()] || UNIT_ALIAS[s.toLowerCase()] || l;
}

// ช่อง D ของไฟล์: "กิโลกรัม" / "KG." = ต่อกก. · "แพ็คx500" = ต่อแพ็ค หนัก 500 กรัม · "ชิ้น" = ต่อชิ้น ไม่รู้น้ำหนัก
function parseUnit(v) {
  const raw = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw === '0') return { unit: null, grams: null, raw: null };
  if (KG_RE.test(raw)) return { unit: KG, grams: 1000, raw };
  // ตัวเลขหลัง x = กรัมต่อหน่วย ("แพ็คx500", "กล่องx200กรัม") · ถ้าตามด้วยหน่วยนับอื่น ("แพ็คx5ชิ้น", "ถุงx5แผ่น")
  // เป็นจำนวนชิ้นในหน่วย ไม่ใช่น้ำหนัก → รู้หน่วยแต่ไม่รู้น้ำหนัก (พบในไฟล์จริงรอบ 2–7 พ.ย. 69)
  const m = raw.match(/^(.+?)\s*[xX×]\s*([\d,]+(?:\.\d+)?)\s*(.*)$/);
  if (m) {
    const g = Number(m[2].replace(/,/g, ''));
    const isGram = !m[3] || /^(กรัม|ก\.?|g\.?|grams?)$/i.test(m[3]);
    return { unit: normUnit(m[1]), grams: isGram && g > 0 ? g : null, raw };
  }
  return { unit: normUnit(raw), grams: null, raw };
}

// superadmin เห็นเสมอ · คนอื่นต้องถูกติ๊ก sc_users.can_see_cost (รวม admin — หน้านำเข้าทุนของ admin เป็นอีกสิทธิ์หนึ่ง)
const canSeeCost = user => !!user && (user.role === 'superadmin' || Number(user.can_see_cost) === 1);

// ── ดัชนีในหน่วยความจำ ────────────────────────────────────────────────
function loadCostIndex(db) {
  const idx = new Map();
  const rows = db.prepare('SELECT sku, eff_date, cost_base, cost_depr, cost_total, unit, unit_grams, suspect FROM sku_cost_rounds ORDER BY sku, eff_date').all();
  for (const r of rows) {
    if (!idx.has(r.sku)) idx.set(r.sku, []);
    idx.get(r.sku).push(r);
  }
  return idx;
}

// เอกสารแปลงที่ใช้หาทุนได้: มีผลลัพธ์รหัสเดียว (หลายรหัส = แบ่งทุนไม่ได้โดยไม่เดา) → Map ผลลัพธ์ → [{ doc, date, qty, sources }]
// qty ใน conversion_doc_lines เป็นหน่วยฐานของสินค้า (XTRNQTY ดู jobs/importFromExpress.js buildStockMovements)
function loadConversions(db) {
  const docs = new Map();
  const rows = db.prepare(`SELECT doc_num, MAX(doc_date) AS doc_date, sku, direction, SUM(qty) AS qty
    FROM conversion_doc_lines GROUP BY doc_num, sku, direction`).all();
  for (const r of rows) {
    if (!(r.qty > 0)) continue;
    if (!docs.has(r.doc_num)) docs.set(r.doc_num, { doc: r.doc_num, date: r.doc_date || '', in: new Map(), out: new Map() });
    const d = docs.get(r.doc_num);
    if (r.direction === 'in') d.in.set(r.sku, r.qty);
    else if (r.direction === 'out') d.out.set(r.sku, r.qty);
    if ((r.doc_date || '') > d.date) d.date = r.doc_date;
  }
  const byOut = new Map();
  for (const d of docs.values()) {
    if (d.in.size !== 1 || !d.out.size) continue;
    const [sku, qty] = [...d.in][0];
    if (d.out.has(sku)) continue; // รหัสเดียวกันทั้งเข้าและออก = ย้าย/ปรับ ไม่ใช่การแปลงรหัส
    if (!byOut.has(sku)) byOut.set(sku, []);
    byOut.get(sku).push({ doc: d.doc, date: d.date, qty, sources: [...d.out].map(([s, q]) => ({ sku: s, qty: q })) });
  }
  for (const list of byOut.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return byOut;
}

// ส่วนผสมของชุด → Map รหัสชุด → { children: [{ sku, per }] } · per = จำนวนลูกต่อชุด 1 หน่วย (Σ child_qty ÷ Σ จำนวนชุดในบรรทัดเดียวกัน)
function loadBundles(db) {
  const out = new Map();
  let parents, kids;
  try {
    parents = db.prepare(`WITH k AS (SELECT DISTINCT order_id, seq_num, parent_sku FROM sales_line_components WHERE parent_sku IS NOT NULL AND parent_sku != '')
      SELECT k.parent_sku AS sku, SUM(l.qty) AS qty FROM k JOIN outbound_lines l ON l.order_id = k.order_id AND l.seq_num = k.seq_num
      GROUP BY k.parent_sku`).all();
    kids = db.prepare(`SELECT parent_sku, child_code, SUM(child_qty) AS q FROM sales_line_components
      WHERE parent_sku IS NOT NULL AND parent_sku != '' AND child_code != parent_sku GROUP BY parent_sku, child_code`).all();
  } catch (_) { return out; } // ไม่มีตาราง (ฐานทดสอบเก่า)
  const pq = new Map(parents.map(r => [r.sku, Number(r.qty) || 0]));
  for (const r of kids) {
    const q = Number(r.q) || 0, p = pq.get(r.parent_sku);
    if (!(q > 0) || !(p > 0)) continue;
    if (!out.has(r.parent_sku)) out.set(r.parent_sku, { children: [] });
    out.get(r.parent_sku).children.push({ sku: r.child_code, per: q / p });
  }
  for (const b of out.values()) b.children.sort((a, c) => c.per - a.per);
  return out;
}

function loadNames(db) {
  const m = new Map();
  try { for (const r of db.prepare('SELECT code, name FROM bplus_skus').all()) if (r.name) m.set(r.code, r.name); } catch (_) { /* ไม่มีตาราง Bplus */ }
  for (const r of db.prepare('SELECT code, name FROM products').all()) if (r.name) m.set(r.code, r.name);
  return m;
}

function loadBaseUnits(db) {
  return new Map(db.prepare('SELECT code, unit FROM products').all().map(r => [r.code, normUnit(r.unit)]));
}

// ctx ต่อ db — สร้างใหม่เมื่อข้อมูลทุน/เอกสารแปลง/สินค้าเปลี่ยน (conversion_doc_lines เขียนใหม่ทุกรอบ sync ~5 นาที)
const ctxCache = new WeakMap();
// sales_line_components เขียนใหม่ทุกรอบ sync เหมือน conversion_doc_lines · ฐานที่ไม่มีตารางนี้ = ค่าคงที่
function componentsVersionSql(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sales_line_components'").get();
  return has ? "(SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') FROM sales_line_components)" : "''";
}
function costContext(db) {
  const v = db.prepare(`SELECT (SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') FROM sku_cost_rounds) || '#' ||
    (SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') FROM conversion_doc_lines) || '#' ||
    (SELECT COUNT(*) FROM products) || '#' || ${componentsVersionSql(db)} AS v`).get().v;
  const hit = ctxCache.get(db);
  if (hit && hit.version === v) return hit;
  const ctx = { version: v, idx: loadCostIndex(db), conv: loadConversions(db), baseUnits: loadBaseUnits(db), names: loadNames(db),
    bundles: loadBundles(db) };
  ctxCache.set(db, ctx);
  return ctx;
}

// ── คำนวณ (ฟังก์ชันบริสุทธิ์ รับ ctx — ทดสอบได้โดยไม่ต้องมี db) ───────────────
function ownRowAt(idx, sku, date) {
  const list = idx.get(sku);
  if (!list || !list.length) return null;
  let hit = null;
  for (const r of list) { if (r.eff_date <= date) hit = r; else break; }
  return hit ? { row: hit, estimated: false } : { row: list[0], estimated: true };
}
const pick = (row, basis) => row[BASIS_COL[basis]] ?? row.cost_total;

// ทุนต่อหน่วย target จากทุนที่ตั้งไว้ต่อ row.unit — หน่วยเดียวกันใช้ตรงๆ · ขอเป็นกก. และรู้น้ำหนักต่อหน่วย = หารน้ำหนัก
function costPer(row, value, target) {
  if (!row.unit || !target) return null;
  if (row.unit === target) return value;
  if (target === KG && row.unit_grams > 0) return value / (row.unit_grams / 1000);
  return null;
}

// ทุนทั้ง 3 ฐานของ SKU ณ วันที่ → { costs: { total, depr, base }, unit, grams, source: 'own'|'converted', from, doc, eff_date, estimated, suspect }
// หรือ null (ไม่มีทุน) · ทุนจากการแปลงใช้อัตราส่วนจากเอกสารแปลงล่าสุดที่หาทุนต้นทางได้ครบ (ไม่ขึ้นกับวันขาย — ผลเดียวกันทั้งช่วง)
// ส่วนทุนของต้นทางใช้รอบที่มีผล ณ วันขายเหมือนทุนของตัวเอง
function resolveAll(ctx, sku, date, opt = {}) {
  const day = String(date || '').slice(0, 10);
  const own = ownRowAt(ctx.idx, sku, day);
  if (own) {
    return { costs: { total: pick(own.row, 'total'), depr: pick(own.row, 'depr'), base: pick(own.row, 'base') },
      unit: own.row.unit, grams: own.row.unit_grams ?? null, source: 'own', from: [],
      doc: null, eff_date: own.row.eff_date, estimated: own.estimated, suspect: !!own.row.suspect };
  }
  const docs = ctx.conv.get(sku) || [];
  for (const d of docs) {
    const sum = { total: 0, depr: 0, base: 0 };
    let estimated = false, suspect = false, ok = true;
    for (const s of d.sources) {
      const src = ownRowAt(ctx.idx, s.sku, day);
      const unit = ctx.baseUnits.get(s.sku);
      if (!src || costPer(src.row, 1, unit) == null) { ok = false; break; }
      for (const b of Object.keys(sum)) sum[b] += costPer(src.row, pick(src.row, b), unit) * s.qty;
      estimated = estimated || src.estimated;
      suspect = suspect || !!src.row.suspect;
    }
    if (!ok) continue;
    return { costs: { total: round4(sum.total / d.qty), depr: round4(sum.depr / d.qty), base: round4(sum.base / d.qty) },
      unit: ctx.baseUnits.get(sku) || null, grams: null, source: 'converted',
      from: d.sources.map(s => s.sku), doc: d.doc, eff_date: null, estimated, suspect };
  }
  if (!opt.noBundle) {
    const b = bundleCost(ctx, sku, day);
    if (b) return b;
  }
  return promoPairCost(ctx, sku, day);
}

// ── ชุดราคาพิเศษ คิดจากสินค้าลูก (กติกาข้อ 5) ─────────────────────────
const BUNDLE_MIN_KNOWN = 0.5;
// ทุนต่อ 1 หน่วยที่ขายลูก (แพ็ค) — หน่วยทุนตรงกับหน่วยฐาน / หน่วยปลีกห่อเดียวคนละชื่อ / ทุนต่อกก. × น้ำหนักในชื่อ · ไม่ได้ = null
function childPackCost(ctx, cost, sku) {
  const base = normUnit(ctx.baseUnits.get(sku));
  if (cost.unit && cost.unit === base) return cost.costs;
  if (PACK_UNITS.has(cost.unit) && (!base || PACK_UNITS.has(base))) return cost.costs;
  if (cost.unit === KG) {
    const g = gramsFromName(ctx.names && ctx.names.get(sku));
    if (g) return { total: cost.costs.total * g / 1000, depr: cost.costs.depr * g / 1000, base: cost.costs.base * g / 1000 };
  }
  return null;
}
// สินค้าลูกที่ไม่มีทุนของตัวเอง แต่เป็นสินค้าเดียวกับรหัสพี่น้องที่มีทุน (ผู้ใช้สั่ง 2026-11-18 ให้ 90022-2 / 90023-2 คิดทุนได้)
// sku = รหัสที่ใช้ทุน · grams = น้ำหนักต่อแพ็คของลูก เมื่อรหัสพี่น้องมีทุนต่อกก.
const BUNDLE_CHILD_ALIAS = {
  '80004': { sku: '80004-280' }, // ไส้กรอก&เบค่อนBBQ(เสียบไม้) 4 ไม้ = เบค่อนพันไส้กรอก TGM 280g (4ไม้)
  '10010-114': { sku: '10010-22', grams: 400 }, // แซนวิสแฮม (สไลด์หนา) 400 ก. ← แซนวิสแฮม (สไลด์หนา) ต่อกก.
  '10249-664': { sku: '10249-66', grams: 400 }, // สเต็กแฮมดีเค สูตร4 (สไลซ์S) 400 ก. ← (สไลซ์S) ต่อกก.
};
function childCost(ctx, sku, day) {
  const own = resolveAll(ctx, sku, day, { noBundle: true });
  const per = own && childPackCost(ctx, own, sku);
  if (per) return { per, suspect: own.suspect, sku };
  const alias = BUNDLE_CHILD_ALIAS[sku];
  const cost = alias && resolveAll(ctx, alias.sku, day, { noBundle: true });
  if (!cost) return null;
  if (alias.grams) {
    if (cost.unit !== KG) return null;
    const f = alias.grams / 1000;
    return { per: { total: cost.costs.total * f, depr: cost.costs.depr * f, base: cost.costs.base * f }, suspect: cost.suspect, sku: alias.sku };
  }
  const p = childPackCost(ctx, cost, alias.sku);
  return p ? { per: p, suspect: cost.suspect, sku: alias.sku } : null;
}
function bundleCost(ctx, sku, day) {
  const b = ctx.bundles && ctx.bundles.get(sku);
  if (!b || !b.children.length) return null;
  const sum = { total: 0, depr: 0, base: 0 };
  let all = 0, known = 0, suspect = false;
  const from = [];
  for (const c of b.children) {
    all += c.per;
    const hit = childCost(ctx, c.sku, day);
    if (!hit) continue;
    const { per } = hit, cost = { suspect: hit.suspect };
    known += c.per;
    for (const k of Object.keys(sum)) sum[k] += per[k] * c.per;
    suspect = suspect || cost.suspect;
    if (from.length < 5) from.push(c.sku);
  }
  if (!(all > 0) || known / all < BUNDLE_MIN_KNOWN) return null;
  const scale = all / known; // ลูกที่ไม่มีทุน = ทุนเฉลี่ยของลูกที่มีทุน
  return { costs: { total: round4(sum.total * scale), depr: round4(sum.depr * scale), base: round4(sum.base * scale) },
    unit: normUnit(ctx.baseUnits.get(sku)) || 'แพ็ค', grams: null, source: 'bundle', from, doc: null, eff_date: null,
    estimated: true, suspect, known_pct: Math.round(known / all * 100) };
}

// ── ชุดโปร 1 แถม 1 / แพ็คคู่ (กติกาข้อ 4) ──────────────────────────────
const PROMO_PAIR_RE = /1\s*แถม\s*1|แพ[็]?[คก]\s*คู่/;
const BOXY_UNIT_RE = /^(กล่อง|ลัง|กล|ลง)/;
// ชื่อในตารางสินค้าไม่บอกน้ำหนัก แต่รู้จากหลักฐานอื่น (2026-11-18 ผู้ใช้สั่งผูกชุด 1แถม1 กับรหัสหลัก):
//   10140-A1 "คอทเทจเบค่อน 1แถม1 TGM" — ชื่อในใบกำกับ "คอทเทจเบค่อน 150g (1แถม1)TGM"
//   20167-A "เบค่อนแฮม1แถม1" — ไม่มีน้ำหนักในระบบ · ผู้ใช้ยืนยัน 2026-11-18 ว่าเป็นแพ็ค 150 ก.
const PROMO_PAIR_GRAMS = { '10140-A1': 150, '20167-A': 150 };
// น้ำหนักต่อแพ็คเดี่ยวจากชื่อ: "100กรัม", "90 กรัม", "75g", "130ก.", "(155g.*2)" — ตัวเลขแรกที่ตามด้วยหน่วยกรัม
function gramsFromName(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(กรัม|g\b|g\.|ก\.|ก(?=[\s(]|$))/i);
  const g = m ? Number(m[1]) : NaN;
  return g > 0 && g < 5000 ? g : null;
}
const namePrefix = s => String(s || '').replace(/\s+/g, '').split(/\d/)[0].replace(/[()]/g, '');
function promoPairCost(ctx, sku, day) {
  const name = ctx.names && ctx.names.get(sku);
  if (!name || !PROMO_PAIR_RE.test(name)) return null;
  const unit = ctx.baseUnits.get(sku) || null;
  if (unit && BOXY_UNIT_RE.test(unit)) return null;
  const grams = PROMO_PAIR_GRAMS[sku] || gramsFromName(name);
  const head = String(sku).split('-')[0];
  if (!grams || !head || head === sku) return null;
  if (!ctx.byHead) {
    ctx.byHead = new Map();
    for (const s of ctx.idx.keys()) { const h = String(s).split('-')[0]; if (!ctx.byHead.has(h)) ctx.byHead.set(h, []); ctx.byHead.get(h).push(s); }
  }
  const cands = (ctx.byHead.get(head) || []).filter(s => s !== sku);
  const findHits = (want) => {
    const hits = [];
    for (const s of cands) {
      const own = ownRowAt(ctx.idx, s, day);
      if (!own || !want(s, own.row)) continue;
      hits.push({ sku: s, own });
    }
    return hits;
  };
  // แพ็คเดี่ยวน้ำหนักเท่ากัน (ไม่ใช่หน่วยกล่อง/ลัง/คู่)
  let hits = findHits((s, r) => r.unit && r.unit !== KG && !/^(กล่อง|ลัง|คู่)/.test(r.unit) && Number(r.unit_grams) === grams);
  let per = r => 1;
  if (!hits.length) {
    // ทุนต่อกก. ของสินค้าชื่อขึ้นต้นเดียวกัน × น้ำหนักแพ็ค
    const p = namePrefix(name);
    // ชื่อตรงกันทั้งท่อนก่อน (10270-1 "แฮมหมูผสมไก่ 1000 ก.") ไม่งั้นค่อยรับชื่อที่ขึ้นต้นเหมือน — กันเอาทุนของ (หัว)/(สไลซ์) มาเฉลี่ยปน
    if (p.length >= 4) {
      hits = findHits((s, r) => r.unit === KG && namePrefix(ctx.names.get(s)) === p);
      if (!hits.length) hits = findHits((s, r) => r.unit === KG && namePrefix(ctx.names.get(s)).startsWith(p));
    }
    per = () => grams / 1000;
  }
  if (!hits.length) return null;
  const costs = { total: 0, depr: 0, base: 0 };
  for (const h of hits) for (const b of Object.keys(costs)) costs[b] += pick(h.own.row, b) * per(h.own.row) * 2 / hits.length;
  return { costs: { total: round4(costs.total), depr: round4(costs.depr), base: round4(costs.base) },
    unit, grams: grams * 2, source: 'promo2x', from: hits.map(h => h.sku), doc: null, eff_date: null,
    estimated: hits.some(h => h.own.estimated), suspect: hits.some(h => !!h.own.row.suspect) };
}

// ฐานเดียว → { cost, unit, grams, source, from, doc, eff_date, estimated, suspect } หรือ null
function resolveCost(ctx, sku, date, basis = 'total') {
  if (!isBasis(basis)) throw new Error('basis ไม่ถูกต้อง');
  const all = resolveAll(ctx, sku, date);
  if (!all) return null;
  const { costs, ...rest } = all;
  return { cost: costs[basis], ...rest };
}

// จำนวนของบรรทัดขายในหน่วยเดียวกับทุน — เทียบหน่วยไม่ได้ = null (ไม่ประมาณ)
// cost: { unit, grams } · line: { qty, qty_base, unit_code, base_unit, kg } — qty_base = จำนวนในหน่วยฐาน (qty × TFACTOR), kg = น้ำหนักรวมของบรรทัด (ถ้ารู้)
// ลำดับ: หน่วยฐานก่อนหน่วยขาย เพราะรหัสชุดโปร (TFACTOR ≠ 1) ใช้ชื่อหน่วยขายเดียวกับหน่วยฐานแต่จำนวนจริงคือ qty_base
function costQty(cost, line) {
  if (!cost || !cost.unit) return null;
  const qty = Number(line.qty), qtyBase = Number(line.qty_base), kg = line.kg == null ? null : Number(line.kg);
  if (normUnit(line.base_unit) === cost.unit && Number.isFinite(qtyBase)) return qtyBase;
  if (normUnit(line.unit_code) === cost.unit && Number.isFinite(qty)) return qty;
  if (kg != null && Number.isFinite(kg)) {
    if (cost.unit === KG) return kg;
    if (cost.grams > 0) return kg / (cost.grams / 1000);
  }
  return null;
}
// เทียบหน่วยผ่านน้ำหนัก (หน่วยขาย ≠ หน่วยทุน) ใช้น้ำหนักต่อหน่วยจาก WMS / ชื่อสินค้า ซึ่งบางรหัสผิดหน่วย — ตรวจกับข้อมูลจริง
// 2026-11-16: TS0198 ขายเป็น "แพ" แต่ WMS บอก 10 กก./หน่วย → ทุนขาย 9.4 ล้าน จากยอดขาย 1.2 ล้าน (GP −681%) ดึงกำไรรวมทั้งเดือนลง
// ~8 จุด · ทุนที่ได้จากทางนี้เกิน 3 เท่าของยอดขาย = ถือว่าเทียบหน่วยไม่ได้ (ไม่นับ) แทนที่จะโชว์ขาดทุนปลอม
// ใช้เฉพาะทางน้ำหนัก — หน่วยตรงกันโดยตรงยังใช้ตามจริงเสมอ
const KG_PATH_MAX_COST_RATIO = 3;
// ทางสุดท้าย (2026-11-16, ตรวจหน่วยทั้งปี): หน่วยขายปลีก "ห่อเดียว" คนละชื่อ — Express ขาย "แพ" แต่ Master SKU ตั้งทุนต่อ "ซอง"
// (TS0198 เบค่อน เอโร่ ยอด 22.9 ล้าน: ขาย 339/แพ ทุน 264.91/ซองx1000 = GP 22% · ทางน้ำหนักใช้ไม่ได้เพราะ WMS บอก 10 กก./หน่วย)
// ใช้เฉพาะเมื่อหน่วยตรง/หน่วยฐาน/ทางน้ำหนัก ไม่ได้ทั้งหมด · ไม่รวมกล่อง/ลัง/ชุด (บรรจุหลายห่อ จำนวนต่อหน่วยไม่แน่นอน)
const PACK_UNITS = new Set(['แพ็ค', 'ซอง', 'ถุง', 'ถาด']);
function packQty(cost, line) {
  if (!cost || !PACK_UNITS.has(cost.unit)) return null;
  if (PACK_UNITS.has(normUnit(line.base_unit)) && Number.isFinite(Number(line.qty_base))) return Number(line.qty_base);
  if (PACK_UNITS.has(normUnit(line.unit_code)) && Number.isFinite(Number(line.qty))) return Number(line.qty);
  return null;
}
function kgPathOk(cost, q, amount) {
  return q != null && cost.costs.total * q <= KG_PATH_MAX_COST_RATIO * Math.max(Number(amount) || 0, 0);
}
// ต้นทุนขายของบรรทัดขายหนึ่งบรรทัด = ทุนต่อหน่วย × จำนวนในหน่วยเดียวกับทุน
function lineCost(cost, line) {
  if (!cost || !(cost.cost > 0)) return null;
  const q = costQty(cost, line);
  return q == null ? null : cost.cost * q;
}

const round4 = n => Math.round(n * 10000) / 10000;

module.exports = {
  BASIS_COL, isBasis, KG, normUnit, parseUnit, canSeeCost,
  loadCostIndex, loadConversions, loadBaseUnits, costContext, resolveAll, resolveCost, costQty, lineCost, round4,
  kgPathOk, KG_PATH_MAX_COST_RATIO, packQty,
};
