// PostgREST-compatible subset at /wms/rest/v1 — what supabase-js (tss-wms) and scripts/express_sync.py send.
// Supported: select (column lists, no embeds), filters eq/neq/gt/gte/lt/lte/like/ilike/in/is/ov/cs (+ not.),
// order (asc/desc, nulls first/last), limit/offset, count=exact, single-object Accept header, insert,
// upsert (merge/ignore duplicates, on_conflict), update, delete, return=representation/minimal, rpc.
const express = require('express');
const store = require('./store');
const policy = require('./policy');

const { q, pgError, relation, rowFromDb, toDb, defaultValue, nowTs, recordChange } = store;
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function splitList(s) { // a,b,"c,d" → ['a','b','c,d']
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function colOf(rel, name) {
  const c = rel.columns[name];
  if (!c) throw pgError('42703', `column ${rel.name}.${name} does not exist`);
  return c;
}

function likeToGlob(p) {
  return p.replace(/[[\]*?]/g, (ch) => `[${ch}]`).replace(/%/g, '*').replace(/_/g, '?');
}

function filterSql(rel, colName, raw) {
  const col = colOf(rel, colName);
  let neg = false, s = raw;
  if (s.startsWith('not.')) { neg = true; s = s.slice(4); }
  const dot = s.indexOf('.');
  if (dot < 0) throw pgError('PGRST100', `failed to parse filter (${raw})`);
  const op = s.slice(0, dot), val = s.slice(dot + 1);
  const c = q(colName);
  let sql, params = [];
  switch (op) {
    case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte': {
      const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      sql = `${c} ${sym} ?`; params = [toDb(col, val)]; break;
    }
    case 'like': sql = `${c} GLOB ?`; params = [likeToGlob(val.replace(/\*/g, '%'))]; break;
    case 'ilike': sql = `${c} LIKE ? ESCAPE '\\'`; params = [val.replace(/\*/g, '%')]; break;
    case 'in': {
      const items = splitList(val.replace(/^\(|\)$/g, ''));
      if (!items.length || (items.length === 1 && items[0] === '')) { sql = '0'; break; }
      sql = `${c} IN (${items.map(() => '?').join(',')})`; params = items.map((x) => toDb(col, x)); break;
    }
    case 'is':
      if (val === 'null') sql = `${c} IS NULL`;
      else if (val === 'true') sql = `${c} = 1`;
      else if (val === 'false') sql = `${c} = 0`;
      else throw pgError('PGRST100', `failed to parse filter (${raw})`);
      break;
    case 'ov': case 'cs': {
      const items = val.startsWith('{') ? splitList(val.replace(/^\{|\}$/g, '')) : JSON.parse(val);
      if (!items.length) { sql = op === 'ov' ? '0' : '1'; break; }
      const ph = items.map(() => '?').join(',');
      sql = op === 'ov'
        ? `EXISTS (SELECT 1 FROM json_each(${c}) WHERE value IN (${ph}))`
        : `(SELECT count(DISTINCT value) FROM json_each(${c}) WHERE value IN (${ph})) = ${new Set(items).size}`;
      params = items.map(String); break;
    }
    default: throw pgError('PGRST100', `unsupported filter operator "${op}"`);
  }
  return { sql: neg ? `NOT (${sql})` : sql, params };
}

function parseQuery(req) {
  const qs = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  const filters = [], meta = {};
  for (const [k, v] of qs) {
    if (RESERVED.has(k)) meta[k] = v;
    else if (k === 'or' || k === 'and') throw pgError('PGRST100', `"${k}" filters are not supported by the local backend`);
    else filters.push([k, v]);
  }
  return { filters, meta };
}

function whereClause(rel, filters, extra) {
  const parts = [], params = [];
  for (const [k, v] of filters) { const f = filterSql(rel, k, v); parts.push(f.sql); params.push(...f.params); }
  if (extra) { parts.push(`(${extra.sql})`); params.push(...extra.params); }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params, userFilters: filters.length };
}

function projection(rel, select) {
  if (!select || select.trim() === '*') return null;
  const cols = select.split(',').map((s) => s.trim()).filter(Boolean);
  if (cols.includes('*')) return null;
  for (const c of cols) {
    if (/[():!]/.test(c)) throw pgError('PGRST100', `embedded/aliased select "${c}" is not supported by the local backend`);
    colOf(rel, c);
  }
  return cols;
}

