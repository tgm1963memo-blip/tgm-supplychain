// ทุนสินค้า + ทุนคาดการณ์จากราคาหมูหน้าฟาร์ม (2026-10-22, พิจารณาอนุมัติโปร เฟส 1)
// ตาราง sku_costs / pig_prices / promo_eval_settings (db/migrations.js) · route: routes/promoCosts.js
//
// สูตร: c(m) = c_now × (1 + pork% × (pig(m) / pig_base − 1))
//   c_now    = ทุนต่อหน่วยขายเดือนล่าสุดที่ ≤ เดือนเริ่มโปร
//   pig_base = ราคาหมูของเดือนที่ทุนนั้นมีผล (actual ก่อน ไม่มีใช้ forecast)
//   pig(m)   = ราคาหมูเดือน m (actual ก่อน ไม่มีใช้ forecast)
// ทุนช่วงโปร c_f = ค่าเฉลี่ย c(m) ถ่วงด้วยจำนวนวันโปรที่ตกในเดือนนั้น
// ข้อมูลขาด → ไม่เดา: ไม่มี pork% / ไม่มีราคาหมู = ใช้ c_now ตรงๆ แล้วติดธงบอกเหตุผล

const DEFAULT_SETTINGS = Object.freeze({
  baseline_days: 56,        // หน้าต่าง baseline ก่อนวันเริ่มโปร
  baseline_min_clean_days: 14, // วันที่ไม่มีโปรอื่นขั้นต่ำ ไม่ถึง = ข้อมูลไม่พอ
  g1_margin_ok: 0.10,       // G1 margin โปร ≥ ค่านี้ = ผ่าน · 0..ค่านี้ = ระวัง · < 0 = ไม่ผ่าน
  g2_cost_rise_warn: 0.03,  // G2 ทุนขึ้นช่วงโปรเกินค่านี้ = ระวัง
  g2_cost_rise_fail: 0.08,  // เกินค่านี้ = ไม่ผ่าน
  g3_breakeven_buffer: 0.10, // G3 forecast ≥ Q* × (1 + ค่านี้) = ผ่าน
  g4_lift_ratio_fail: 1.5,  // G4 lift แผน > lift จริงสูงสุดในอดีต × ค่านี้ = ไม่ผ่าน
});
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = s => MONTH_RE.test(String(s || ''));
const monthOf = d => String(d || '').slice(0, 7);

function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value_json FROM promo_eval_settings').all()) {
    if (!SETTING_KEYS.includes(r.key)) continue;
    try { const v = JSON.parse(r.value_json); if (typeof v === 'number' && Number.isFinite(v)) out[r.key] = v; } catch { /* ค่าเสีย = ใช้ค่าเริ่มต้น */ }
  }
  return out;
}

// ราคาหมูทั้งตาราง → Map month → { actual, forecast }
function pigPriceMap(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT month, kind, price_per_kg FROM pig_prices').all()) {
    if (!m.has(r.month)) m.set(r.month, { actual: null, forecast: null });
    m.get(r.month)[r.kind] = r.price_per_kg;
  }
  return m;
}
const pigFor = (map, month) => { const p = map.get(month); return p ? (p.actual ?? p.forecast ?? null) : null; };

// ทุนล่าสุดของ SKU ที่มีผล ณ เดือน month (null = ไม่มีทุน)
function costRowFor(db, sku, month) {
  return db.prepare('SELECT sku, month, cost, unit, pork_pct FROM sku_costs WHERE sku = ? AND month <= ? ORDER BY month DESC LIMIT 1').get(sku, month) || null;
}

// จำนวนวันของช่วง [start, end] (YYYY-MM-DD) ที่ตกในแต่ละเดือน → [{ month, days }]
function daysByMonth(start, end) {
  const s = new Date(String(start).slice(0, 10) + 'T00:00:00Z'), e = new Date(String(end).slice(0, 10) + 'T00:00:00Z');
  if (!(s <= e)) return [];
  const out = [];
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const m = d.toISOString().slice(0, 7);
    if (out.length && out[out.length - 1].month === m) out[out.length - 1].days++;
    else out.push({ month: m, days: 1 });
  }
  return out;
}

// ฟังก์ชันบริสุทธิ์ (ทดสอบได้โดยไม่ต้องมี db)
// costRow: { cost, pork_pct, month } หรือ null · pigMap: จาก pigPriceMap
function forecastCost(costRow, pigMap, start, end) {
  const flags = [];
  if (!costRow || !(costRow.cost > 0)) return { c_now: null, c_f: null, pig_base: null, cost_month: null, months: [], flags: ['no_cost'] };
  const c_now = costRow.cost;
  const span = daysByMonth(start, end);
  const pork = costRow.pork_pct;
  const pig_base = pigFor(pigMap, costRow.month);
  if (pork == null) flags.push('no_pork_pct');
  else if (pig_base == null) flags.push('no_pig_base');
  const months = span.map(({ month, days }) => {
    const pig = pigFor(pigMap, month);
    let cost = c_now;
    if (pork != null && pig_base != null) {
      if (pig == null) { if (!flags.includes('pig_missing')) flags.push('pig_missing'); }
      else cost = c_now * (1 + pork * (pig / pig_base - 1));
    }
    return { month, days, pig, cost: round4(cost) };
  });
  const totalDays = months.reduce((s, x) => s + x.days, 0);
  const c_f = totalDays ? months.reduce((s, x) => s + x.cost * x.days, 0) / totalDays : c_now;
  return { c_now, c_f: round4(c_f), pig_base, cost_month: costRow.month, pork_pct: pork, months, flags };
}

const round4 = n => Math.round(n * 10000) / 10000;

// สะดวกใช้: ทุนคาดการณ์ของ SKU สำหรับช่วงโปร (เฟส 2 เรียกจาก promoEval.js)
function forecastCostForSku(db, sku, start, end, pigMap = pigPriceMap(db)) {
  return forecastCost(costRowFor(db, sku, monthOf(start)), pigMap, start, end);
}

module.exports = {
  DEFAULT_SETTINGS, SETTING_KEYS, isMonth, monthOf, getSettings,
  pigPriceMap, pigFor, costRowFor, daysByMonth, forecastCost, forecastCostForSku,
};
