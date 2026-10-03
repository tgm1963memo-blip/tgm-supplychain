// ทีมขาย + สิทธิ์ดูยอดขาย (2026-10-03, ผู้ใช้กำหนด)
//   · ทีมห้าง = แผนกขายธุรกิจค้าปลีก: Sales Director ดูทั้งแผนก, Senior Sales Manager ดูเฉพาะน้องที่เลือก
//   · ทีมร้านค้า = ฝ่ายขายร้านค้า + ธุรกิจค้าส่ง: ผู้จัดการ (Sales Manager) ดูทั้งแผนก
//   · Sales ดูเฉพาะของตัวเอง · ผู้บริหาร/admin/แผนกอื่นที่เป็นผู้จัดการ ดูทั้งหมด
// ตั้งค่าได้ในหน้า จัดการกลุ่ม → 👥 ทีมขาย (entity 'sales_teams' ใน approval_workflow_templates):
//   { teams: [{id, name, depts:[...]}], scopes: { uid: {scope, members:[uid]} } }
//   scope: 'self' | 'dept' | 'team' | 'teams' | 'members' | 'all' — ไม่ได้ตั้ง = ค่าเริ่มต้นตามตำแหน่ง (defaultScope)
//   'teams' (2026-10-03 รองรับการตั้งค่าผู้บริหาร): ดูเฉพาะทีมที่เลือก {teams:[id]} · 'members' ของผู้ที่ไม่อยู่ในทีมขาย
//   (เช่น ผู้บริหาร) เลือกได้จากทุกทีม
// ยอดขายผูกกับผู้ใช้ผ่านรหัส Sales ใน Express (sc_users.slm_codes คั่น ,)
const ENTITY = 'sales_teams';
const SCOPES = ['self', 'dept', 'team', 'teams', 'members', 'all'];
const DEFAULT_TEAMS = [
  { id: 'mt', name: 'ทีมห้าง', depts: ['แผนกขายธุรกิจค้าปลีก'] },
  { id: 'store', name: 'ทีมร้านค้า', depts: ['ฝ่ายขายร้านค้า', 'ธุรกิจค้าส่ง'] },
];
const ALL_ROLES = new Set(['superadmin', 'admin', 'manager', 'planning_manager']);
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const codesOf = u => {
  const raw = String(u?.slm_codes || '').trim();
  const list = raw ? raw.split(',') : (u?.slm_id ? [u.slm_id] : []);
  return [...new Set(list.map(x => String(x).trim()).filter(Boolean))];
};

function loadConfig(db) {
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type = ?').get(ENTITY);
  const v = parse(row?.levels_json);
  const teams = Array.isArray(v?.teams) && v.teams.length ? v.teams : DEFAULT_TEAMS;
  const scopes = v?.scopes && typeof v.scopes === 'object' ? v.scopes : {};
  return { teams, scopes, saved: !!row };
}
function validateConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.teams)) return 'รูปแบบการตั้งค่าทีมไม่ถูกต้อง';
  const ids = new Set(), depts = new Set();
  for (const t of cfg.teams) {
    if (!t || !String(t.id || '').trim() || !String(t.name || '').trim()) return 'กรุณาตั้งชื่อทีมให้ครบ';
    if (ids.has(t.id)) return `รหัสทีม "${t.id}" ซ้ำ`;
    ids.add(t.id);
    for (const d of t.depts || []) { if (depts.has(d)) return `แผนก "${d}" อยู่หลายทีม`; depts.add(d); }
  }
  for (const [uid, s] of Object.entries(cfg.scopes || {})) {
    if (!SCOPES.includes(s?.scope)) return `สิทธิ์ดูยอดของ ${uid} ไม่ถูกต้อง`;
    if (s.members && !Array.isArray(s.members)) return `รายชื่อลูกทีมของ ${uid} ไม่ถูกต้อง`;
    if (s.scope === 'teams' && (!Array.isArray(s.teams) || !s.teams.length)) return `กรุณาเลือกทีมที่ ${uid} ดูได้อย่างน้อย 1 ทีม`;
    if (s.scope === 'teams' && s.teams.some(id => !ids.has(id))) return `ทีมที่เลือกให้ ${uid} ไม่มีอยู่`;
  }
  return null;
}

