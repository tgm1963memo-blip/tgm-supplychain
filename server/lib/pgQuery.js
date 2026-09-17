/**
 * A small subset of PostgREST's query-string grammar (the same one supabase-js generates under
 * the hood), parsed into parameterized SQL. This lets the client keep using the existing
 * supabase-js-style `.eq()/.gte()/.or()/...` chain calls unchanged (see index.html's makeLocalClient)
 * while this server does real filtering in SQLite — no giant rewrite of the ~800-line SB object
 * or the handful of scattered direct Supabase calls elsewhere in index.html.
 *
 * Supported operators: eq, neq, gt, gte, lt, lte, like, ilike, in, is, not.is.null. Supported meta
 * params: select (ignored — always returns full rows), or, order, limit, offset, count.
 */

// แก้บั๊กจริง (ยืนยันด้วย node:sqlite โดยตรง 2026-08-01): เดิม cast ค่าตัวเลขล้วนๆ (เช่น "10002",
// "10003" — รหัสสินค้าจำนวนมากเป็นตัวเลขล้วนไม่มีขีด) เป็น JS Number แล้ว bind เป็นพารามิเตอร์ตัวเลข —
// เทียบกับคอลัมน์ TEXT (เช่น products.code, stock_movements_wms_daily.sku) แล้ว "ไม่ match" เงียบๆ แม้ค่า
// จะตรงกันทุกตัวอักษร (ยืนยันด้วยการ query ตรงกับไฟล์ DB จริง) ทำให้ endpoint ทั่วทั้งระบบที่ query ด้วย
// eq./neq./in. บนคอลัมน์ TEXT ที่ค่าหน้าตาเป็นตัวเลขล้วน คืนค่าว่างเปล่าเสมอ โดยไม่มี error ใดๆ
// ทดสอบยืนยันแล้วว่าไม่จำเป็นต้อง cast เป็น Number เลย — SQLite เอง (ผ่าน column affinity) แปลงค่า
// string ที่ bind เข้ามาให้ตรงกับคอลัมน์ REAL/INTEGER ให้อัตโนมัติอยู่แล้วเวลาเทียบกับคอลัมน์ตัวเลขจริง
// (ทดสอบแล้วว่า qty >= '100' ให้ผลลัพธ์เหมือน qty >= 100 ทุกประการ) จึงตัด numeric cast ออกไปเลย
// ปลอดภัยกว่า ไม่ทำให้คอลัมน์ตัวเลขจริงพังด้วย
// FIXED (2026-09-13, /code-review): used to also call decodeURIComponent(v) here — but Express's
// own query parser (qs) already URL-decodes every query-string value once before handlers ever see
// req.query, and the client always builds these values through URLSearchParams (see index.html's
// makeLocalClient), which percent-encodes correctly on the way out. Decoding a SECOND time here was
// not just redundant, it crashed: any value containing a literal '%' not forming a valid %XX escape
// (e.g. a text filter on "50%") made decodeURIComponent throw a synchronous URIError, turning a
// legitimate filter into an uncaught 500.
function castVal(v) {
  if (v === 'true') return 1;
  if (v === 'false') return 0;
  if (v === 'null') return null;
  return v;
}

// Comparison operators shared between the direct eq/neq/gt/gte/lt/lte cases below and the not.<op>
// case (FIXED 2026-09-13, /code-review: not.<op> used to ignore <op> entirely and always emit
// NOT(col = val), so e.g. not.gt.100 silently produced "not equal to 100" instead of "not greater
// than 100" — any not.gt/gte/lt/lte/neq filter returned the wrong rows with no error).
const CMP_OPS = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function opToSql(col, op, value) {
  if (CMP_OPS[op]) return { sql: `${col} ${CMP_OPS[op]} ?`, vals: [castVal(value)] };
  switch (op) {
    case 'like': return { sql: `${col} LIKE ?`, vals: [value.replace(/\*/g, '%')] };
    case 'ilike': return { sql: `${col} LIKE ?`, vals: [value.replace(/\*/g, '%')] }; // SQLite LIKE is ASCII case-insensitive already
    case 'in': {
      const items = value.replace(/^\(|\)$/g, '').split(',').filter((s) => s !== '');
      if (!items.length) return { sql: '0', vals: [] };
      return { sql: `${col} IN (${items.map(() => '?').join(',')})`, vals: items.map(castVal) };
    }
    case 'is':
      return value === 'null' ? { sql: `${col} IS NULL`, vals: [] } : { sql: `${col} = ?`, vals: [castVal(value)] };
    case 'not': {
      const [subOp, ...subRest] = value.split('.');
      const subVal = subRest.join('.');
      if (subOp === 'is' && subVal === 'null') return { sql: `${col} IS NOT NULL`, vals: [] };
      if (CMP_OPS[subOp]) return { sql: `NOT (${col} ${CMP_OPS[subOp]} ?)`, vals: [castVal(subVal)] };
      return { sql: `NOT (${col} = ?)`, vals: [castVal(subVal)] }; // unrecognized sub-op — best-effort fallback
    }
    default:
      return { sql: '1=1', vals: [] };
  }
}

function parseOrExpr(expr, allowedCols) {
  const inner = expr.replace(/^\(/, '').replace(/\)$/, '');
  const clauses = [];
  const params = [];
  for (const part of inner.split(',')) {
    const [col, op, ...rest] = part.split('.');
    if (!allowedCols.includes(col)) continue;
    const { sql, vals } = opToSql(col, op, rest.join('.'));
    clauses.push(sql);
    params.push(...vals);
  }
  return clauses.length ? { sql: clauses.join(' OR '), params } : null;
}

const META_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'or', 'upsert', 'onConflict', 'count', 'head']);

// Builds "WHERE ... " + params from req.query, restricted to columns in `allowedCols`.
function buildWhere(query, allowedCols) {
  const clauses = [];
  const params = [];
  for (const [col, raw] of Object.entries(query)) {
    if (META_PARAMS.has(col) || !allowedCols.includes(col)) continue;
    // The client sends chained filters on the same column (e.g. .gte('ym',a).lte('ym',b)) as two
    // query-string params with an identical key; Express's qs parser folds repeated keys into an
    // array rather than keeping separate entries, so `raw` here is an array in that case, not a
    // string — each element is a separate operator.value pair and must produce its own clause, or
    // the second condition silently disappears (verified live: this was dropping every .lte()
    // paired with a .gte() on the same column, corrupting range filters app-wide).
    const rawValues = Array.isArray(raw) ? raw : [raw];
    for (const rawValue of rawValues) {
      const str = String(rawValue);
      const dot = str.indexOf('.');
      if (dot === -1) continue;
      const op = str.slice(0, dot);
      const value = str.slice(dot + 1);
      const { sql, vals } = opToSql(col, op, value);
      clauses.push(sql);
      params.push(...vals);
    }
  }
  if (query.or) {
    const or = parseOrExpr(String(query.or), allowedCols);
    if (or) {
      clauses.push(`(${or.sql})`);
      params.push(...or.params);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function buildOrderBy(query, allowedCols, fallback) {
  if (!query.order) return fallback ? `ORDER BY ${fallback}` : '';
  const parts = String(query.order)
    .split(',')
    .map((p) => {
      const [col, dir] = p.split('.');
      if (!allowedCols.includes(col)) return null;
      return `${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
    })
    .filter(Boolean);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : (fallback ? `ORDER BY ${fallback}` : '');
}

module.exports = { buildWhere, buildOrderBy, castVal };
