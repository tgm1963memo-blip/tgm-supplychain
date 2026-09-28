// tss-wms local database (replaces the WMS tables in Supabase). One SQLite file (WMS_DB_PATH), tables
// created from schema.json — generated from the Supabase catalog by tgm-wms/tools/local-backend/gen_schema.mjs.
// Values are converted to/from the shapes PostgREST returns (booleans, parsed JSON, Postgres-style
// timestamps) so the tss-wms client code behaves exactly as it did against Supabase.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));

// Read-only views the WMS reads. Column types are listed so output conversion works like a table's.
const VIEWS = {
  v_wms_pick_queue: {
    sql: `CREATE VIEW IF NOT EXISTS v_wms_pick_queue AS
      SELECT o.id AS order_id, o.order_no, o.customer, o.status, substr(o.created_at, 1, 10) AS order_date, o.created_at,
        count(l.id) AS line_count, COALESCE(sum(l.qty_planned), 0) AS total_qty, COALESCE(sum(l.qty_actual), 0) AS picked_qty,
        max(COALESCE(req_w.required, 0)) AS need_weight, max(COALESCE(req_s.required, 0)) AS need_slice,
        count(a.id) AS actual_rows, COALESCE(sum(a.actual_weight), 0) AS actual_weight_total,
        max(COALESCE(req_w.updated_at, req_s.updated_at, o.created_at)) AS updated_at
      FROM outbound_orders o
      LEFT JOIN outbound_lines l ON l.order_id = o.id
      LEFT JOIN wms_order_process_requirements req_w ON req_w.order_id = o.id AND (req_w.line_id = l.id OR req_w.line_id IS NULL) AND req_w.process_code = 'WEIGH' AND req_w.required = 1
      LEFT JOIN wms_order_process_requirements req_s ON req_s.order_id = o.id AND (req_s.line_id = l.id OR req_s.line_id IS NULL) AND req_s.process_code = 'SLICE' AND req_s.required = 1
      LEFT JOIN wms_pick_actuals a ON a.order_id = o.id AND a.line_id = l.id
      GROUP BY o.id, o.order_no, o.customer, o.status, o.created_at`,
    columns: { order_id: 'uuid', order_no: 'text', customer: 'text', status: 'text', order_date: 'date', created_at: 'ts', line_count: 'int',
      total_qty: 'num', picked_qty: 'num', need_weight: 'bool', need_slice: 'bool', actual_rows: 'int', actual_weight_total: 'num', updated_at: 'ts' },
  },
};

// Tables whose Postgres triggers stamped updated_at on every UPDATE (set_updated_at()).
const TOUCH_UPDATED_AT = new Set(['bookings', 'forecasts', 'prod_orders', 'products', 'sc_users']);

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const SQL_TYPE = { uuid: 'TEXT', text: 'TEXT', date: 'TEXT', ts: 'TEXT', json: 'TEXT', num: 'REAL', int: 'INTEGER', bool: 'INTEGER' };

// ── timestamps: stored as "YYYY-MM-DDTHH:MM:SS.ffffff+00:00" (UTC, fixed width so text order = time order),
//    returned trimmed like PostgREST ("…:24.731+00:00", or no fraction when it is zero)
function normTs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) v = v.toISOString();
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d(?::\d\d)?)(\.\d+)?)?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/i);
  if (m) {
    const off = m[4];
    const utc = !off || /^z$/i.test(off) || /^[+-]00(:?00)?$/.test(off);
    if (utc) {
      const time = (m[2] || '00:00:00').length === 5 ? `${m[2]}:00` : (m[2] || '00:00:00');
      const frac = (m[3] || '.').slice(1).padEnd(6, '0').slice(0, 6);
      return `${m[1]}T${time}.${frac}+00:00`;
    }
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw pgError('22007', `invalid input syntax for type timestamp with time zone: "${s}"`);
  return d.toISOString().replace('Z', '000+00:00');
}
function outTs(v) {
  if (v == null) return null;
  return String(v).replace(/\.(\d*?)0+\+00:00$/, (all, keep) => (keep ? `.${keep}+00:00` : '+00:00'));
}
const nowTs = () => normTs(new Date());
const today = () => new Date().toISOString().slice(0, 10);

function pgError(code, message, status = 400, details = null) {
  const e = new Error(message);
  e.pg = { code, message, details, hint: null };
  e.status = status;
  return e;
}

// Postgres array literal "{a,b}" → ['a','b'] (PostgREST accepts both that and a JSON array for text[])
function parsePgArray(s) {
  const inner = s.trim().replace(/^\{|\}$/g, '');
  if (!inner) return [];
  return inner.match(/("([^"\\]|\\.)*"|[^,]+)/g).map((x) => (x.startsWith('"') ? JSON.parse(x) : x.trim()));
}

function toDb(col, v) {
  if (v === undefined || v === null) return null;
  switch (col.type) {
    case 'bool':
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v === 1 || v === 0) return v;
      if (/^(true|t|yes|on|1)$/i.test(String(v))) return 1;
      if (/^(false|f|no|off|0)$/i.test(String(v))) return 0;
      throw pgError('22P02', `invalid input syntax for type boolean: "${v}"`);
    case 'num': case 'int': {
      if (typeof v === 'string' && v.trim() === '') throw pgError('22P02', `invalid input syntax for type numeric: ""`);
      const n = Number(v);
      if (!Number.isFinite(n)) throw pgError('22P02', `invalid input syntax for type numeric: "${v}"`);
      return n;
    }
    case 'json':
      if (col.array && typeof v === 'string' && v.trim().startsWith('{')) return JSON.stringify(parsePgArray(v));
      return JSON.stringify(v);
    case 'ts': return normTs(v);
    case 'date': return String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

function fromDb(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'bool': return !!v;
    case 'json': try { return JSON.parse(v); } catch { return v; }
    case 'ts': return outTs(v);
    case 'num': case 'int': return typeof v === 'number' ? v : Number(v);
    default: return v;
  }
}