const teamOfDept = (teams, dept) => teams.find(t => (t.depts || []).includes(dept)) || null;
// ค่าเริ่มต้นตามตำแหน่ง/role (ใช้เมื่อยังไม่ได้ตั้งรายคน)
function defaultScope(u, teams) {
  const pos = String(u.position || '').toLowerCase();
  if (!teamOfDept(teams, u.department)) {
    // แผนกนอกทีมขาย (ผู้บริหาร, พัฒนาระบบ, Audit …): ผู้จัดการ/admin ดูทั้งหมด, อื่นๆ เฉพาะตัวเอง
    return ALL_ROLES.has(u.role) || ['sales_manager', 'manager'].includes(u.role) ? 'all' : 'self';
  }
  if (ALL_ROLES.has(u.role)) return 'all';
  if (/senior\s*sales\s*manager/.test(pos)) return 'members';
  if (/sales\s*director|sales\s*manager/.test(pos)) return 'dept';
  // role ผู้จัดการฝ่ายขาย แต่ตำแหน่งในระบบไม่ใช่ Manager (เช่น ผจก.ธุรกิจค้าส่ง ตำแหน่ง "Sales") = ทั้งแผนก
  if (u.role === 'sales_manager') return 'dept';
  return 'self';
}

function usersOf(db) {
  return db.prepare('SELECT uid, name, role, department, position, slm_id, slm_codes, is_active FROM sc_users').all();
}

// สิทธิ์ดูยอดของผู้ใช้: {scope, source, all, uids, codes, members, team}
function scopeFor(db, uid, cfg = loadConfig(db), users = usersOf(db)) {
  const me = users.find(u => u.uid === uid);
  if (!me) return { scope: 'self', source: 'none', all: false, uids: [], codes: [], members: [] };
  const set = cfg.scopes[uid];
  const scope = set?.scope && SCOPES.includes(set.scope) ? set.scope : defaultScope(me, cfg.teams);
  const team = teamOfDept(cfg.teams, me.department);
  const active = users.filter(u => u.is_active !== 0);
  let pool;
  if (scope === 'all') pool = null;
  else if (scope === 'team') pool = team ? active.filter(u => (team.depts || []).includes(u.department)) : [me];
  else if (scope === 'teams') {
    const depts = new Set(cfg.teams.filter(t => (set?.teams || []).includes(t.id)).flatMap(t => t.depts || []));
    pool = active.filter(u => depts.has(u.department));
  }
  else if (scope === 'dept') pool = active.filter(u => u.department && u.department === me.department);
  else if (scope === 'members') { const m = new Set([uid, ...(set?.members || [])]); pool = active.filter(u => m.has(u.uid)); }
  else pool = [me];
  if (pool && !pool.some(u => u.uid === uid)) pool.push(me);
  const codes = pool ? [...new Set(pool.flatMap(codesOf))] : [];
  return {
    scope, source: set?.scope ? 'set' : 'default', all: !pool, scope_teams: scope === 'teams' ? (set?.teams || []) : [], team: team ? { id: team.id, name: team.name } : null,
    uids: pool ? pool.map(u => u.uid) : [], codes,
    members: pool ? pool.map(u => ({ uid: u.uid, name: u.name, department: u.department || '', position: u.position || '', codes: codesOf(u) })) : [],
  };
}

// ตัวเลือกกรองตามทีม/แผนก (สำหรับผู้ที่ดูได้ทั้งหมด หรือทั้งทีม): [{label, codes}]
function teamFilters(cfg, users, sc) {
  const active = users.filter(u => u.is_active !== 0);
  const out = [];
  const teams = sc.all ? cfg.teams : sc.scope === 'team' && sc.team ? cfg.teams.filter(t => t.id === sc.team.id)
    : sc.scope === 'teams' ? cfg.teams.filter(t => (sc.scope_teams || []).includes(t.id)) : [];
  for (const t of teams) {
    const tu = active.filter(u => (t.depts || []).includes(u.department));
    out.push({ kind: 'team', label: t.name, codes: [...new Set(tu.flatMap(codesOf))] });
    for (const d of t.depts || []) out.push({ kind: 'dept', label: d, codes: [...new Set(tu.filter(u => u.department === d).flatMap(codesOf))] });
  }
  return out;
}

module.exports = { ENTITY, SCOPES, DEFAULT_TEAMS, loadConfig, validateConfig, defaultScope, scopeFor, teamFilters, usersOf, codesOf, teamOfDept };
