'use strict';

// พิจารณาอนุมัติโปร เฟส 2 (2026-10-27) — Baseline / Pre (forecast) / Post (ยอดจริง) / ROI / เกณฑ์ G1–G6 ต่อ SKU ของใบเคาะราคา
// แผน: C:\Users\TSS\.claude\plans\1-baseline-composed-rain.md · ทุน: lib/promoCost.js · route: routes/promoEval.js
//
// หน่วยวิเคราะห์ = SKU × สาขาทั้งหมดในเอกสาร เพราะ estimated_qty ในใบเคาะเป็นยอดคาดการณ์ "ต่อ SKU ทั้งเอกสาร"
// (หน้าแก้ไขเขียนค่าเดียวกันลงทุกแถวสาขา — index.html saveLines)
//
// ปริมาณขาย: sales_transactions กฎเดียวกับคอลัมน์ "ปริมาณขายช่วงก่อน" ในหน้าแก้ไข (draftRefreshLineRefData)
//   · สาขา BB- และสาขาคู่ CONSI (01-L2-0001 ↔ BB-L2-0001) → ยอดส่งสินค้าเข้าฝากขาย (company = CONSI)
//   · SKU ที่ไม่มียอด CONSI เลยในช่วง baseline → ยอดขาย TSS/TGM ของสาขาในเอกสาร (company ≠ CONSI)
//   ใช้แหล่งเดียวกันทั้ง baseline และยอดจริงช่วงโปร เพื่อให้เทียบกันได้
//
// Baseline B = ยอดเฉลี่ยต่อวันในหน้าต่าง baseline_days ก่อนวันเริ่มโปร ไม่นับวันที่ SKU นั้นมีโปรอื่น
//   (promo_docs ของสาขาในเอกสาร + ใบเคาะอื่นที่ส่งอนุมัติ/อนุมัติแล้ว) × จำนวนวันโปร · วันสะอาด < ขั้นต่ำ = ไม่คำนวณ
//
// เศรษฐศาสตร์ต่อหน่วย (ไม่รวม VAT): p_n = ทุนสุทธิราคาปกติ (รายได้ TGM), p_p = ทุนสุทธิราคาโปร
//   ใบ Compensate ไม่มีทุนสุทธิโปร → p_p = p_n − compensate ÷ 1.07 (สมมติฐาน: TGM คืน compensate ต่อชิ้นที่ขาย)
//   c = ทุนคาดการณ์ช่วงโปร · K = ค่าใช้จ่ายอื่นของเอกสาร (other_costs_json) กระจายตามมูลค่าคาดการณ์ F × p_p
//   m_n = p_n − c · m_p = p_p − c · เงินลงทุนโปร I(Q) = (p_n − p_p)·Q + K
//   กำไรส่วนเพิ่ม ΔGP(Q) = m_p·Q − m_n·B − K · ROI = ΔGP / I · จุดคุ้มทุน Q* = (m_n·B + K) / m_p
//
// ข้อมูลขาด = ไม่เดา: เกณฑ์นั้นเป็น 'na' พร้อมเหตุผล และไม่นับในผลแนะนำ

const { getSettings, pigPriceMap, costRowFor, forecastCost, monthOf } = require('./promoCost');
const { overlapsFor } = require('./promoOverlap');

const ACTIVE_DRAFT = ['pending_approval', 'pending_exec_approval', 'approved', 'keyed_to_express'];
const pj = (v, d) => { if (v && typeof v !== 'string') return v; try { return JSON.parse(v || 'null') ?? d; } catch { return d; } };
const inList = n => Array.from({ length: n }, () => '?').join(',');
const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const mean = arr => { const xs = arr.filter(x => x != null); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; };

const isoDay = d => d.toISOString().slice(0, 10);
const parseDay = s => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const addDays = (s, n) => { const d = parseDay(s); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
function dayList(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = parseDay(from), e = parseDay(to); d <= e; d.setUTCDate(d.getUTCDate() + 1)) out.push(isoDay(d));
  return out;
}
// สาขาคู่ฝั่ง CONSI — กฎเดียวกับ _draftConsiPairCode ใน index.html
const consiPair = code => { const m = String(code || '').trim().match(/^[^-]+-(.+-.+)$/); return m ? `BB-${m[1]}` : ''; };