function defaultValue(col) {
  const d = col.default;
  if (!d) return undefined;
  switch (d.kind) {
    case 'uuid': return crypto.randomUUID();
    case 'now': return nowTs();
    case 'today': return today();
    case 'prefixed_id': return `${d.prefix}${today().replace(/-/g, '')}${crypto.randomUUID().slice(0, 6)}`;
    case 'value': return toDb(col, d.value);
    default: return undefined; // serial → SQLite assigns it
  }
}

// SQLite-side defaults too, so rows written with plain SQL (server helpers, tools) get the same values the
// REST layer fills in: fixed-width UTC timestamps, dates, v4 uuids.
const SQL_NOW = `(strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000+00:00')`;
const SQL_UUID = `(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))))`;
function literalDefault(col) {
  const d = col.default;
  if (d?.kind === 'now') return ` DEFAULT ${SQL_NOW}`;
  if (d?.kind === 'today') return ` DEFAULT (date('now'))`;
  if (d?.kind === 'uuid') return ` DEFAULT ${SQL_UUID}`;
  if (!d || d.kind !== 'value') return '';
  const v = toDb(col, d.value);
  return ` DEFAULT ${typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`}`;
}

function tableDdl(name, t) {
  const serialPk = t.pk.length === 1 && t.columns.find((c) => c.name === t.pk[0] && c.default?.kind === 'serial');
  const lines = t.columns.map((c) => {
    if (serialPk && c.name === serialPk.name) return `${q(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    return `${q(c.name)} ${SQL_TYPE[c.type]}${c.nullable ? '' : ' NOT NULL'}${literalDefault(c)}`;
  });
  if (!serialPk && t.pk.length) lines.push(`PRIMARY KEY (${t.pk.map(q).join(', ')})`);
  for (const u of t.uniques) lines.push(`UNIQUE (${u.map(q).join(', ')})`);
  for (const f of t.fks) {
    lines.push(`FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${q(f.refTable)} (${f.refColumns.map(q).join(', ')})${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${q(name)} (\n  ${lines.join(',\n  ')}\n)`;
}

const AUTH_DDL = `
  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, encrypted_password TEXT,
    email_confirmed_at TEXT, banned_until TEXT, raw_user_meta_data TEXT NOT NULL DEFAULT '{}',
    raw_app_meta_data TEXT NOT NULL DEFAULT '{"provider":"email","providers":["email"]}',
    last_sign_in_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_auth_refresh_user ON auth_refresh_tokens(user_id);
  CREATE TABLE IF NOT EXISTS auth_recovery_tokens (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS storage_objects (
    bucket TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT, size INTEGER, owner TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (bucket, name)
  );
`;

function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(AUTH_DDL);
  for (const [name, t] of Object.entries(schema.tables)) {
    db.exec(tableDdl(name, t));
    // columns added to schema.json after the table was first created here
    const have = new Set(db.prepare(`PRAGMA table_info(${q(name)})`).all().map((c) => c.name));
    for (const c of t.columns) {
      if (have.has(c.name)) continue;
      const notNull = !c.nullable && c.default?.kind === 'value' ? ' NOT NULL' : '';
      // SQLite only allows constant defaults on ADD COLUMN; the REST layer still fills now()/uuid ones
      db.exec(`ALTER TABLE ${q(name)} ADD COLUMN ${q(c.name)} ${SQL_TYPE[c.type]}${notNull}${c.default?.kind === 'value' ? literalDefault(c) : ''}`);
    }
    for (const i of t.indexes) {
      db.exec(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(i.name)} ON ${q(name)} (${i.columns.map(q).join(', ')})${i.where ? ` WHERE ${i.where}` : ''}`);
    }
  }
  for (const v of Object.values(VIEWS)) db.exec(v.sql);
  return db;
}

// Column metadata for a table or view: { name → {name, type, array, nullable, default} }
function relation(name) {
  const t = schema.tables[name];
  if (t) return { name, table: t, columns: Object.fromEntries(t.columns.map((c) => [c.name, c])), isView: false };
  const v = VIEWS[name];
  if (v) return { name, table: null, columns: Object.fromEntries(Object.entries(v.columns).map(([n, type]) => [n, { name: n, type }])), isView: true };
  return null;
}

function rowFromDb(rel, row, only) {
  const out = {};
  for (const k of only || Object.keys(row)) {
    const col = rel.columns[k];
    out[k] = col ? fromDb(col.type, row[k]) : row[k];
  }
  return out;
}

// Small in-process change log that stands in for Supabase Realtime: every write through this backend
// appends here and clients poll GET /wms/realtime/v1/changes. `epoch` changes on restart so clients
// know their cursor is stale.
const changeLog = { epoch: crypto.randomUUID(), seq: 0, items: [] };
function recordChange(table, eventType, rows) {
  for (const r of rows.slice(0, 200)) {
    changeLog.items.push({ seq: ++changeLog.seq, table, eventType, new: eventType === 'DELETE' ? {} : r, old: eventType === 'DELETE' ? r : {} });
  }
  if (rows.length > 200) changeLog.items.push({ seq: ++changeLog.seq, table, eventType, new: {}, old: {}, truncated: rows.length });
  if (changeLog.items.length > 5000) changeLog.items.splice(0, changeLog.items.length - 5000);
}

module.exports = { schema, VIEWS, TOUCH_UPDATED_AT, openStore, relation, rowFromDb, toDb, fromDb, defaultValue, normTs, nowTs, pgError, q, changeLog, recordChange };