function orderClause(rel, order) {
  if (!order) return '';
  const parts = order.split(',').map((term) => {
    const [name, ...mods] = term.trim().split('.');
    colOf(rel, name);
    const desc = mods.includes('desc');
    const nulls = mods.includes('nullsfirst') ? 'FIRST' : mods.includes('nullslast') ? 'LAST' : (desc ? 'FIRST' : 'LAST');
    return `${q(name)} ${desc ? 'DESC' : 'ASC'} NULLS ${nulls}`;
  });
  return `ORDER BY ${parts.join(', ')}`;
}

function prefer(req) {
  const p = {};
  for (const tok of String(req.headers.prefer || '').split(',')) {
    const [k, v] = tok.trim().split('=');
    if (k) p[k] = v;
  }
  return p;
}

const wantsObject = (req) => String(req.headers.accept || '').includes('application/vnd.pgrst.object+json');

function sendRows(req, res, rows, status, total, offset = 0) {
  const range = rows.length ? `${offset}-${offset + rows.length - 1}` : '*';
  res.set('Content-Range', `${range}/${total ?? '*'}`);
  if (wantsObject(req)) {
    if (rows.length !== 1) {
      return res.status(406).json({ code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
    }
    return res.status(status).json(rows[0]);
  }
  if (req.method === 'HEAD') return res.status(status).end();
  return res.status(status).json(rows);
}

function sqliteToPg(e, table) {
  if (e.pg) return e;
  const m = String(e.message || e);
  let u;
  if ((u = m.match(/UNIQUE constraint failed: (.+)$/))) {
    const cols = u[1].split(',').map((s) => s.trim().split('.').pop());
    return pgError('23505', `duplicate key value violates unique constraint "${table}_${cols.join('_')}_key"`, 409, `Key (${cols.join(', ')}) already exists.`);
  }
  if ((u = m.match(/NOT NULL constraint failed: \S+\.(\S+)/))) return pgError('23502', `null value in column "${u[1]}" of relation "${table}" violates not-null constraint`);
  if (/FOREIGN KEY constraint failed/.test(m)) return pgError('23503', `insert or update on table "${table}" violates foreign key constraint`, 409);
  if ((u = m.match(/no such column: (\S+)/))) return pgError('42703', `column ${u[1]} does not exist`);
  return pgError('XX000', m, 500);
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } throw e; }
}

// route_bill_returns.received_at — replaces the set_route_bill_received_at() Postgres trigger
function stampReceivedAt(table, row, old) {
  if (table !== 'route_bill_returns' || !('received' in row)) return;
  if (!row.received) row.received_at = null;
  else if (!old || !old.received) row.received_at = nowTs();
  else row.received_at = old.received_at;
}

