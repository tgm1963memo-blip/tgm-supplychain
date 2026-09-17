const express = require('express');
const { GoogleGenAI } = require('@google/genai');

// Groups customer codes under a parent "corporate" (e.g. many Makro/Lotus/CP Extra branch
// codes -> one corporate name) using a real Gemini API call (free tier, per user's choice —
// originally built against Claude, switched 2026-07-17), rather than a local rule-based/
// fuzzy-matching approach. Proposals never overwrite a row a human already confirmed
// (customer_profiles.corp_confirmed = 1) — see the guarded UPSERT below.
const BATCH_SIZE = 150;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const GROUPING_SCHEMA = {
  type: 'object',
  properties: {
    groupings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          corporate: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['code', 'corporate', 'confidence'],
      },
    },
  },
  required: ['groupings'],
};

function buildPrompt(batch) {
  const rows = batch.map((c) => `${c.code}\t${c.name}`).join('\n');
  return `รายชื่อลูกค้า (รหัส<TAB>ชื่อ) ต่อไปนี้มาจากระบบขายส่ง/ค้าปลีกของไทย บางรายชื่อเป็นสาขาต่างๆของบริษัทแม่เดียวกัน (เช่น "แม็คโคร สาขาสาทร" กับ "แม็คโคร สาขาพัทยา" ควรถูกจัดกลุ่มเป็น corporate เดียวกันคือ "แม็คโคร")

ให้จัดกลุ่มลูกค้าแต่ละรายเป็น "corporate" (บริษัทแม่/เครือ) โดยดูจากชื่อ ถ้าไม่เห็นรูปแบบเครือชัดเจน ให้ตั้ง corporate เป็นชื่อลูกค้าเอง (ตามชื่อที่ให้มา) และให้ confidence ต่ำ (เช่น 0.2 หรือน้อยกว่า)

รายชื่อ:
${rows}

ตอบเป็น groupings หนึ่งรายการต่อลูกค้าหนึ่งราย โดย code ต้องคัดลอกมาตรงตัวจากรายชื่อด้านบน`;
}

async function proposeCorporateGrouping(db, { limit } = {}) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const baseSql = `
    SELECT c.code, c.name FROM customers c
    LEFT JOIN customer_profiles cp ON cp.code = c.code
    WHERE c.is_active = 1
      AND (cp.corp_confirmed IS NULL OR cp.corp_confirmed = 0 OR cp.corporate IS NULL OR cp.corporate = '')
    ORDER BY c.name
  `;
  const rows = limit
    ? db.prepare(`${baseSql} LIMIT ?`).all(limit)
    : db.prepare(baseSql).all();

  // ON CONFLICT ... WHERE guards against clobbering a row a human already confirmed —
  // the update becomes a no-op (still a "successful" upsert) whenever corp_confirmed = 1.
  const upsert = db.prepare(`
    INSERT INTO customer_profiles (code, corporate, corp_source, corp_confidence, corp_confirmed, updated_at)
    VALUES (?, ?, 'ai', ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET
      corporate = excluded.corporate,
      corp_source = excluded.corp_source,
      corp_confidence = excluded.corp_confidence,
      corp_confirmed = 0,
      updated_at = excluded.updated_at
    WHERE customer_profiles.corp_confirmed = 0 OR customer_profiles.corp_confirmed IS NULL
  `);

  let proposed = 0;
  let batches = 0;
  let skippedBatches = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    batches++;
    try {
      const interaction = await ai.interactions.create({
        model: MODEL,
        input: buildPrompt(batch),
        response_format: { type: 'text', mime_type: 'application/json', schema: GROUPING_SCHEMA },
      });
      if (interaction.status !== 'completed' || !interaction.output_text) {
        console.warn('[aiGrouping] batch did not complete, status:', interaction.status);
        skippedBatches++;
        continue;
      }
      const parsed = JSON.parse(interaction.output_text);
      for (const g of parsed.groupings || []) {
        if (!g.code || !g.corporate) continue;
        const info = upsert.run(g.code, g.corporate, g.confidence ?? null);
        if (info.changes > 0) proposed++;
      }
    } catch (e) {
      console.error('[aiGrouping] batch failed:', e.message);
      skippedBatches++;
    }
  }

  return { candidates: rows.length, proposed, batches, skipped_batches: skippedBatches };
}

module.exports = function aiGroupingRoutes(db) {
  const router = express.Router();

  router.post('/propose', async (req, res) => {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
    }
    const limit = req.body && req.body.limit ? Number(req.body.limit) : undefined;
    try {
      const result = await proposeCorporateGrouping(db, { limit });
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  return router;
};
