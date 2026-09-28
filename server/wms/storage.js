// Supabase-Storage compatible subset at /wms/storage/v1 for the private "delivery-photos" bucket:
// upload, signed URLs (single + batch), signed download, remove. Files live under WMS_STORAGE_DIR.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signJwt, verifyJwt } = require('./auth');
const { nowTs } = require('./store');

const BUCKETS = new Set(['delivery-photos']);
const err = (res, status, error, message) => res.status(status).json({ statusCode: String(status), error, message });

module.exports = function storageRouter(db, { storageDir, jwtSecret, authCtx }) {
  const router = express.Router();

  function safePath(bucket, name) {
    if (!BUCKETS.has(bucket)) return null;
    const clean = String(name || '').replace(/\\/g, '/');
    if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '')) return null;
    const full = path.resolve(storageDir, bucket, clean);
    return full.startsWith(path.resolve(storageDir, bucket) + path.sep) ? { clean, full } : null;
  }

  // drivers may only touch photos of their own trips: object names are "<tripId>/<stopId>/<file>"
  function allowed(ctx, name) {
    if (!ctx) return false;
    if (ctx.kind === 'service' || ctx.user.role !== 'DRIVER') return true;
    const tripId = name.split('/')[0];
    return !!db.prepare('SELECT 1 FROM delivery_trips WHERE id = ? AND driver_user_id = ?').get(tripId, ctx.user.id);
  }

  router.post('/object/sign/:bucket', (req, res) => {
    const ctx = authCtx(req);
    const expiresIn = Math.max(1, Math.min(7 * 86400, parseInt(req.body?.expiresIn, 10) || 60));
    const out = (req.body?.paths || []).map((p) => {
      const sp = safePath(req.params.bucket, p);
      if (!sp || !allowed(ctx, sp.clean) || !fs.existsSync(sp.full)) return { path: p, signedURL: null, error: 'Either the object does not exist or you do not have access to it' };
      const token = signJwt({ url: `${req.params.bucket}/${sp.clean}`, exp: Math.floor(Date.now() / 1000) + expiresIn }, jwtSecret);
      return { path: p, signedURL: `/object/sign/${req.params.bucket}/${sp.clean.split('/').map(encodeURIComponent).join('/')}?token=${token}`, error: null };
    });
    if (!ctx) return err(res, 400, 'Unauthorized', 'Invalid JWT');
    res.json(out);
  });

  router.post('/object/sign/:bucket/*', (req, res) => {
    const ctx = authCtx(req);
    const sp = safePath(req.params.bucket, req.params[0]);
    if (!sp || !allowed(ctx, sp.clean) || !fs.existsSync(sp.full)) return err(res, 400, 'not_found', 'Object not found');
    const expiresIn = Math.max(1, Math.min(7 * 86400, parseInt(req.body?.expiresIn, 10) || 60));
    const token = signJwt({ url: `${req.params.bucket}/${sp.clean}`, exp: Math.floor(Date.now() / 1000) + expiresIn }, jwtSecret);
    res.json({ signedURL: `/object/sign/${req.params.bucket}/${sp.clean.split('/').map(encodeURIComponent).join('/')}?token=${token}` });
  });

  router.get('/object/sign/:bucket/*', (req, res) => {
    const sp = safePath(req.params.bucket, req.params[0]);
    const claims = verifyJwt(req.query.token, jwtSecret);
    if (!sp || !claims || claims.url !== `${req.params.bucket}/${sp.clean}` || !fs.existsSync(sp.full)) return err(res, 400, 'InvalidSignature', 'The signature is invalid or has expired');
    const meta = db.prepare('SELECT content_type FROM storage_objects WHERE bucket = ? AND name = ?').get(req.params.bucket, sp.clean);
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(meta?.content_type || 'application/octet-stream').sendFile(sp.full);
  });

  const upload = (req, res) => {
    const ctx = authCtx(req);
    const sp = safePath(req.params.bucket, req.params[0]);
    if (!ctx) return err(res, 400, 'Unauthorized', 'Invalid JWT');
    if (!sp) return err(res, 400, 'InvalidKey', 'Invalid key');
    if (!allowed(ctx, sp.clean)) return err(res, 403, 'Unauthorized', 'new row violates row-level security policy');
    const upsert = String(req.headers['x-upsert'] || '') === 'true' || req.method === 'PUT';
    if (fs.existsSync(sp.full) && !upsert) return err(res, 400, 'Duplicate', 'The resource already exists');
    // supabase-js wraps a Blob/File in multipart form data; raw bodies (curl, scripts) are taken as-is
    const part = (req.files || [])[0];
    const body = part ? part.buffer : Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentType = part?.mimetype && part.mimetype !== 'application/octet-stream' ? part.mimetype : String(req.headers['content-type'] || '').startsWith('multipart/') ? 'image/jpeg' : String(req.headers['content-type'] || 'application/octet-stream');
    if (!body.length) return err(res, 400, 'InvalidRequest', 'Empty upload');
    fs.mkdirSync(path.dirname(sp.full), { recursive: true });
    fs.writeFileSync(sp.full, body);
    db.prepare(`INSERT INTO storage_objects (bucket, name, content_type, size, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (bucket, name) DO UPDATE SET content_type = excluded.content_type, size = excluded.size`)
      .run(req.params.bucket, sp.clean, contentType, body.length, ctx.user?.id || null, nowTs());
    res.json({ Key: `${req.params.bucket}/${sp.clean}`, Id: crypto.randomUUID() });
  };
  // supabase-js sends a Blob as multipart form data with an EMPTY field name (which multer rejects), so the
  // file part is picked out here: the part that carries a filename, else the last non-text part.
  const body = (req, res, next) => express.raw({ type: () => true, limit: '15mb' })(req, res, (e) => {
    if (e) return err(res, 400, 'InvalidRequest', e.message);
    const m = String(req.headers['content-type'] || '').match(/^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i);
    if (m && Buffer.isBuffer(req.body)) {
      const delim = Buffer.from(`--${m[1] || m[2]}`);
      const parts = [];
      for (let i = req.body.indexOf(delim); i >= 0;) {
        const next = req.body.indexOf(delim, i + delim.length);
        if (next < 0) break;
        const chunk = req.body.subarray(i + delim.length + 2, next - 2); // strip CRLF after delimiter / before next
        const split = chunk.indexOf('\r\n\r\n');
        if (split >= 0) parts.push({ head: chunk.subarray(0, split).toString('utf8'), data: chunk.subarray(split + 4) });
        i = next;
      }
      const file = parts.find((p) => /filename=/i.test(p.head)) || [...parts].reverse().find((p) => !/content-type:\s*text\//i.test(p.head) && /content-type:/i.test(p.head)) || parts[parts.length - 1];
      req.files = file ? [{ buffer: file.data, mimetype: (file.head.match(/content-type:\s*([^\r\n;]+)/i) || [])[1] }] : [];
    }
    next();
  });
  router.post('/object/:bucket/*', body, upload);
  router.put('/object/:bucket/*', body, upload);

  router.delete('/object/:bucket', (req, res) => {
    const ctx = authCtx(req);
    if (!ctx || ctx.user?.role === 'DRIVER') return err(res, 403, 'Unauthorized', 'not allowed');
    const removed = [];
    for (const p of req.body?.prefixes || []) {
      const sp = safePath(req.params.bucket, p);
      if (!sp || !fs.existsSync(sp.full)) continue;
      fs.unlinkSync(sp.full);
      db.prepare('DELETE FROM storage_objects WHERE bucket = ? AND name = ?').run(req.params.bucket, sp.clean);
      removed.push({ name: sp.clean, bucket_id: req.params.bucket });
    }
    res.json(removed);
  });

  return router;
};
