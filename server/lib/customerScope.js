'use strict';

// สิทธิ์การเห็นลูกค้า/ยอดขาย/ใบโปร ฝั่ง server (2026-10-06, ผู้ใช้ขอ) — รวม 2 แหล่ง:
//   1) รหัส Sales ใน Express ตามทีมขาย (lib/salesTeams.js scopeFor) — ร้านค้าทั่วไป ฯลฯ เหมือนเดิม
//   2) เจ้า Modern Trade จากไฟล์ "รหัสใบเคาะ ใบโปร Modern trade" (promo_code_map คอลัมน์ N ชื่อเซลล์ / O ชื่อผู้จัดการ)
//      ชื่อในไฟล์ → ผู้ใช้ ผ่านตารางจับคู่ entity 'mt_assign_people' { map: { "sales:<ชื่อ>": uid, "mgr:<ชื่อ>": uid } }
// ผู้ใช้เห็นแถวของเจ้า MT เมื่อ: ชื่อเซลล์ของแถวจับคู่กับผู้ใช้ในทีมที่ตัวเองดูแล (รวมตัวเอง) หรือชื่อผู้จัดการของแถวคือตัวเอง
// ลูกค้าแต่ละรหัสมีแถวเจ้าของแถวเดียว = ruleForCode(ทุกแถว, code) — กฎเดียวกับเลขที่ใบเคาะ (รองรับคู่ BB- และ "ถึงสุดท้าย")
// ผู้ที่ไม่จำกัด (all): สิทธิ์ทีมขาย = ทั้งหมด หรือไม่ใช่ฝ่ายขาย (planning/warehouse/บัญชีระบบ ฯลฯ — ไม่เคยถูกจำกัดมาก่อน)
const st = require('./salesTeams');
const { loadCodeMap, ruleForCode } = require('./promoNumber');

const PEOPLE_ENTITY = 'mt_assign_people';
const SALES_ROLES = new Set(['sales', 'sales_manager', 'sales_officer', 'sales_worker']);
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

function loadPeople(db) {
  const row = db.prepare('SELECT levels_json, updated_at FROM approval_workflow_templates WHERE entity_type = ?').get(PEOPLE_ENTITY);
  const v = parse(row?.levels_json) || {};
  return { map: v.map && typeof v.map === 'object' ? v.map : {}, updated_at: row?.updated_at || '' };
}

// เวอร์ชันการตั้งค่า — ใช้ล้าง cache และให้หน้าเว็บรู้ว่าต้องโหลดรายชื่อลูกค้าใหม่
function configVersion(db) {
  const r = db.prepare(`SELECT group_concat(entity_type || ':' || COALESCE(updated_at, ''), '|') AS v FROM approval_workflow_templates
    WHERE entity_type IN ('sales_teams', 'promo_code_map', ?)`).get(PEOPLE_ENTITY);
  const u = db.prepare("SELECT MAX(updated_at) AS v FROM sc_users").get();
  return `${r?.v || ''}#${u?.v || ''}`;
}

// รหัสลูกค้าทั้งหมด → แถวเจ้าของ (index ใน rules) · cache 5 นาที หรือจนกว่าตาราง code map เปลี่ยน
let ownerCache = { key: '', at: 0, byRule: null };
function codesByRule(db, rules, mapKey) {
  if (ownerCache.byRule && ownerCache.key === mapKey && Date.now() - ownerCache.at < 5 * 60 * 1000) return ownerCache.byRule;
  const byRule = new Map();
  if (rules.length) {
    const codes = db.prepare(`SELECT code FROM customers UNION SELECT DISTINCT cust_code FROM invoice_sales_monthly
      UNION SELECT code FROM bplus_customers`).all().map(r => r.code).filter(Boolean);
    const idx = new Map(rules.map((r, i) => [r, i]));
    for (const c of codes) {
      const r = ruleForCode(rules, c);
      if (!r) continue;
      const i = idx.get(r);
      if (!byRule.has(i)) byRule.set(i, []);
      byRule.get(i).push(c);
    }
  }
  ownerCache = { key: mapKey, at: Date.now(), byRule };
  return byRule;
}

// แถวเจ้า MT ที่ผู้ใช้เห็น (index) + บทบาทที่ทำให้เห็น
function mtRulesFor(rules, people, uid, poolUids) {
  const pool = new Set(poolUids && poolUids.length ? poolUids : [uid]);
  const out = [];
  rules.forEach((r, i) => {
    const salesHit = (r.sales || []).map(n => people.map[`sales:${n}`]).filter(Boolean);
    const mgrHit = (r.manager || []).some(n => people.map[`mgr:${n}`] === uid);
    const via = salesHit.includes(uid) ? 'sales' : mgrHit ? 'manager' : salesHit.some(u => pool.has(u)) ? 'team' : null;
    if (via) out.push({ i, via });
  });
  return out;
}

