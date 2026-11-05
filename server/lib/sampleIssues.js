'use strict';

// ประวัติเบิกสินค้าตัวอย่าง / ของชิม / ของแถม จาก Express (2026-11-05, ผู้ใช้ขอ — เมนู "ของตัวอย่าง" › ประวัติเบิก)
// แหล่งข้อมูล (ตรวจกับ DBF จริง 2026-11-05):
//   · ห้อง TSS-NV ม.ค.–มิ.ย. 69: LA เปิดบิลของตัวอย่าง · LB เปิดบิลของชิม · LD เปิดบิลของแถม-ไส้กรอก (มีลูกค้า/เซลส์ในใบ
//     ยกเว้น LA ที่ PEOPLE = รหัสพนักงานผู้เบิก 01-IH-xxxx และเซลส์ถูกคีย์เป็น 101 ทั้งเล่ม → จับคู่ผู้เบิกกับเซลส์ด้วยตาราง)
//   · ห้อง TSS ก.ค. 69 เป็นต้นไป: KB เบิกของตัวอย่าง · KA เบิกของชิม-ไส้กรอก · PD เบิกของแถม (POSOPR 6 — ไม่มีลูกค้า/เซลส์
//     มีแค่แผนก DEPCOD และหมายเหตุ STTRN.REMARK / ARTRNRM → อ่านชื่อเซลส์/เชนห้างจากหมายเหตุ ที่เหลือให้ผู้จัดการระบุ)
//   · ห้อง TSS ทั้งปี: LE ใบเบิกของแถม (มีลูกค้า/เซลส์ในใบ)
// ไม่อ่าน TSS-68 / TSSN-68: มีข้อมูล ม.ค.–เม.ย. 69 ซ้ำกับ TSS / TSS-NV
// มูลค่า: ทุน = STCRD.XTRNVAL (TRNVAL ของบางเล่มเป็น 0) · ราคาขาย = ราคาต่อหน่วยในบิล (LB/LD/LE) หรือราคาขายแรกที่ > 0 ของสินค้า
// "/P" ท้ายหมายเหตุ = ผู้คีย์/สถานะเอกสาร (ผู้ใช้ยืนยัน 2026-11-05) — ตัดทิ้งก่อนอ่าน ไม่ใช่ชื่อเจ้าของ

const SAMPLE_YEAR = 2026;
const SOURCES = [
  { company: 'TSS-NV', prefixes: ['LA', 'LB', 'LD'] },
  { company: 'TSS', prefixes: ['KA', 'KB', 'PD', 'LE'] },
];
const KIND_BY_PREFIX = { LA: 'sample', KB: 'sample', LB: 'tasting', KA: 'tasting', LD: 'free', PD: 'free', LE: 'free' };
const BILLED_PREFIXES = new Set(['LB', 'LD', 'LE']); // ราคาต่อหน่วยในบิลเป็นราคาขายจริง
const REMARK_PREFIXES = new Set(['KA', 'KB', 'PD']); // ไม่มีเซลส์/ลูกค้าในใบ — อ่านจากหมายเหตุ
const PERSON_PREFIXES = new Set(['LA']); // PEOPLE = พนักงานผู้เบิก

const CHAINS = [
  ['The Mall', /the\s*mall|เดอะ\s*มอลล์|พารากอน|เอ็มควอ|เอ็มโพ/i],
  ['Makro', /makro|แม็คโคร|แมคโคร|แม็กโคร/i],
  ['Big C', /big\s*-?\s*c\b|บิ๊กซี|bigc/i],
  ['Tops', /tops|ท็อปส์|ท๊อปส์/i],
  ['วิลล่า', /วิลล่า|villa/i],
  ['ริมปิง', /ริมปิง|ตันตรา|ตัณตรา/i],
  ['โลตัส', /โลตัส|lotus/i],
  ['ซีพี แอ็กซ์ตร้า', /ซีพี|\bcp\b/i],
];