// ยอดรายวันต่อ SKU: Map sku → Map day → qty
function dailyQty(db, codes, skus, from, to, consi) {
  const out = new Map(skus.map(s => [s, new Map()]));
  if (!codes.length || !skus.length || from > to) return out;
  for (let i = 0; i < codes.length; i += 400) {
    const part = codes.slice(i, i + 400);
    db.prepare(`SELECT sku, substr(tx_date, 1, 10) AS d, SUM(qty) AS q FROM sales_transactions
      WHERE sku IN (${inList(skus.length)}) AND cust_code IN (${inList(part.length)}) AND tx_date >= ? AND tx_date <= ?
        AND company ${consi ? "= 'CONSI'" : "<> 'CONSI'"}
      GROUP BY sku, d`).all(...skus, ...part, from, to + '\uffff').forEach(r => {
      const m = out.get(r.sku); if (!m) return;
      m.set(r.d, (m.get(r.d) || 0) + (Number(r.q) || 0));
    });
  }
  return out;
}

// วันที่ SKU มีโปรอื่นในช่วง [from, to]: Map sku → Set(day)
function promoDays(db, header, codes, skus, from, to) {
  const out = new Map(skus.map(s => [s, new Set()]));
  if (!codes.length || !skus.length || from > to) return out;
  const mark = (sku, s, e) => {
    const set = out.get(sku); if (!set || !s || !e) return;
    for (const d of dayList(s > from ? s : from, e < to ? e : to)) set.add(d);
  };
  for (let i = 0; i < codes.length; i += 400) {
    const part = codes.slice(i, i + 400);
    db.prepare(`SELECT sku, start_date, due_date FROM promo_docs
      WHERE sku IN (${inList(skus.length)}) AND cust_code IN (${inList(part.length)}) AND due_date >= ? AND start_date <= ?`)
      .all(...skus, ...part, from, to).forEach(r => mark(r.sku, r.start_date, r.due_date));
    db.prepare(`SELECT d.sku, COALESCE(d.start_date, h.start_date) AS s, COALESCE(d.due_date, h.due_date) AS e, h.cancelled_skus_json
      FROM promo_drafts d JOIN promo_draft_headers h ON h.draft_no = d.draft_no
      WHERE d.draft_no <> ? AND h.status IN (${inList(ACTIVE_DRAFT.length)})
        AND d.sku IN (${inList(skus.length)}) AND d.cust_code IN (${inList(part.length)})`)
      .all(header.draft_no, ...ACTIVE_DRAFT, ...skus, ...part).forEach(r => {
        if (pj(r.cancelled_skus_json, []).includes(r.sku)) return;
        if (r.s && r.e && r.e >= from && r.s <= to) mark(r.sku, r.s, r.e);
      });
  }
  return out;
}

const KG_UNIT = /กก|กิโล|kg/i;