module.exports = function restRouter(db, authCtx) {
  const router = express.Router();

  router.use((req, res, next) => { res.set('Access-Control-Expose-Headers', 'Content-Range'); next(); });

  // ── RPC ─────────────────────────────────────────────────────────────
  const RPC = {
    sum_stock_ledger_by_sku: (a) => db.prepare('SELECT COALESCE(sum(qty_change), 0) AS s FROM stock_ledger WHERE sku_id = ?').get(a.p_sku_id).s,
    sum_stock_ledger_by_lot: (a) => db.prepare('SELECT COALESCE(sum(qty_change), 0) AS s FROM stock_ledger WHERE sku_id = ? AND lot_id = ?').get(a.p_sku_id, a.p_lot_id).s,
    get_my_role: (a, ctx) => ctx?.user?.role ?? null,
    refresh_sales_overview_monthly: () => null, // supplychain-era rollup; sales_overview_monthly is not read by tss-wms
  };
  router.post('/rpc/:fn', (req, res) => {
    const fn = RPC[req.params.fn];
    try {
      const ctx = authCtx(req);
      if (!ctx) throw pgError('42501', 'JWT required — please sign in', 401);
      if (ctx.user?.role === 'DRIVER') throw pgError('42501', `permission denied for function ${req.params.fn}`, 403);
      if (!fn) throw pgError('PGRST202', `Could not find the function public.${req.params.fn} in the schema cache`, 404);
      const out = fn(req.body || {}, ctx);
      if (String(req.headers.prefer || '').includes('return=minimal')) return res.status(204).end();
      res.json(out);
    } catch (e) { const pe = sqliteToPg(e, req.params.fn); res.status(pe.status).json(pe.pg); }
  });

  // ── SELECT ──────────────────────────────────────────────────────────
  function doSelect(req, res) {
    const rel = relation(req.params.table);
    try {
      if (!rel) throw pgError('42P01', `relation "public.${req.params.table}" does not exist`, 404);
      const ctx = authCtx(req);
      const extra = policy.scope(ctx, rel.name, 'select');
      const { filters, meta } = parseQuery(req);
      const where = whereClause(rel, filters, extra);
      const cols = projection(rel, meta.select);
      const limit = meta.limit != null ? Math.max(0, parseInt(meta.limit, 10)) : null;
      const offset = meta.offset != null ? Math.max(0, parseInt(meta.offset, 10)) : 0;
      const sql = `SELECT ${cols ? cols.map(q).join(', ') : '*'} FROM ${q(rel.name)} ${where.sql} ${orderClause(rel, meta.order)}`
        + (limit != null ? ` LIMIT ${limit} OFFSET ${offset}` : offset ? ` LIMIT -1 OFFSET ${offset}` : '');
      const rows = db.prepare(sql).all(...where.params).map((r) => rowFromDb(rel, r, cols));
      let total = null;
      if (/count=(exact|planned|estimated)/.test(String(req.headers.prefer || ''))) {
        total = db.prepare(`SELECT count(*) AS n FROM ${q(rel.name)} ${where.sql}`).get(...where.params).n;
      }
      return sendRows(req, res, rows, 200, total, offset);
    } catch (e) { const pe = sqliteToPg(e, req.params.table); return res.status(pe.status).json(pe.pg); }
  }
  router.get('/:table', doSelect);
  router.head('/:table', doSelect);

  // ── INSERT / UPSERT ─────────────────────────────────────────────────
  router.post('/:table', (req, res) => {
    const rel = relation(req.params.table);
    try {
      if (!rel || rel.isView) throw pgError('42P01', `relation "public.${req.params.table}" does not exist`, 404);
      const ctx = authCtx(req);
      policy.scope(ctx, rel.name, 'insert');
      const p = prefer(req);
      const { meta } = parseQuery(req);
      const input = Array.isArray(req.body) ? req.body : [req.body || {}];
      const upsert = p.resolution === 'merge-duplicates' || p.resolution === 'ignore-duplicates';
      if (upsert) policy.scope(ctx, rel.name, 'update');
      policy.checkRows(ctx, db, rel.name, 'insert', input);

      const payloadCols = meta.columns
        ? splitList(meta.columns).map((c) => c.trim())
        : [...new Set(input.flatMap((r) => Object.keys(r)))];
      for (const c of payloadCols) colOf(rel, c);
      const conflict = meta.on_conflict ? meta.on_conflict.split(',').map((s) => s.trim()) : rel.table.pk;
      const t = rel.table;

      const saved = tx(db, () => input.map((raw) => {
        const row = {};
        for (const c of payloadCols) if (c in raw) row[c] = raw[c];
        let old = null;
        if (upsert && rel.name === 'route_bill_returns') {
          const keyVals = conflict.map((k) => toDb(rel.columns[k], raw[k]));
          old = db.prepare(`SELECT * FROM ${q(rel.name)} WHERE ${conflict.map((k) => `${q(k)} = ?`).join(' AND ')}`).get(...keyVals) || null;
          if (old) old = rowFromDb(rel, old);
        }
        stampReceivedAt(rel.name, row, old);
        const values = {};
        for (const [k, v] of Object.entries(row)) values[k] = toDb(rel.columns[k], v);
        // columns the request didn't send get their Postgres default (uuid, now(), literals)
        for (const c of t.columns) {
          if (values[c.name] === undefined || (values[c.name] === null && !(c.name in row) && c.default)) {
            const d = defaultValue(c);
            if (d !== undefined) values[c.name] = d;
          }
        }
        if (upsert && TOUCH(rel.name) && rel.columns.updated_at) values.updated_at = values.updated_at ?? nowTs();
        const names = Object.keys(values).filter((k) => values[k] !== undefined);
        let sql = `INSERT INTO ${q(rel.name)} (${names.map(q).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
        if (upsert) {
          const sent = Object.keys(row).filter((k) => !conflict.includes(k));
          if (TOUCH(rel.name) && rel.columns.updated_at && !sent.includes('updated_at')) sent.push('updated_at');
          if (rel.name === 'route_bill_returns' && 'received' in row && !sent.includes('received_at')) sent.push('received_at');
          sql += p.resolution === 'ignore-duplicates' || !sent.length
            ? ` ON CONFLICT (${conflict.map(q).join(', ')}) DO NOTHING`
            : ` ON CONFLICT (${conflict.map(q).join(', ')}) DO UPDATE SET ${sent.map((k) => `${q(k)} = excluded.${q(k)}`).join(', ')}`;
        }
        return db.prepare(`${sql} RETURNING *`).get(...names.map((k) => values[k]));
      }).filter(Boolean));

      const rows = saved.map((r) => rowFromDb(rel, r));
      recordChange(rel.name, 'INSERT', rows);
      if (p.return !== 'representation') return res.status(201).end();
      const cols = projection(rel, meta.select);
      return sendRows(req, res, cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) : rows, 201, null);
    } catch (e) { const pe = sqliteToPg(e, req.params.table); return res.status(pe.status).json(pe.pg); }
  });

  // ── UPDATE ──────────────────────────────────────────────────────────
  router.patch('/:table', (req, res) => {
    const rel = relation(req.params.table);
    try {
      if (!rel || rel.isView) throw pgError('42P01', `relation "public.${req.params.table}" does not exist`, 404);
      const ctx = authCtx(req);
      const extra = policy.scope(ctx, rel.name, 'update');
      const { filters, meta } = parseQuery(req);
      const where = whereClause(rel, filters, extra);
      if (!where.userFilters) throw pgError('21000', 'UPDATE requires a WHERE clause');
      const body = { ...(req.body || {}) };
      for (const c of Object.keys(body)) colOf(rel, c);
      policy.checkRows(ctx, db, rel.name, 'update', [body]);
      if (TOUCH(rel.name) && rel.columns.updated_at && !('updated_at' in body)) body.updated_at = nowTs();

      const updated = tx(db, () => {
        const perRow = rel.name === 'route_bill_returns' && 'received' in body;
        if (!perRow) {
          const names = Object.keys(body);
          if (!names.length) return db.prepare(`SELECT * FROM ${q(rel.name)} ${where.sql}`).all(...where.params);
          return db.prepare(`UPDATE ${q(rel.name)} SET ${names.map((k) => `${q(k)} = ?`).join(', ')} ${where.sql} RETURNING *`)
            .all(...names.map((k) => toDb(rel.columns[k], body[k])), ...where.params);
        }
        const pk = rel.table.pk;
        return db.prepare(`SELECT * FROM ${q(rel.name)} ${where.sql}`).all(...where.params).map((oldRaw) => {
          const row = { ...body };
          stampReceivedAt(rel.name, row, rowFromDb(rel, oldRaw));
          const names = Object.keys(row);
          return db.prepare(`UPDATE ${q(rel.name)} SET ${names.map((k) => `${q(k)} = ?`).join(', ')} WHERE ${pk.map((k) => `${q(k)} = ?`).join(' AND ')} RETURNING *`)
            .get(...names.map((k) => toDb(rel.columns[k], row[k])), ...pk.map((k) => oldRaw[k]));
        });
      });
      const rows = updated.map((r) => rowFromDb(rel, r));
      recordChange(rel.name, 'UPDATE', rows);
      if (prefer(req).return !== 'representation') return res.status(204).end();
      const cols = projection(rel, meta.select);
      return sendRows(req, res, cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) : rows, 200, null);
    } catch (e) { const pe = sqliteToPg(e, req.params.table); return res.status(pe.status).json(pe.pg); }
  });

  // ── DELETE ──────────────────────────────────────────────────────────
  router.delete('/:table', (req, res) => {
    const rel = relation(req.params.table);
    try {
      if (!rel || rel.isView) throw pgError('42P01', `relation "public.${req.params.table}" does not exist`, 404);
      const ctx = authCtx(req);
      const extra = policy.scope(ctx, rel.name, 'delete');
      const { filters, meta } = parseQuery(req);
      const where = whereClause(rel, filters, extra);
      if (!where.userFilters) throw pgError('21000', 'DELETE requires a WHERE clause');
      const rows = tx(db, () => db.prepare(`DELETE FROM ${q(rel.name)} ${where.sql} RETURNING *`).all(...where.params)).map((r) => rowFromDb(rel, r));
      recordChange(rel.name, 'DELETE', rows);
      if (prefer(req).return !== 'representation') return res.status(204).end();
      const cols = projection(rel, meta.select);
      return sendRows(req, res, cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) : rows, 200, null);
    } catch (e) { const pe = sqliteToPg(e, req.params.table); return res.status(pe.status).json(pe.pg); }
  });

  return router;
};

function TOUCH(table) { return store.TOUCH_UPDATED_AT.has(table); }