const T = s => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// ตัด "/P" (หรือ "P " นำหน้า) ที่เป็นรหัสผู้คีย์/สถานะเอกสาร
function stripKeyerTag(remark) {
  return T(remark).replace(/\s*\/\s*P\s*$/i, '').replace(/^P\s+/, '').trim();
}

// ชื่อเล่นจากชื่อเซลส์ใน Express (OESLM) เช่น "ห้าง-ครีม.0960875229" → "ครีม" · "คุณอุ้ม.091..." → "อุ้ม"
function nickFromSlmName(name) {
  const m = T(name).replace(/^ห้าง\s*-\s*/, '').replace(/^คุณ/, '').match(/^[ก-๙]+/);
  return m ? m[0] : '';
}
// ชื่อเล่นในวงเล็บของบัญชีผู้ใช้ เช่น "คุณปิยพร คุ้มวงษ์ (คุณครีม)" → "ครีม"
function nickFromUserName(name) {
  const m = T(name).match(/\(([^)]+)\)\s*$/);
  if (!m) return '';
  const w = m[1].replace(/^คุณ/, '').match(/^[ก-๙]+/);
  return w ? w[0] : '';
}

// ชื่อเล่น → รหัสเซลส์ · salesmen: [{slm_id,name}] (Express) · users: [{name, slm_id, slm_codes}] (บัญชีผู้ใช้)
// ชื่อเล่นที่ชี้ไปหลายรหัสถือว่ากำกวม — ไม่ใช้
function buildNickMap(salesmen = [], users = []) {
  const cand = new Map();
  const add = (nick, code) => {
    if (!nick || nick.length < 2 || !code) return;
    if (!cand.has(nick)) cand.set(nick, new Set());
    cand.get(nick).add(code);
  };
  for (const s of salesmen) {
    const code = T(s.slm_id);
    if (!/^\d{3}(-\d)?$/.test(code) || /^\*+/.test(T(s.name))) continue;
    add(nickFromSlmName(s.name), code);
  }
  for (const u of users) {
    const codes = T(u.slm_codes || u.slm_id).split(',').map(T).filter(c => /^\d{3}(-\d)?$/.test(c));
    const main = T(u.slm_id) || codes[0];
    if (main) add(nickFromUserName(u.name), main.length === 3 && codes.includes(`${main}-1`) ? `${main}-1` : main);
  }
  const out = new Map();
  for (const [nick, set] of cand) if (set.size === 1) out.set(nick, [...set][0]);
  return out;
}

// หาเซลส์จากหมายเหตุ: "(เซลล์ ครีม)" / "เซลส์คุณเมย์" / "เซล:นก" — ต้องมีคำว่าเซล นำหน้าชื่อเล่น
function slmFromRemark(text, nickMap) {
  const re = /เซล(?:ล์|ส์|ล)?\s*[:\-]?\s*(?:คุณ|พี่|น้อง)?\s*([ก-๙]+)/g;
  const keys = [...nickMap.keys()].sort((a, b) => b.length - a.length);
  let m;
  while ((m = re.exec(text))) {
    const word = m[1];
    const hit = keys.find(k => word === k) || keys.find(k => word.startsWith(k));
    if (hit) return nickMap.get(hit);
  }
  return '';
}
function chainFromRemark(text) {
  const hit = CHAINS.find(([, re]) => re.test(text));
  return hit ? hit[0] : '';
}

// ผลการอ่านหมายเหตุของใบ KA/KB/PD → { slm, cust_name, src }
function resolveFromRemark(headerRemark, lineRemarks, nickMap) {
  const head = stripKeyerTag(headerRemark);
  const all = `${head} ${T(lineRemarks)}`;
  const slm = slmFromRemark(all, nickMap);
  const chain = chainFromRemark(head);
  const office = !chain && /ออฟ(?:ฟิ|ฟิศ|ฟิต|ิศ)|office/i.test(head);
  const cust_name = chain ? `${chain} (จากหมายเหตุ)` : office ? 'ออฟฟิศ' : (head || '(ไม่มีหมายเหตุ)');
  const src = slm ? 'remark' : chain ? 'chain' : office ? 'office' : 'none';
  return { slm, cust_name, src };
}

