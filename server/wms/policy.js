// Row access rules — the local replacement for the Supabase RLS policies on the WMS tables
// (see tgm-wms/supabase/add_route_delivery_rls_policies.sql for the originals). Kept deliberately close to
// what Supabase enforced, with one tightening: every request must be signed in (Supabase let the anon key
// read and write most tables).
//   service key  → everything (express_sync.py, migration tools)
//   DRIVER       → only their own trips/stops/photos, delivery points, their own users row, role_permissions
//   other users  → every table; users/role_permissions writes need a managing role
const { pgError } = require('./store');

const MANAGER_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);
const OWN_TRIPS = `SELECT id FROM delivery_trips WHERE driver_user_id = ?`;
const OWN_STOPS = `SELECT id FROM delivery_stops WHERE trip_id IN (${OWN_TRIPS})`;

// op: select | insert | update | delete
const DRIVER_RULES = {
  delivery_trips: { select: (u) => ({ sql: 'driver_user_id = ?', params: [u.id] }), update: (u) => ({ sql: 'driver_user_id = ?', params: [u.id] }) },
  delivery_stops: { select: (u) => ({ sql: `trip_id IN (${OWN_TRIPS})`, params: [u.id] }), update: (u) => ({ sql: `trip_id IN (${OWN_TRIPS})`, params: [u.id] }) },
  delivery_photos: { select: (u) => ({ sql: `stop_id IN (${OWN_STOPS})`, params: [u.id] }), insert: true },
  customer_delivery_points: { select: true, update: true },
  users: { select: (u) => ({ sql: 'id = ?', params: [u.id] }) },
  role_permissions: { select: true },
};

function denied(table) {
  return pgError('42501', `permission denied for table ${table}`, 403);
}

// Returns an extra WHERE fragment ({sql, params}) or null; throws when the op is not allowed at all.
function scope(ctx, table, op) {
  // tss-wms reads the RBAC matrix once at page load, often before anyone has signed in (App.jsx's boot
  // effect) — on Supabase that returned nothing, so saved role customisations were missed until a reload.
  // The matrix is not sensitive, so it is readable signed-out.
  if (!ctx && table === 'role_permissions' && op === 'select') return null;
  if (!ctx) throw pgError('42501', 'JWT required — please sign in', 401);
  if (ctx.kind === 'service') return null;
  const u = ctx.user;
  if (u.role === 'DRIVER') {
    const rule = DRIVER_RULES[table]?.[op];
    if (!rule) throw denied(table);
    return rule === true ? null : rule(u);
  }
  if ((table === 'users' || table === 'role_permissions') && op !== 'select' && !MANAGER_ROLES.has(u.role)) throw denied(table);
  return null;
}

// Checks values being written (the WITH CHECK half of a policy).
function checkRows(ctx, db, table, op, rows) {
  if (ctx.kind === 'service' || ctx.user.role !== 'DRIVER') return;
  const u = ctx.user;
  const ownsTrip = (id) => !!db.prepare('SELECT 1 FROM delivery_trips WHERE id = ? AND driver_user_id = ?').get(id, u.id);
  const ownsStop = (id) => !!db.prepare(`SELECT 1 FROM delivery_stops WHERE id = ? AND trip_id IN (${OWN_TRIPS})`).get(id, u.id);
  for (const r of rows) {
    if (table === 'delivery_trips' && 'driver_user_id' in r && r.driver_user_id !== u.id) throw denied(table);
    if (table === 'delivery_stops' && 'trip_id' in r && !ownsTrip(r.trip_id)) throw denied(table);
    if (table === 'delivery_photos' && (op === 'insert' || 'stop_id' in r) && !ownsStop(r.stop_id)) throw denied(table);
  }
}

module.exports = { scope, checkRows, MANAGER_ROLES };