let scopeCache = new Map(); // uid -> {ver, at, scope}
function resolveScope(db, user) {
  if (!user || !user.uid) return { all: false, restricted: true, slmCodes: [], mtCodes: [], ownCustCodes: [], uids: [], chains: [] };
  const ver = configVersion(db);
  const hit = scopeCache.get(user.uid);
  if (hit && hit.ver === ver && Date.now() - hit.at < 60 * 1000) return hit.scope;
  const cfg = st.loadConfig(db), users = st.usersOf(db);
  let sc = st.scopeFor(db, user.uid, cfg, users);
  // เลขาแผนก (2026-10-12, lib/promoRoles.js): เห็นลูกค้า/ยอดของทุกคนในแผนกที่ดูแล — เพื่อเลือกสาขาให้ใบเคาะที่สร้างแทนได้
  const roles = require('./promoRoles');
  if (!sc.all && roles.secretaryDepartments(db, user.uid).length) {
    const subs = roles.membersFor(db, user).map(m => st.scopeFor(db, m.uid, cfg, users));
    sc = subs.some(x => x.all) ? { ...sc, all: true } : { ...sc,
      codes: [...new Set([...(sc.codes || []), ...subs.flatMap(x => x.codes || [])])],
      uids: [...new Set([...(sc.uids || [user.uid]), ...subs.flatMap(x => x.uids || [])])] };
  }
  const me = users.find(u => u.uid === user.uid) || user;
  const salesSide = SALES_ROLES.has(me.role) || !!st.teamOfDept(cfg.teams, me.department);
  let scope;
  if (sc.all || !salesSide || me.role === 'service_readonly') {
    scope = { all: true, restricted: false, version: ver };
  } else {
    const cm = loadCodeMap(db), people = loadPeople(db);
    const mine = mtRulesFor(cm.rules, people, user.uid, sc.uids);
    const byRule = codesByRule(db, cm.rules, `${cm.imported_at}|${cm.rules.length}`);
    const mtCodes = [...new Set(mine.flatMap(m => byRule.get(m.i) || []))];
    const slmCodes = sc.codes || [];
    const own = new Set(mtCodes);
    const masterCodes = [];
    if (slmCodes.length) {
      db.prepare(`SELECT code FROM customers WHERE slm_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(slmCodes)).forEach(r => { own.add(r.code); masterCodes.push(r.code); });
      // ลูกค้าที่ขายจริงตามใบกำกับ (2026-10-12): ลูกค้าบางรายผูกกับรหัส Sales อื่นใน master แต่ใบกำกับออกในชื่อเรา
      // (เช่น ท็อปส์ 01-MT-0006 ผูก 206 แต่ขายโดย 207) — ต้องเห็นชื่อ/กลุ่มของลูกค้าที่ตัวเองมียอด ไม่งั้นขึ้นเป็นรหัสใน "ยังไม่ถูกระบุ"
      db.prepare(`SELECT DISTINCT cust_code FROM invoice_sales_monthly WHERE ym >= '2024-01' AND slm_code IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(slmCodes)).forEach(r => r.cust_code && own.add(r.cust_code));
    }
    scope = {
      all: false, restricted: true, version: ver, uids: sc.uids || [user.uid], slmCodes, mtCodes, masterCodes, ownCustCodes: [...own],
      chains: mine.map(m => { const r = cm.rules[m.i]; return { name: r.name, cls: r.cls, src: r.src, via: m.via, codes: (byRule.get(m.i) || []).length }; }),
    };
  }
  scopeCache.set(user.uid, { ver, at: Date.now(), scope });
  return scope;
}