// เกณฑ์รายตัว → { key, status: ok|warn|fail|na, value, note }
function criteria(x, s, overlapSkus) {
  const out = [];
  const c = (key, status, value, note) => out.push({ key, status, value: value ?? null, note });
  // G1 margin โปรด้วยทุนคาดการณ์
  if (x.c == null) c('G1', 'na', null, 'ไม่มีทุนสินค้า');
  else if (x.p_p == null) c('G1', 'na', null, 'ไม่มีราคาทุนสุทธิโปร');
  else {
    const mg = x.p_p > 0 ? x.m_p / x.p_p : null;
    if (mg == null) c('G1', 'fail', null, 'ราคาโปรเป็น 0');
    else c('G1', mg < 0 ? 'fail' : mg < s.g1_margin_ok ? 'warn' : 'ok', round(mg, 4), mg < 0 ? 'ขายต่ำกว่าทุน' : `margin โปร ${round(mg * 100, 1)}%`);
  }
  // G2 ทุนขึ้นช่วงโปร
  if (x.cost?.c_now == null) c('G2', 'na', null, 'ไม่มีทุนสินค้า');
  else if (x.cost.flags.includes('no_pork_pct')) c('G2', 'na', null, 'ยังไม่มี %เนื้อหมู');
  else if (x.cost.flags.includes('no_pig_base')) c('G2', 'na', null, 'ไม่มีราคาหมูเดือนของทุน');
  else {
    const rise = x.cost.c_f / x.cost.c_now - 1;
    const partial = x.cost.flags.includes('pig_missing') ? ' (บางเดือนไม่มีราคาหมู)' : '';
    c('G2', rise > s.g2_cost_rise_fail ? 'fail' : rise > s.g2_cost_rise_warn ? 'warn' : 'ok', round(rise, 4), `ทุนช่วงโปร ${rise >= 0 ? '+' : ''}${round(rise * 100, 1)}%${partial}`);
  }
  // G3 forecast ถึงจุดคุ้มทุน
  if (x.F == null) c('G3', 'na', null, 'ไม่ได้กรอกจำนวนคาดการณ์');
  else if (x.B == null) c('G3', 'na', null, 'baseline ข้อมูลไม่พอ');
  else if (x.m_p == null) c('G3', 'na', null, 'ไม่มีทุนหรือราคาโปร');
  else if (x.m_p <= 0) c('G3', 'fail', null, 'ขายต่ำกว่าทุน ไม่มีจุดคุ้มทุน');
  else {
    const r = x.Qstar > 0 ? x.F / x.Qstar : null;
    if (r == null) c('G3', 'ok', null, 'คุ้มทุนตั้งแต่ชิ้นแรก');
    else c('G3', r < 1 ? 'fail' : r < 1 + s.g3_breakeven_buffer ? 'warn' : 'ok', round(r, 3), `forecast = ${round(r, 2)} เท่าของจุดคุ้มทุน`);
  }
  // G4/G5 ต้องมีผลโปรที่ปิดแล้ว (เฟส 4)
  c('G4', 'na', null, 'ยังไม่มีประวัติผลโปร');
  c('G5', 'na', null, 'ยังไม่มีประวัติผลโปร');
  // G6 ช่วงเวลาซ้อน
  c('G6', overlapSkus.has(x.sku) ? 'fail' : 'ok', null, overlapSkus.has(x.sku) ? 'มีโปรอื่นช่วงเวลาซ้อน' : 'ไม่ซ้อน');
  return out;
}
// ผลแนะนำ: มีข้อไม่ผ่าน = ขาดทุน · ประเมิน G1 ได้และไม่มีข้อไม่ผ่าน = ขายได้ · อื่นๆ = ข้อมูลไม่พอ (null)
function suggest(list) {
  if (list.some(c => c.status === 'fail')) return 'loss';
  const g1 = list.find(c => c.key === 'G1');
  return g1 && g1.status !== 'na' ? 'profit' : null;
}
const worst = list => (list.some(c => c.status === 'fail') ? 'fail' : list.some(c => c.status === 'warn') ? 'warn' : list.some(c => c.status === 'ok') ? 'ok' : 'na');

