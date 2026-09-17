const express = require('express');
const crypto = require('crypto');
const { buildWhere, buildOrderBy } = require('./pgQuery');
const { requireRole } = require('../middleware/auth');

function nowIso() {
  return new Date().toISOString();
}

function genId(prefix) {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
}

/**
 * Generic table router matching the query shape the client's Supabase-style shim sends
 * (see index.html's makeLocalClient / lib/pgQuery.js on the parsing side):
 *   GET    /api/<table>?col=eq.val&order=col.asc&limit=10&offset=0     -> select
 *   POST   /api/<table>                        body: row or [rows]     -> insert
 *   POST   /api/<table>?upsert=true&onConflict=col   body: row or [rows] -> upsert
 *   PATCH  /api/<table>?col=eq.val             body: {patch}            -> update where filters
 *   DELETE /api/<table>?col=eq.val                                     -> delete where filters
 *
 * options:
 *   pk        primary key column (default 'id')
 *   fields    columns accepted from the request body on insert/update
 *   idPrefix  auto-generate the pk on insert when missing
 *   touch     columns to stamp with nowIso() on write (default ['updated_at'])
 *   orderBy   default ORDER BY column when the caller doesn't specify one
 */
function makeCrudRouter(db, table, options = {}) {
  const pk = options.pk || 'id';
  const fields = options.fields;
  const touch = options.touch === undefined ? ['updated_at'] : options.touch;
  const jsonFields = options.jsonFields || [];
  const router = express.Router();

  function parseJsonFields(row) {
    if (!row) return row;
    for (const f of jsonFields) {
      if (typeof row[f] === 'string') {
        try { row[f] = JSON.parse(row[f]); } catch { /* leave as-is */ }
      }
    }
    return row;
  }

  router.get('/', (req, res) => {
    const { where, params } = buildWhere(req.query, fields);
    const orderClause = buildOrderBy(req.query, fields, options.orderBy || pk);
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const offset = parseInt(req.query.offset, 10) || 0;

    if (req.query.count === 'exact') {
      const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params);
      if (req.query.head === 'true') return res.json({ data: [], count: countRow.n });
      // FIXED (2026-09-13, /code-review): count=exact without head=true used to fall through to the
      // plain array below, silently discarding the count it just computed — a supabase-js-style
      // `.select('*', {count:'exact'})` call (head defaults to false) expects {data, count} back.
      const sql = `SELECT * FROM ${table} ${where} ${orderClause} LIMIT ? OFFSET ?`;
      const rows = db.prepare(sql).all(...params, limit, offset).map(parseJsonFields);
      return res.json({ data: rows, count: countRow.n });
    }

    const sql = `SELECT * FROM ${table} ${where} ${orderClause} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit, offset).map(parseJsonFields);
    res.json(rows);
  });

  if (options.readOnly) return router;

  // Express only applies middleware to routes registered after it, so this gates the POST/PATCH/
  // DELETE handlers below while leaving the GET handler above open to any authenticated user —
  // same idiom routes/perms.js already applies by hand, generalized here for reuse.
  if (options.writeRoles) router.use(requireRole(...options.writeRoles));

  function insertOne(body, upsert, onConflict) {
    const row = { ...body };
    if (options.idPrefix && !row[pk]) row[pk] = genId(options.idPrefix);
    for (const col of touch) if (row[col] === undefined) row[col] = nowIso();
    for (const f of jsonFields) if (row[f] !== undefined && typeof row[f] !== 'string') row[f] = JSON.stringify(row[f]);
    const cols = fields.filter((f) => row[f] !== undefined);
    if (!cols.includes(pk) && row[pk] !== undefined) cols.push(pk);
    const placeholders = cols.map(() => '?').join(',');
    let sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
    if (upsert) {
      const conflictCol = onConflict || pk;
      const updateCols = cols.filter((c) => c !== conflictCol);
      sql += ` ON CONFLICT(${conflictCol}) DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(',')}`;
    }
    const info = db.prepare(sql).run(...cols.map((c) => row[c]));
    // auto-increment integer pk (audit_log, sales_history, stock_lots, outbound_lines): the row
    // never carried an id going in, so pull the one SQLite just generated instead of returning undefined
    return row[pk] !== undefined ? row[pk] : info.lastInsertRowid;
  }

  router.post('/', (req, res) => {
    const upsert = req.query.upsert === 'true';
    const onConflict = req.query.onConflict;
    const isArray = Array.isArray(req.body);
    const rows = isArray ? req.body : [req.body];
    // FIXED (2026-09-16): this used to be rows.map((r) => insertOne(...)) in one try/catch — a
    // single bad row (e.g. a customer_profiles.code with no matching customers row, which trips
    // the FK constraint) threw out of .map() and lost the ENTIRE array: every row before the bad
    // one had already individually committed (each insertOne() is its own auto-committed
    // statement, not wrapped in a transaction) but every row after it — including later chunks
    // the caller never even sent, once its own try/catch saw this request fail — never got a
    // chance to run at all. A bulk upsert (customer_profiles group import, etc.) sends hundreds/
    // thousands of independent rows per request; one bad row must not silently drop the rest.
    const ids = [];
    const rowErrors = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        ids.push(insertOne(rows[i], upsert, onConflict));
      } catch (e) {
        rowErrors.push({ index: i, error: e.message });
      }
    }
    if (!isArray && rowErrors.length) {
      return res.status(400).json({ error: rowErrors[0].error });
    }
    const placeholders = ids.map(() => '?').join(',');
    // FIXED (2026-09-13, /code-review): GET already parses jsonFields back into arrays/objects
    // (see parseJsonFields above) — POST returned raw rows, so a client reading e.g. `.items`
    // off the just-created row got a JSON-encoded string instead of the array every GET returns.
    const saved = ids.length
      ? db.prepare(`SELECT * FROM ${table} WHERE ${pk} IN (${placeholders})`).all(...ids).map(parseJsonFields)
      : [];
    if (rowErrors.length) {
      // Cap the same way other "list of problems" UI in this app does (e.g. index.html's promo
      // overlap-warning list) — a bad file can produce thousands of identical FK errors and the
      // header must stay well under typical proxy/header-size limits.
      res.set('X-Row-Errors', encodeURIComponent(JSON.stringify(rowErrors.slice(0, 20))));
      res.set('X-Row-Errors-Count', String(rowErrors.length));
    }
    res.status(rowErrors.length && !saved.length ? 400 : 201).json(isArray ? saved : saved[0]);
  });

  router.patch('/', (req, res) => {
    const { where, params } = buildWhere(req.query, fields);
    if (!where) return res.status(400).json({ error: 'update requires at least one filter' });
    const body = { ...req.body };
    for (const col of touch) body[col] = nowIso();
    // FIXED (2026-09-13, /code-review): jsonFields values need the same JSON.stringify step
    // insertOne() already does before insert — without it, a client sending a real array/object
    // (the normal shape) for a jsonFields column throws a TypeError from node:sqlite's run(),
    // which can't bind a non-string/number/buffer/null value.
    for (const f of jsonFields) if (body[f] !== undefined && typeof body[f] !== 'string') body[f] = JSON.stringify(body[f]);
    const cols = fields.filter((f) => body[f] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'no fields to update' });
    const setClause = cols.map((c) => `${c} = ?`).join(',');
    try {
      const info = db.prepare(`UPDATE ${table} SET ${setClause} ${where}`).run(...cols.map((c) => body[c]), ...params);
      const rows = db.prepare(`SELECT * FROM ${table} ${where}`).all(...params).map(parseJsonFields);
      res.json(rows);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete('/', (req, res) => {
    const { where, params } = buildWhere(req.query, fields);
    if (!where) return res.status(400).json({ error: 'delete requires at least one filter' });
    db.prepare(`DELETE FROM ${table} ${where}`).run(...params);
    res.status(204).end();
  });

  return router;
}

module.exports = { makeCrudRouter, genId, nowIso };