// ── ตัวช่วย SQL (คืน null = ไม่ต้องกรอง) ───────────────────────────────────────────────────────
// ตารางยอดขาย: แถวของรหัส Sales ที่ดูได้ (เหมือนเดิม) หรือของลูกค้าเจ้า MT ที่ดูได้
// หรือใบกำกับที่ไม่มีรหัส Sales ("(none)" / ว่าง) ของลูกค้าที่ master ผูกกับรหัส Sales ที่ดูได้ (2026-10-19, ผู้ใช้แจ้ง
// "ลูกค้าของแด้มาไม่ครบ" — 19 ลูกค้าในไฟล์ Group มีใบกำกับที่ Express ไม่ได้ใส่ SLMCOD ไม่ขึ้นในมุมมองของเซลล์เจ้าของ)
// blankToOwner ต้องขอเอง (code review): ใช้กับตารางใบกำกับ Express เท่านั้น — แหล่งที่ไม่มีรหัส Sales เลยโดยธรรมชาติ
// (Bplus โรงงาน / ฝากขาย / ห้อง SKU ที่เก็บ '(none)' ทุกแถว) ต้องไม่ถูกนับให้เซลล์ตาม master
function factSql(scope, { cust = 'cust_code', slm = 'slm_code', blankToOwner = false } = {}) {
  if (!scope || scope.all) return null;
  const base = `${slm} IN (SELECT value FROM json_each(?)) OR ${cust} IN (SELECT value FROM json_each(?))`;
  const params = [JSON.stringify(scope.slmCodes), JSON.stringify(scope.mtCodes)];
  if (!blankToOwner) return { sql: `(${base})`, params };
  return { sql: `(${base} OR (COALESCE(TRIM(${slm}), '') IN ('', '(none)') AND ${cust} IN (SELECT value FROM json_each(?))))`,
    params: [...params, JSON.stringify(scope.masterCodes || [])] };
}
// ตารางที่มีแต่รหัสลูกค้า
function custSql(scope, col = 'cust_code') {
  if (!scope || scope.all) return null;
  return { sql: `${col} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(scope.ownCustCodes)] };
}
function canSeeCust(scope, code) {
  if (!scope || scope.all) return true;
  if (!scope._own) Object.defineProperty(scope, '_own', { value: new Set(scope.ownCustCodes), enumerable: false });
  return scope._own.has(code);
}

// ใบเคาะ: เห็นเมื่อ ผู้สร้าง/ผู้คีย์ · ผู้อนุมัติ (ขั้นปัจจุบัน/ประวัติ) · ผู้อนุมัติการยกเลิก · หรือมีสาขาใดสาขาหนึ่งที่มองเห็น
function draftParticipant(header, uid) {
  if (!header) return false;
  if (header.created_by === uid || header.created_by_actual === uid || header.keyed_by === uid) return true;
  const levels = [...(parse(header.levels_json) || []), ...(parse(header.approval_history_json) || [])];
  if (levels.some(l => (l?.approvers || []).some(a => a.uid === uid))) return true;
  const cx = parse(header.cancel_request_json);
  if (cx && (cx.approver_uid === uid || cx.requested_by === uid)) return true;
  return (parse(header.cancel_history_json) || []).some(c => c.approver_uid === uid || c.requested_by === uid);
}
// draft_no ที่มองเห็นทั้งหมด (สำหรับกรองตารางลูกของใบเคาะ) — null = ทั้งหมด
// (2026-10-12, ผู้ใช้ขอ "เห็นเฉพาะของตัวเองหรือที่เกี่ยวข้อง"): admin/superadmin เห็นทั้งหมด · คนอื่นเห็นเมื่อ
// ผู้สร้าง/เลขาที่สร้างแทนหรือดูแลแผนกของผู้สร้าง · ผู้อนุมัติ/ผู้เกี่ยวข้องการยกเลิก · ผู้คีย์ · ผู้มีสิทธิ์คีย์ Express เห็นใบที่อนุมัติแล้ว
// เลิกใช้กฎ "มีสาขาที่มองเห็น" — scope ไม่ถูกใช้แล้ว (คงพารามิเตอร์ไว้ให้ผู้เรียกเดิม)
function visibleDraftNos(db, scope, uid, user) {
  const roles = require('./promoRoles');
  const u = user || db.prepare('SELECT uid, role FROM sc_users WHERE uid = ?').get(uid) || { uid };
  if (roles.isAdmin(u)) return null;
  const keyer = roles.isKeyer(db, u);
  const members = new Set(roles.membersFor(db, u).map(x => x.uid));
  const out = [];
  for (const h of db.prepare('SELECT * FROM promo_draft_headers').all()) {
    // ไม่มีเส้นทางอนุมัติ (levels ว่าง) = ผู้จัดการคนใดก็อนุมัติได้ (promoApproval) → ผู้จัดการต้องเห็นใบที่รออนุมัติแบบนี้
    const noRoutePending = ['pending_approval', 'pending_exec_approval'].includes(h.status) && !(parse(h.levels_json) || []).length
      && ['manager', 'sales_manager'].includes(u.role);
    if (draftParticipant(h, uid) || (h.created_by && members.has(h.created_by)) || noRoutePending
      || (keyer && ['approved', 'keyed_to_express'].includes(h.status))) out.push(h.draft_no);
  }
  return out;
}

function clearScopeCache() { scopeCache = new Map(); ownerCache = { key: '', at: 0, byRule: null }; }

module.exports = { PEOPLE_ENTITY, SALES_ROLES, loadPeople, resolveScope, factSql, custSql, canSeeCust, draftParticipant, visibleDraftNos,
  mtRulesFor, codesByRule, configVersion, clearScopeCache };
