'use strict';

// บทบาทพิเศษของใบเคาะราคา (2026-10-12, ผู้ใช้ขอ) — เก็บที่ approval_workflow_templates entity 'promo_roles'
//   keyers:      [uid] ผู้มีสิทธิ์กด "คีย์เข้า Express แล้ว" (ว่าง = admin/superadmin เท่านั้น · superadmin กดได้เสมอ)
//   secretaries: [{ uid, departments: [แผนก] }] เลขาสร้าง/แก้/ส่งอนุมัติใบเคาะแทนทุกคนในแผนกที่ดูแล
// ตั้งค่าที่หน้า ⚙️ ตั้งค่าเส้นทางอนุมัติ (admin) — PUT /api/promo_draft_headers/roles
const ENTITY = 'promo_roles';
const ADMIN_ROLES = ['admin', 'superadmin'];
const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

function loadPromoRoles(db) {
  const row = db.prepare('SELECT levels_json FROM approval_workflow_templates WHERE entity_type = ?').get(ENTITY);
  const v = parse(row?.levels_json) || {};
  return {
    keyers: Array.isArray(v.keyers) ? v.keyers.map(String) : [],
    secretaries: Array.isArray(v.secretaries) ? v.secretaries
      .filter(s => s && s.uid).map(s => ({ uid: String(s.uid), departments: (Array.isArray(s.departments) ? s.departments : []).map(String).filter(Boolean) })) : [],
  };
}

function savePromoRoles(db, input, byUid) {
  const users = new Map(db.prepare('SELECT uid, is_active FROM sc_users').all().map(u => [u.uid, u]));
  const keyers = [...new Set((Array.isArray(input?.keyers) ? input.keyers : []).map(String))];
  const bad = keyers.filter(u => !users.has(u));
  const secretaries = (Array.isArray(input?.secretaries) ? input.secretaries : []).map(s => ({
    uid: String(s?.uid || ''), departments: [...new Set((Array.isArray(s?.departments) ? s.departments : []).map(x => String(x).trim()).filter(Boolean))],
  })).filter(s => s.uid);
  bad.push(...secretaries.filter(s => !users.has(s.uid)).map(s => s.uid));
  if (bad.length) throw new Error(`ไม่พบผู้ใช้: ${[...new Set(bad)].join(', ')}`);
  if (secretaries.some(s => !s.departments.length)) throw new Error('เลขาแต่ละคนต้องเลือกแผนกที่ดูแลอย่างน้อย 1 แผนก');
  const value = JSON.stringify({ keyers, secretaries });
  db.prepare(`INSERT INTO approval_workflow_templates (entity_type, levels_json, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type) DO UPDATE SET levels_json = excluded.levels_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(ENTITY, value, byUid || null);
  require('./customerScope').clearScopeCache(); // สิทธิ์เห็นลูกค้าของเลขาเปลี่ยนทันที
  return loadPromoRoles(db);
}

function isAdmin(user) { return !!user && ADMIN_ROLES.includes(user.role); }

function isKeyer(db, user) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  const { keyers } = loadPromoRoles(db);
  return keyers.length ? keyers.includes(user.uid) : user.role === 'admin';
}

// แผนกที่ผู้ใช้นี้เป็นเลขา ([] = ไม่ใช่เลขา)
function secretaryDepartments(db, uid) {
  return loadPromoRoles(db).secretaries.filter(s => s.uid === uid).flatMap(s => s.departments);
}

// ผู้ใช้ที่ actor สร้าง/จัดการใบเคาะแทนได้ (ไม่รวมตัวเอง) — admin = ทุกคน · เลขา = คนในแผนกที่ดูแล
function membersFor(db, actor) {
  if (!actor) return [];
  const all = db.prepare('SELECT uid, name, role, department, position FROM sc_users WHERE is_active = 1 ORDER BY name').all();
  if (isAdmin(actor)) return all.filter(u => u.uid !== actor.uid);
  const depts = new Set(secretaryDepartments(db, actor.uid));
  return depts.size ? all.filter(u => u.uid !== actor.uid && depts.has(String(u.department || ''))) : [];
}

function canActFor(db, actor, targetUid) {
  if (!actor || !targetUid) return false;
  if (actor.uid === targetUid || isAdmin(actor)) return true;
  return membersFor(db, actor).some(u => u.uid === targetUid);
}

// เจ้าของเอกสาร (ผู้สร้าง) หรือเลขาที่สร้างแทน/ดูแลแผนกของผู้สร้าง หรือ admin
function canManageDraft(db, header, user) {
  if (!header || !user) return false;
  if (header.created_by === user.uid || header.created_by_actual === user.uid || isAdmin(user)) return true;
  return canActFor(db, user, header.created_by);
}

module.exports = { ENTITY, loadPromoRoles, savePromoRoles, isAdmin, isKeyer, secretaryDepartments, membersFor, canActFor, canManageDraft };
