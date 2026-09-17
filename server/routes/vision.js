const express = require('express');
const { requireAuth } = require('../middleware/auth');

// Proxies Google Vision OCR calls so VISION_API_KEY never ships to the browser
// (it used to be hardcoded in index.html:315). Forwards the exact request body index.html
// already builds for these two endpoints — see _crOcrSend() in index.html.
module.exports = function visionRoutes(db) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.post('/files:annotate', async (req, res) => {
    await proxy(req, res, 'https://vision.googleapis.com/v1/files:annotate');
  });

  router.post('/images:annotate', async (req, res) => {
    await proxy(req, res, 'https://vision.googleapis.com/v1/images:annotate');
  });

  async function proxy(req, res, url) {
    const key = process.env.VISION_API_KEY;
    if (!key) return res.status(500).json({ error: 'VISION_API_KEY not configured on server' });
    try {
      const r = await fetch(`${url}?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }

  return router;
};