function evaluate(db, draftNo, opts = {}) {
  const header = db.prepare('SELECT * FROM promo_draft_headers WHERE draft_no = ?').get(draftNo);
  if (!header) return null;
  const today = opts.today || isoDay(new Date());
  const s = getSettings(db);
  const start = header.start_date, due = header.due_date;
  const base = { draft_no: draftNo, generated_at: new Date().toISOString(), today, settings: s, flags: [] };
  if (!start || !due || start > due) return { ...base, flags: ['no_period'], skus: [], totals: null };

  const cancelled = new Set(pj(header.cancelled_skus_json, []));
  const lines = db.prepare('SELECT * FROM promo_drafts WHERE draft_no = ?').all(draftNo).filter(l => l.sku && !cancelled.has(l.sku));
  if (!lines.length) return { ...base, flags: ['no_lines'], skus: [], totals: null };

  const custCodes = [...new Set(lines.map(l => l.cust_code).filter(Boolean))];
  const consiCodes = [...new Set(custCodes.filter(c => !/^BB-/i.test(c)).map(consiPair).filter(Boolean))];
  const shipCodes = [...new Set([...custCodes.filter(c => /^BB-/i.test(c)), ...consiCodes])];
  const skus = [...new Set(lines.map(l => l.sku))];

  const promoLen = dayList(start, due).length;
  const winFrom = addDays(start, -s.baseline_days), winTo = addDays(start, -1);
  const actualTo = due < today ? due : addDays(today, -1); // วันนี้ยังขายไม่จบวัน
  const status = today <= start ? 'not_started' : today > due ? 'ended' : 'running';
  const fetchTo = actualTo > winTo ? actualTo : winTo;
  const qtyConsi = dailyQty(db, shipCodes, skus, winFrom, fetchTo, true);
  const qtySales = dailyQty(db, custCodes, skus, winFrom, fetchTo, false);
  const busy = promoDays(db, header, [...new Set([...custCodes, ...consiCodes])], skus, winFrom, winTo);
  const winDays = dayList(winFrom, winTo < addDays(today, -1) ? winTo : addDays(today, -1));
  const overlapSkus = new Set();
  try { overlapsFor(db, header).forEach(o => o.skus.forEach(k => overlapSkus.add(k))); } catch { /* ข้อมูลซ้อนอ่านไม่ได้ = ไม่ติดธง */ }

  const pigMap = pigPriceMap(db);
  const costMonth = monthOf(start);
  const otherCosts = pj(header.other_costs_json, []).reduce((t, c) => t + (num(c?.amount) || 0), 0);

  const rows = skus.map(sku => {
    const ls = lines.filter(l => l.sku === sku);
    const sum = (m, days) => days.reduce((t, d) => t + (m.get(d) || 0), 0);
    const consiWin = sum(qtyConsi.get(sku), winDays);
    const source = shipCodes.length && consiWin > 0 ? 'consi' : 'sales';
    const daily = source === 'consi' ? qtyConsi.get(sku) : qtySales.get(sku);
    const clean = winDays.filter(d => !busy.get(sku).has(d));
    const avg = clean.length >= s.baseline_min_clean_days ? sum(daily, clean) / clean.length : null;
    const B = avg == null ? null : avg * promoLen;
    const elapsed = status === 'not_started' ? 0 : dayList(start, actualTo).length;
    const A = status === 'not_started' ? null : sum(daily, dayList(start, actualTo));
    const F = mean(ls.map(l => num(l.estimated_qty)));

    const p_n = mean(ls.map(l => num(l.cost_price)));
    let p_p = mean(ls.map(l => num(l.cost_price_promo)));
    const comp = mean(ls.map(l => num(l.compensate)));
    const xflags = [];
    if (p_p == null && p_n != null && comp != null) { p_p = p_n - comp / 1.07; xflags.push('p_p_from_compensate'); }

    const crow = costRowFor(db, sku, costMonth);
    const cost = forecastCost(crow, pigMap, start, due);
    let c = cost.c_f;
    const weight = mean(ls.map(l => num(l.weight)));
    if (c != null && crow?.unit && KG_UNIT.test(crow.unit) && weight > 0) { c *= weight; xflags.push('cost_per_kg_x_weight'); }

    return { sku, sku_name: ls[0].sku_name || '', branches: new Set(ls.map(l => l.cust_code)).size, source, xflags,
      baseline: { from: winFrom, to: winTo, window_days: winDays.length, clean_days: clean.length, promo_days: busy.get(sku).size, avg_daily: avg },
      B, F, A, elapsed, p_n, p_p, compensate: comp, cost, c };
  });

  // K กระจายตามมูลค่าคาดการณ์ (ไม่มี F/p_p ครบ = เฉลี่ยเท่ากัน)
  const wts = rows.map(r => (r.F != null && r.p_p != null ? Math.max(r.F * r.p_p, 0) : null));
  const allW = wts.every(w => w != null) && wts.reduce((t, w) => t + w, 0) > 0;
  const wSum = allW ? wts.reduce((t, w) => t + w, 0) : rows.length;

  const out = rows.map((r, i) => {
    const K = otherCosts * (allW ? wts[i] : 1) / wSum;
    const m_n = r.p_n != null && r.c != null ? r.p_n - r.c : null;
    const m_p = r.p_p != null && r.c != null ? r.p_p - r.c : null;
    const disc = r.p_n != null && r.p_p != null ? r.p_n - r.p_p : null;
    const econ = (Q, Bq) => {
      if (Q == null || m_p == null || m_n == null || Bq == null || disc == null) return null;
      const I = disc * Q + K, dGP = m_p * Q - m_n * Bq - K;
      return { investment: round(I), incremental_gp: round(dGP), roi: I > 0 ? round(dGP / I, 4) : null };
    };
    const Qstar = m_p > 0 && m_n != null && r.B != null ? (m_n * r.B + K) / m_p : null;
    const x = { sku: r.sku, F: r.F, B: r.B, c: r.c, p_p: r.p_p, m_p, Qstar, cost: r.cost };
    const crit = criteria(x, s, overlapSkus);
    // ยอดจริงเทียบ baseline ช่วงวันที่ผ่านไปแล้ว (โปรยังวิ่งอยู่ = ใช้เฉพาะวันที่ผ่านมา)
    const Bel = r.baseline.avg_daily == null || !r.elapsed ? null : r.baseline.avg_daily * r.elapsed;
    return {
      sku: r.sku, sku_name: r.sku_name, branches: r.branches, source: r.source, flags: [...r.xflags, ...r.cost.flags],
      baseline: { ...r.baseline, avg_daily: round(r.baseline.avg_daily, 3) },
      qty: { baseline: round(r.B, 1), forecast: r.F, actual: r.A, actual_days: r.elapsed, baseline_elapsed: round(Bel, 1),
        lift_plan: r.B > 0 && r.F != null ? round(r.F / r.B - 1, 4) : null,
        lift_actual: Bel > 0 && r.A != null ? round(r.A / Bel - 1, 4) : null,
        accuracy: r.F > 0 && r.A != null && status === 'ended' ? round(r.A / r.F, 4) : null },
      unit: { p_n: round(r.p_n, 4), p_p: round(r.p_p, 4), compensate: r.compensate, c_now: r.cost.c_now, c_f: round(r.c, 4),
        pork_pct: r.cost.pork_pct ?? null, pig_base: r.cost.pig_base, cost_month: r.cost.cost_month, cost_months: r.cost.months,
        m_n: round(m_n, 4), m_p: round(m_p, 4) },
      other_cost: round(K),
      breakeven_qty: round(Qstar, 1), breakeven_x: Qstar != null && r.B > 0 ? round(Qstar / r.B, 3) : null,
      pre: econ(r.F, r.B), post: econ(r.A, Bel),
      criteria: crit, status: worst(crit), suggestion: suggest(crit),
    };
  });

  const agg = k => {
    if (out.some(o => o[k] == null)) return null;
    const I = out.reduce((t, o) => t + o[k].investment, 0), d = out.reduce((t, o) => t + o[k].incremental_gp, 0);
    return { investment: round(I), incremental_gp: round(d), roi: I > 0 ? round(d / I, 4) : null };
  };
  const counts = { ok: 0, warn: 0, fail: 0, na: 0 };
  out.forEach(o => counts[o.status]++);
  return {
    ...base,
    header: { doc_no: header.doc_no, promo_no: header.promo_no, promo_name: header.promo_name, status: header.status },
    period: { start, due, days: promoLen, status, actual_to: status === 'not_started' ? null : actualTo },
    branches: { cust_codes: custCodes.length, ship_codes: shipCodes.length },
    other_costs_total: round(otherCosts),
    skus: out,
    totals: { pre: agg('pre'), post: agg('post'), counts, status: out.some(o => o.status === 'fail') ? 'fail' : out.some(o => o.status === 'warn') ? 'warn' : out.some(o => o.status === 'ok') ? 'ok' : 'na' },
  };
}

// snapshot ตอนส่งอนุมัติ — ผู้อนุมัติ/ผู้ตรวจย้อนหลังเห็นตัวเลขชุดเดียวกับตอนส่ง (ไม่เปลี่ยนตามไฟล์ทุนที่อัปโหลดทีหลัง)
function saveSnapshot(db, draftNo, uid) {
  const payload = evaluate(db, draftNo);
  if (!payload) return null;
  db.prepare('INSERT INTO promo_eval_snapshots (draft_no, created_by, payload_json) VALUES (?, ?, ?)').run(draftNo, uid || null, JSON.stringify(payload));
  return payload;
}
function latestSnapshot(db, draftNo) {
  const r = db.prepare('SELECT id, created_at, created_by, payload_json FROM promo_eval_snapshots WHERE draft_no = ? ORDER BY id DESC LIMIT 1').get(draftNo);
  return r ? { id: r.id, created_at: r.created_at, created_by: r.created_by, payload: pj(r.payload_json, null) } : null;
}

module.exports = { evaluate, saveSnapshot, latestSnapshot, consiPair, dayList, addDays };