// ราคาขายของบรรทัด: บิล LB/LD/LE ใช้ราคาในบิล · อื่นๆ ใช้ราคาขายของสินค้า (หน่วยไม่ตรง = คูณ TFACTOR เป็นหน่วยหลัก)
function sellValue(prefix, r, product) {
  const qty = Number(r.TRNQTY) || 0;
  const unitPr = Number(r.UNITPR) || 0;
  if (BILLED_PREFIXES.has(prefix) && unitPr > 0) return round2(unitPr * qty);
  const price = Number(product?.price) || 0;
  if (!price) return null;
  const sameUnit = !product.unit || T(product.unit) === T(r.TQUCOD);
  return round2(price * qty * (sameUnit ? 1 : (Number(r.TFACTOR) || 1)));
}
const round2 = n => Math.round(n * 100) / 100;

function isoDate(d) {
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  const s = T(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

// แปลงบรรทัด STCRD ของห้องหนึ่ง → แถว sample_issue_lines
// ctx: { company, prefixes:Set, cancelled:Set, headerRemarks:Map, lineRemarks:Map, nickMap, products:Map(sku→{price,unit,name}),
//        custNames:Map, normalizeSlm }
function buildLines(rows, ctx) {
  const out = [];
  for (const r of rows) {
    const doc = T(r.DOCNUM);
    const prefix = doc.slice(0, 2).toUpperCase();
    if (!ctx.prefixes.has(prefix) || ctx.cancelled.has(doc)) continue;
    const date = isoDate(r.DOCDAT);
    if (!date || +date.slice(0, 4) !== SAMPLE_YEAR) continue;
    const sku = T(r.STKCOD);
    const product = ctx.products.get(sku);
    const people = T(r.PEOPLE);
    let slm = '', custCode = '', custName = '', src = 'doc';
    if (REMARK_PREFIXES.has(prefix)) {
      const res = resolveFromRemark(ctx.headerRemarks.get(doc), ctx.lineRemarks.get(doc), ctx.nickMap);
      ({ slm, src } = res);
      custName = res.cust_name;
    } else if (PERSON_PREFIXES.has(prefix)) {
      custCode = people;
      custName = `(ผู้เบิก) ${T(ctx.custNames.get(people) || people).replace(/\s*\(.*$/, '')}`;
      src = 'person'; // เจ้าของมาจาก sample_person_slm_map ตอนอ่าน (ดู view)
    } else {
      custCode = people;
      custName = T(ctx.custNames.get(people)) || people;
      slm = ctx.normalizeSlm ? ctx.normalizeSlm(r.SLMCOD) : T(r.SLMCOD);
      if (!slm) src = 'none';
    }
    out.push({
      company: ctx.company, doc_num: doc, seq: T(r.SEQNUM), doc_date: date, prefix, kind: KIND_BY_PREFIX[prefix],
      sku, loc_code: T(r.LOCCOD), sku_name: T(product?.name) || T(r.STKDES), qty: round2(Number(r.TRNQTY) || 0), unit: T(r.TQUCOD),
      cost_value: round2(Number(r.XTRNVAL) || 0), sell_value: sellValue(prefix, r, product),
      cust_code: custCode, cust_name: custName, slm_code: slm, dept_code: T(r.DEPCOD),
      remark: REMARK_PREFIXES.has(prefix) ? T(ctx.headerRemarks.get(doc)) : '', owner_src: src,
    });
  }
  return out;
}

// ── ชื่อลูกค้าจากหมายเหตุ → ลูกค้าในระบบ (2026-11-05, ผู้ใช้ขอ "ใช้ชื่อเดียวกับในระบบ ถ้าไม่มีให้ใช้ชื่อจากหมายเหตุ") ──────────
// ใบ KA/KB/PD: STTRN.REMARK เช่น "The Mall/บางแค/สาย21", "สห ลอว์สัน/P" · ใบ LA: ARTRNRM (มีแค่ ~1% ของใบ — ที่เหลือไม่มีชื่อลูกค้าใน Express)
// ข้อมูลลูกค้ามีรหัสซ้ำหลายรหัสต่อสาขา (เดอะมอลล์ 7 (บางแค) ~8 รหัส) จึงเลือกแบบระวัง:
//   1) ลูกค้าของเซลส์เจ้าของใบ (customers.slm_id) — ยอมรับเมื่อได้รายเดียว หรือหลายรายแต่เลือกจากยอดขายปีนี้ได้
//   2) ลูกค้าทั้งหมด — ยอมรับเฉพาะรายที่มียอดขายจริงปีนี้ (กันจับชื่อคน/รหัสเก่าที่ไม่ใช้แล้ว) เลือกยอดสูงสุด
// ใช้ตั้งชื่อ/จัดกลุ่มในหน้าเว็บเท่านั้น ไม่ใช้กำหนดสิทธิ์ (สิทธิ์ยังตามเจ้าของใบ)
const CUST_MATCH_VERSION = 2;
const CHAIN_ALIAS = {
  'The Mall': ['เดอะมอลล์', 'themall', 'เดอะมอล'],
  'Makro': ['แม็คโคร', 'makro', 'แมคโคร', 'แม็กโคร'],
  'Big C': ['บิ๊กซี', 'bigc'],
  'Tops': ['ท็อปส์', 'tops', 'ท๊อปส์'],
  'วิลล่า': ['วิลล่า', 'villa'],
  'ริมปิง': ['ตันตราภัณฑ์', 'ริมปิง', 'ตัณตราภัณฑ์'],
  'โลตัส': ['โลตัส', 'lotus'],
  'ซีพี แอ็กซ์ตร้า': ['ซีพีแอ็กซ์ตร้า', 'ซีพีแอ็กซ์คร้า', 'cpaxtra'],
};
// สาขาในกลุ่มเดอะมอลล์ที่เป็นบริษัทแยก ("The Mall/เอ็มควอเทียร์") → ชื่อขึ้นต้นของลูกค้าในระบบ (เอ็ม ควอเทียร์ จำกัด ฯลฯ)
const MALL_SUB = { 'เอ็มควอเทียร์': 'เอ็มควอเทียร์', 'เอ็มโพเรียม': 'เอ็มโพเรียม', 'พารากอน': 'สยามพารากอน', 'สยามพารากอน': 'สยามพารากอน',
  'พรอมานาด': 'พรอมานาด', 'โพรมานาด': 'พรอมานาด', 'เดอะพรอมานาด': 'พรอมานาด' };
const normCust = s => T(s).toLowerCase()
  .replace(/บริษัท|บจก\.?|บ\.|หจก\.?|ห้างหุ้นส่วนจำกัด|จำกัด|มหาชน|ร้าน|คุณ|สาขา|สนญ\.?|co\.?,?\s*ltd\.?|ltd\.?/g, ' ')
  .replace(/[^0-9a-z฀-๿]+/g, '');
// ส่วนของหมายเหตุที่เป็นชื่อปลายทาง: ตัด /P (ผู้คีย์), สายรถ, "เซลล์ส่ง…", "เบิกให้…"
const NOISE_RE = /สาย\s*\S+|เซล(?:ล์|ส์|ล)?\s*ส่ง.*|ส่งเอง.*|ด่วน|^ว่าง$|^เบิก(?:ไป)?ให้\s*|รับของ.*|ขอรับ.*/g;
// คำกลางๆ ที่ไม่ใช่ชื่อลูกค้า — ห้ามใช้จับชื่อ (เคยจับ "ลูกค้า/เมกาบางนา" ไปเป็น "ลูกค้าเงินสด..Tiktok")
const GENERIC_PARTS = new Set(['ลูกค้า', 'คุณ', 'พี่', 'น้อง', 'เซลล์', 'เซลส์', 'สินค้า', 'ตัวอย่าง', 'p', 'm', 'm1', 'mei']);
function remarkParts(remark) {
  const seen = new Set();
  return stripKeyerTag(remark).split(/[\/,]/).map(s => T(s.replace(NOISE_RE, '')))
    .filter(s => s && !/^\d/.test(s) && !GENERIC_PARTS.has(s.toLowerCase()))
    .filter(s => { const k = normCust(s); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}
// ชื่อสำหรับแสดงเมื่อหาลูกค้าในระบบไม่ได้ = หมายเหตุที่ตัดส่วนเกินแล้ว (เชนในชื่อมาตรฐาน)
function displayFromRemark(remark) {
  const parts = remarkParts(remark);
  if (!parts.length) return '';
  const shown = parts.map(p => { const c = Object.entries(CHAIN_ALIAS).find(([, al]) => al.some(a => normCust(p) === a)); return c ? c[0] : p; });
  return [...new Set(shown)].join(' / ');
}
// customers: [{code, name, slm_id, sales}] — sales = ยอดขายปีนี้ (ใช้เลือกรหัสที่ยังใช้งานจริง)
function buildCustIndex(customers) {
  return customers.filter(c => !/^01-I[AH]-/.test(c.code)) // รหัสภายใน (พนักงาน/งานออกบูธ)
    .map(c => ({ code: c.code, name: T(c.name), slm: T(c.slm_id), sales: Number(c.sales) || 0, n: normCust(c.name) }))
    .filter(c => c.n.length >= 3);
}
function matchCustomer(remark, ownerSlm, idx) {
  const segs = remarkParts(remark).map(normCust).filter(s => s.length >= 3);
  if (!segs.length) return null;
  const chain = Object.values(CHAIN_ALIAS).find(al => segs.some(s => al.some(a => s.includes(a))));
  const hitsIn = (pool, minLen) => {
    if (chain) {
      const branch = segs.filter(s => !chain.some(a => s.includes(a)) || s.length > Math.max(...chain.map(a => a.length)) + 2)
        .map(s => chain.reduce((x, a) => x.replace(a, ''), s)).filter(s => s.length >= 3);
      if (!branch.length) return []; // รู้แค่เชน ไม่รู้สาขา
      // ชื่อต้องขึ้นต้นด้วยชื่อเชน — กัน "ไทยยามาซากิ (สาขาเดอะมอลล์บางแค)" ถูกนับเป็นเดอะมอลล์บางแค
      const subs = chain === CHAIN_ALIAS['The Mall'] ? branch.map(b => MALL_SUB[b]).filter(Boolean) : [];
      return pool.filter(c => (chain.some(a => c.n.startsWith(a)) && branch.some(b => c.n.includes(b))) || subs.some(p => c.n.startsWith(p)));
    }
    return pool.filter(c => segs.some(s => c.n === s || (s.length >= minLen && c.n.includes(s)) || (c.n.length >= minLen && s.includes(c.n))));
  };
  const pick = (hits, needSales) => {
    if (!hits.length) return null;
    const ranked = [...hits].sort((a, b) => b.sales - a.sales || a.code.localeCompare(b.code));
    if (ranked[0].sales > 0) return ranked[0];
    if (needSales) return null;
    return new Set(ranked.map(h => h.n)).size === 1 ? ranked[0] : null; // ไม่มียอดเลย: ยอมรับเมื่อชื่อเดียวกันทั้งหมด
  };
  const own = ownerSlm ? pick(hitsIn(idx.filter(c => c.slm === ownerSlm), 4), false) : null;
  const hit = own || pick(hitsIn(idx, 6), true);
  return hit ? { code: hit.code, name: hit.name } : null;
}

module.exports = {
  SAMPLE_YEAR, SOURCES, KIND_BY_PREFIX, stripKeyerTag, nickFromSlmName, nickFromUserName, buildNickMap,
  slmFromRemark, chainFromRemark, resolveFromRemark, sellValue, buildLines,
  CUST_MATCH_VERSION, normCust, remarkParts, displayFromRemark, buildCustIndex, matchCustomer,
};
