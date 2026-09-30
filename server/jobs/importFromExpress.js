/**
 * Pulls data from the Express (Business Plus) accounting DBF exports and upserts it into SQLite.
 * Runs every 5 minutes, 24/7, from server.js via node-cron. Read-only against Express — never
 * writes back to these folders.
 *
 * Confirmed against real files under Z:\ExpressI\<company>\ on 2026-07-10 (see plan doc):
 *   STLOC.DBF   stock by warehouse   -> stock            (TSS only)
 *   STMAS.DBF   item/stock master    -> products          (TSS + CONSI, merged)
 *   ISTAB.DBF   generic code lookup  -> warehouses         (TSS only, TABTYP='21' rows)
 *   ARMAS.DBF   customer master      -> customers          (all companies, merged)
 *   OESLM.DBF   salesman master      -> salesmen            (all companies, merged)
 *   OESO.DBF + OESOIT.DBF (SO header + line items) -> outbound_orders/outbound_lines/sales_transactions
 *                                                          (all 7 companies: TSS, TGM, TSSN-68, TSS-68,
 *                                                           TSSN-67, TSS-NV, CONSI)
 *
 * RESOLVED SOURCE DECISIONS — historical rationale and remaining accounting cross-check caveats:
 *   1. products: RESOLVED 2026-07-10 — confirmed with the user to filter STKTYP === '0' (~3,132 rows on
 *      TSS), not '1' (which was a wrong guess, only matched 198 pack-variant codes).
 *   2. sales: RESOLVED 2026-07-11 — sampled real OESO rows per DOCSTAT and cross-referenced SONUM prefix:
 *      'N' (~8,820 rows on TSS) is dominated by quotation series (QU/QT/QE/QQ/... — not yet real orders),
 *      'M' (~69,030 rows) is dominated by real order series (SA/SO/SB/SF/P) and is what should count as a
 *      confirmed sale, 'C' (58 rows) is mostly a distinct small "P" series (closed/cancelled), 'O' (2 rows)
 *      is negligible. Switched the filter from "exclude C" to "only M" accordingly — this changes totals
 *      substantially versus the first pass (was counting thousands of unconfirmed quotations as sales).
 *      Still worth a final sanity check against accounting's own monthly sales report once this is live.
 *   3. CONSI (consignment): RESOLVED 2026-07-11 — user confirmed it should be tagged/reported separately.
 *      sales_transactions/outbound_orders/outbound_lines keep every company (including CONSI) with its
 *      own `company` column, so nothing is lost. The plain `sales_history` table (slm_id/sku/ym rollup used
 *      by the older, simpler queries in index.html) now EXCLUDES CONSI — it only blends the other 6
 *      "normal" companies, matching what index.html's _isConsignmentRow()/_splitBranchSlm() already assume
 *      (a plain, non-prefixed slm_id means "not consignment"). Consignment-specific pages read from the
 *      richer v_sc_consi_monthly / v_sales_history_company views instead, filtering on company='CONSI'.
 *   4. CONSI's own STMAS/STLOC: RESOLVED 2026-07-13 — CONSI/STMAS.DBF has ~2,207 SKUs, same layout as
 *      TSS's, ~715 of which (32%) don't exist in TSS's STMAS at all — those were showing up with no
 *      product name anywhere a CONSI sale referenced them, since products only ever came from TSS.
 *      syncProducts() now reads both. STKTYP='0' filter carries over cleanly (2,034/2,207 CONSI rows are
 *      STKTYP='0', same shape as TSS) but this is still an empirical match, not an independently-derived
 *      rule — same caveat as note #2 above. CONSI's own STLOC.DBF (stock) stays UNUSED on purpose: the
 *      user's original instruction was stock-from-TSS-only, and TSS's own STLOC already carries
 *      consignment-partner locations as LOCCOD 03-06 (Villa/Tops/Lotus/Makro, see ISTAB.DBF TABTYP='21')
 *      — so consigned stock sitting at those partners is already counted, just as a warehouse dimension
 *      of TSS's own stock rather than a separate company book. Not a gap.
 *   5. DOCSTAT='M' rule generalizing to CONSI: RESOLVED 2026-07-13 (empirically, not by re-derivation) —
 *      sampled CONSI's OESO.DBF the same way as TSS. ALL of CONSI's DOCSTAT='M' rows (35,858/35,858) carry
 *      SONUM prefix "SE" only — no SA/SO/SB/SF/P ever reaches 'M' in CONSI's numbering, unlike TSS where
 *      'M' spans several "real order" prefixes. So the *rule* (DOCSTAT='M') still isolates a clean,
 *      date-plausible, revenue-bearing subset for CONSI too, but for a different underlying reason than
 *      it does for TSS — flagging this as "works in practice, not proven by the same mechanism" rather
 *      than silently treating it as a fully general rule.
 *   6. products.unit: RESOLVED 2026-07-30 — was never synced (schema default 'กก.' silently stood in
 *      for every SKU regardless of its real unit, confirmed wrong for e.g. 20284-5 which is sold by
 *      "แพ"/pack). STMAS.QUCOD is the stock unit — the same unit STLOC's LOCBAL/STMAS.TOTBAL balances
 *      are counted in — confirmed by sampling 20284-5 directly against Z:\ExpressI\TSS\STMAS.DBF.
 */

const fs = require('fs');
const path = require('path');
const { DBFFile } = require('dbffile');

const EXPRESS_ROOT_CANDIDATES = process.env.EXPRESS_DBF_ROOT
  ? [process.env.EXPRESS_DBF_ROOT]
  : ['Z:\\ExpressI', '\\\\server\\expsrv\\ExpressI'];
const EXPRESS_ROOT = EXPRESS_ROOT_CANDIDATES.find((root) => fs.existsSync(root)) || EXPRESS_ROOT_CANDIDATES[0];
const STOCK_COMPANY = 'TSS';

function companyListFromEnv(envVar, fallback) {
  const raw = process.env[envVar];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// products come from TSS (primary catalog) + CONSI (fills in ~715 consignment-only SKUs TSS lacks) —
// TSS is listed first so it wins any code that exists in both (see syncProducts()'s dedupe).
// Overridable via PRODUCT_COMPANIES/SALES_COMPANIES env vars (comma-separated) for staged
// rollout — e.g. verifying TSS+CONSI alone before adding the rest of the company books.
const PRODUCT_COMPANIES = companyListFromEnv('PRODUCT_COMPANIES', ['TSS', 'CONSI', 'TGM', 'TSS-NV']);
// UPDATED 2026-08-10 (confirmed with user): the 2026-07-17 staged rollout limited the recurring
// 5-minute sync to TSS and CONSI only, with the other 6 company books backfilled ONCE that day and
// then left frozen — dashboard tiles for TGM/TSS-NV/etc. stopped advancing (found stale by 3-8
// months when investigating a "ยอดขายไม่แสดง" report). The staged rollout's follow-up step ("add
// the rest of the company books") never happened, so this now includes all 8 books in the
// recurring sync going forward. COMPANY_DATE_CUTOFF below still applies, so the TSS-NV/TSSN-68
// cutover fix keeps working under the wider list.
const SALES_COMPANIES = companyListFromEnv('SALES_COMPANIES', ['TSS', 'CONSI', 'TGM', 'TSS-68', 'TSSN-68', 'TSSN-67', 'TSS-67', 'TSS-NV']);

// Confirmed with user 2026-07-10 (TSS) and re-checked 2026-07-13 (CONSI, same distribution shape):
// STKTYP='0' = real sellable products on this system.
const PRODUCT_STKTYP_INCLUDE = ['0'];
// Confirmed with user 2026-07-11 (see file header): only 'M' (matched/confirmed order) counts as a real sale.
const ORDER_DOCSTAT_INCLUDE = ['M'];
// Accounting confirmed these ARTRN document series must not be counted as sales revenue.
// Keep the rule close to the Express importer so every invoice-derived total uses the same exclusion.
const SALES_DOCNUM_EXCLUDE_PREFIXES = new Set(['LF', 'LE', 'LG']);
function isExcludedSalesDocNum(docNum) {
  const prefix = String(docNum || '').trim().toUpperCase().slice(0, 2);
  return SALES_DOCNUM_EXCLUDE_PREFIXES.has(prefix);
}
const CONSI_COMPANY = 'CONSI';
// TABTYP for the warehouse/location code lookup within Express's generic ISTAB.DBF code-table file.
const WAREHOUSE_TABTYP = '21';
// TABTYP for the unit-of-measure code lookup within the same ISTAB.DBF file (confirmed 2026-08-26,
// requested by tgm-wms: "แก้หน่วยทั้งระบบ ให้ขึ้นเป็นภาษาหน่วยเต็ม... เอาหน่วยเต็มมาจาก express" — products.unit
// previously stored STMAS.QUCOD's raw short code (e.g. "แพ") as-is; ISTAB TABTYP='20' rows carry the same
// short code in TYPCOD alongside a real full Thai name in TYPDES, e.g. TYPCOD="แพ"/TYPDES="แพค").
const UNIT_TABTYP = '20';
// TABTYP for the delivery-route ("สายรถ") code lookup within the same ISTAB.DBF file — added 2026-09-16
// per tgm-wms's request for a "สายรถ" billing/delivery-route feature. Confirmed by direct inspection of
// live ARTRN.DBF + ISTAB.DBF: ARTRN.AREACOD ("Area Code") is the per-invoice route code Express already
// assigns (96 distinct 2-4 char codes seen, e.g. "01"/"09"/"11"/"G1"), and ISTAB TABTYP='41' rows resolve
// those exact codes to human labels — TYPCOD="09" -> TYPDES="สาย 1", TYPCOD="10" -> "สาย 2", etc. (8/8
// sample codes matched). This is the real Express-side "สายรถ" master data; no separate mapping needed.
const ROUTE_TABTYP = '41';

const DBF_OPEN_OPTS = { encoding: 'cp874', readMode: 'loose' };

function findFile(folder, baseName) {
  if (!fs.existsSync(folder)) return null;
  const wanted = baseName.toLowerCase();
  const hit = fs.readdirSync(folder).find((f) => f.toLowerCase() === wanted);
  return hit ? path.join(folder, hit) : null;
}

async function readTable(company, baseName) {
  const folder = path.join(EXPRESS_ROOT, company);
  const file = findFile(folder, baseName);
  if (!file) return [];
  const dbf = await DBFFile.open(file, DBF_OPEN_OPTS);
  return dbf.readRecords();
}

function toIsoDate(d) {
  return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null;
}
function ym(d) {
  return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 7) : null;
}

// Confirmed with user 2026-08-24: salesperson codes in Express are inconsistent — mostly 3-digit
// numeric (103, 110) but some carry a "-N" sub-code suffix (110-1, 110-2 — sub-agents under the same
// salesperson) and a few use a letter prefix (ON-001). Normalize numeric-leading codes down to their
// first 3 characters (dropping any "-N" suffix) so sub-codes collapse onto one parent salesperson
// code and joins/rollups group correctly; letter-prefixed codes are left untouched. Applied at every
// point SLMCOD is read from a raw Express DBF, so every table that stores a salesperson code agrees.
function normalizeSlmCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return code;
  return /^[0-9]/.test(code) ? code.slice(0, 3) : code;
}

function cleanText(raw) {
  return String(raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSalesLineComponentRemark(raw) {
  const note = cleanText(raw);
  if (!note) return null;
  const codeMatch = note.match(/^([A-Z0-9][A-Z0-9-]*)\b/i);
  if (!codeMatch) return null;
  // Express line notes store the child quantity at the very end. Most rows use a pack marker
  // such as `20p`, but some 90022 notes use Thai/English kilogram markers like `1kg` or Thai
  // shorthand for kilogram; those are still quantity 1 for route-billing weight calculation.
  const qtyMatch = note.match(/(\d+(?:\.\d+)?)\s*(?:[pP]\.?|\u0e0a\u0e38\u0e14|\u0e41\u0e1e\u0e04|pack|packs|\u0e01\u0e04|\u0e01\u0e01|kg|kgs)\s*$/i);
  const childCode = codeMatch[1].trim();
  const childQty = qtyMatch ? Number(qtyMatch[1]) : 0;
  let childName = note.slice(codeMatch[0].length).trim();
  if (qtyMatch) childName = childName.replace(/\s*\d+(?:\.\d+)?\s*(?:[pP]\.?|\u0e0a\u0e38\u0e14|\u0e41\u0e1e\u0e04|pack|packs|\u0e01\u0e04|\u0e01\u0e01|kg|kgs)\s*$/i, '').trim();
  return { childCode, childName: childName || null, childQty, note };
}

// item ย่อยของสินค้าชุด (2026-09-29, เฉพาะ sales_line_components — invoice_line_components คง 90022 เดิม): เดิมเก็บเฉพาะ parent 90022 — ขยายให้ทุกสินค้าที่มีหมายเหตุ item ย่อย
// (เช่น 90021/90023 ไส้กรอกราคาพิเศษ ที่ Express มีหมายเหตุครบแต่ไม่เคยถูกดึง)
// 90022 คงกติกาเดิมทุกอย่าง (tgm-wms ใช้คำนวณน้ำหนักสายรถ) · parent อื่นนับเฉพาะหมายเหตุที่รหัสแรกเป็นรหัสสินค้าจริง
// ใน products — กันหมายเหตุทั่วไป/บาร์โค้ด (TSS มีบาร์โค้ด 885... ในหมายเหตุจำนวนมาก) ไม่ให้ถูกนับเป็น item ย่อย
const LEGACY_COMPONENT_PARENT = /^90022(?:-|$)/;
function loadKnownSkuSet(db) {
  try {
    return new Set(db.prepare('SELECT code FROM products').all().map((r) => String(r.code || '').trim().toUpperCase()));
  } catch (_) {
    return new Set();
  }
}
function acceptsComponent(parentSku, childCode, knownSkus) {
  if (!parentSku || !childCode) return false;
  if (LEGACY_COMPONENT_PARENT.test(parentSku)) return true;
  const child = String(childCode).toUpperCase();
  return child !== String(parentSku).toUpperCase() && knownSkus.has(child);
}
// Unit code -> full Thai name, from the same generic code-table file/mechanism syncWarehouses() already
// uses for warehouse names (see UNIT_TABTYP comment above). Small, stable reference table (~60 rows) —
// read fresh each sync rather than cached, matching syncWarehouses()'s own plain-upsert-by-code pattern.
async function loadUnitNameMap() {
  const rows = await readTable(STOCK_COMPANY, 'ISTAB.DBF');
  const map = new Map();
  for (const r of rows) {
    if (r.TABTYP !== UNIT_TABTYP || !r.TYPCOD) continue;
    const code = r.TYPCOD.trim();
    const name = (r.TYPDES || '').trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

// Route code -> Thai label ("สาย 1", "สาย 2", ...), same generic ISTAB.DBF mechanism as
// loadUnitNameMap()/syncWarehouses() above — see ROUTE_TABTYP comment for how this was confirmed.
async function loadRouteNameMap() {
  const rows = await readTable(STOCK_COMPANY, 'ISTAB.DBF');
  const map = new Map();
  for (const r of rows) {
    if (r.TABTYP !== ROUTE_TABTYP || !r.TYPCOD) continue;
    const code = r.TYPCOD.trim();
    const name = (r.TYPDES || '').trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

function joinAddressParts(...parts) {
  return parts.map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

async function loadShipToAddressMap() {
  const rows = await readTable(STOCK_COMPANY, 'ARSHIP.DBF');
  const map = new Map();
  for (const r of rows) {
    const custCode = String(r.CUSCOD || '').trim();
    const shipTo = String(r.SHIPTO || '').trim();
    if (!custCode || !shipTo) continue;
    const address = joinAddressParts(r.ADDR01, r.ADDR02, r.ADDR03, r.ZIPCOD);
    if (address) map.set(`${custCode}|${shipTo}`, address);
  }
  return map;
}

async function syncProducts(db) {
  const importedByCompany = {};
  const skipped = {};
  const seen = new Set();
  const unitNames = await loadUnitNameMap();
  const upsert = db.prepare(`
    INSERT INTO products (code, name, group_name, unit, standard_price, price_company, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, group_name = excluded.group_name,
      unit = excluded.unit, standard_price = excluded.standard_price, price_company = excluded.price_company,
      is_active = 1, updated_at = excluded.updated_at
  `);
  // Combo/set codes (STKTYP != '0', e.g. the -A/-B suffix codes STMAS uses for bundle SKUs) are
  // real sales_transactions rows that had no name anywhere in this system — every lookup fell back
  // to showing the bare code (e.g. Sales Overview's product tab, under "อื่นๆ"). They're still not
  // sellable inventory (is_active stays 0, so SKU Settings/allowedSKUs/stock planning never see
  // them — that STKTYP='0' rule was confirmed deliberately, see PRODUCT_STKTYP_INCLUDE above), but
  // this captures their real STKDES name so name lookups resolve instead of falling back to raw
  // codes. The WHERE guards against ever downgrading a row that's genuinely active elsewhere.
  const upsertNameOnly = db.prepare(`
    INSERT INTO products (code, name, group_name, unit, standard_price, price_company, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, group_name = excluded.group_name,
      unit = COALESCE(NULLIF(excluded.unit,''), products.unit),
      standard_price = COALESCE(excluded.standard_price, products.standard_price),
      price_company = CASE WHEN excluded.standard_price IS NOT NULL THEN excluded.price_company ELSE products.price_company END,
      updated_at = excluded.updated_at
    WHERE products.is_active = 0
  `);
  let nameOnlyCount = 0;

  // Read every company's DBF first (async file I/O), then do all writes in one synchronous pass —
  // keeps the write transaction below from spanning multiple awaits.
  const rowsByCompany = [];
  for (const company of PRODUCT_COMPANIES) {
    rowsByCompany.push([company, await readTable(company, 'STMAS.DBF')]);
  }

  // FIXED (2026-09-13, /code-review): this whole write phase used to run unwrapped — a malformed
  // row or thrown exception partway through left products from already-processed companies upserted
  // but the trailing deactivate step never ran and nothing rolled back. Same BEGIN/COMMIT/ROLLBACK
  // convention already used by syncStock/syncStockMovements/syncInvoiceSales in this file.
  db.exec('BEGIN');
  try {
    for (const [company, rows] of rowsByCompany) {
      importedByCompany[company] = 0;
      for (const r of rows) {
        if (!r.STKCOD) continue;
        const code = r.STKCOD.trim();
        if (!PRODUCT_STKTYP_INCLUDE.includes(r.STKTYP)) {
          skipped[r.STKTYP] = (skipped[r.STKTYP] || 0) + 1;
          const unitCode = (r.QUCOD || '').trim();
          const unit = (unitCode && unitNames.get(unitCode)) || unitCode || 'กิโลกรัม';
          const standardPrice = [r.SELLPR1, r.SELLPR2, r.SELLPR3, r.SELLPR4, r.SELLPR5].map(Number).find(v => Number.isFinite(v) && v > 0) || null;
          upsertNameOnly.run(code, (r.STKDES || '').trim(), (r.STKGRP || '').trim(), unit, standardPrice, standardPrice ? company : null);
          nameOnlyCount++;
          continue;
        }
        if (seen.has(code)) continue; // already brought in by an earlier company in PRODUCT_COMPANIES (TSS wins ties)
        const unitCode = (r.QUCOD || '').trim();
        const unit = (unitCode && unitNames.get(unitCode)) || unitCode || 'กิโลกรัม';
        const standardPrice = [r.SELLPR1, r.SELLPR2, r.SELLPR3, r.SELLPR4, r.SELLPR5].map(Number).find(v => Number.isFinite(v) && v > 0) || null;
        // price_company: TSS keys STMAS prices as net cost — ใบเคาะราคา reverse-calculates a sell price from it
        upsert.run(code, (r.STKDES || '').trim(), (r.STKGRP || '').trim(), unit, standardPrice, standardPrice ? company : null);
        seen.add(code);
        importedByCompany[company]++;
      }
    }
    const imported = seen.size;

    // mirror semantics: anything not seen in this run (wrong STKTYP, deleted from Express, ...) goes inactive
    // instead of being deleted outright, so historical sales/stock rows still resolve to a product name.
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _seen_products (code TEXT PRIMARY KEY)');
    db.exec('DELETE FROM _seen_products');
    const insertSeen = db.prepare('INSERT OR IGNORE INTO _seen_products (code) VALUES (?)');
    for (const code of seen) insertSeen.run(code);
    const deactivated = db.prepare(`
      UPDATE products SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE is_active = 1 AND code NOT IN (SELECT code FROM _seen_products)
    `).run();

    db.exec('COMMIT');
    console.log(`[importFromExpress] products: imported ${imported} (${JSON.stringify(importedByCompany)}), skipped by STKTYP ${JSON.stringify(skipped)} (${nameOnlyCount} of those name-backfilled, inactive), deactivated ${deactivated.changes}`);
    return imported;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function syncCustomers(db) {
  const seen = new Set();
  const upsertCust = db.prepare(`
    INSERT INTO customers (code, name, slm_id, is_active, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, slm_id = excluded.slm_id,
      is_active = excluded.is_active, updated_at = excluded.updated_at
  `);
  const upsertSlm = db.prepare(`
    INSERT INTO salesmen (slm_id, name, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(slm_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `);

  // Read every company's DBFs first (async file I/O), then write in one synchronous pass — see
  // syncProducts()'s comment for why (keeps the transaction below from spanning multiple awaits).
  const custRowsByCompany = [];
  for (const company of SALES_COMPANIES) custRowsByCompany.push(await readTable(company, 'ARMAS.DBF'));
  const slmRowsByCompany = [];
  for (const company of SALES_COMPANIES) slmRowsByCompany.push(await readTable(company, 'OESLM.DBF'));

  // FIXED (2026-09-13, /code-review): both write loops below used to run unwrapped, same gap as
  // syncProducts() had — wrapped for the same reason, same established convention.
  let imported = 0;
  const seenSlm = new Set();
  db.exec('BEGIN');
  try {
    for (const rows of custRowsByCompany) {
      for (const r of rows) {
        if (!r.CUSCOD || seen.has(r.CUSCOD)) continue;
        seen.add(r.CUSCOD);
        upsertCust.run(r.CUSCOD.trim(), (r.CUSNAM || '').trim(), normalizeSlmCode(r.SLMCOD) || null, r.STATUS === 'A' ? 1 : 0);
        imported++;
      }
    }
    for (const rows of slmRowsByCompany) {
      for (const r of rows) {
        const slmId = normalizeSlmCode(r.SLMCOD);
        // dedupe on the NORMALIZED code (not the raw one) so 110-1/110-2 collapse into one seen entry —
        // first company in SALES_COMPANIES still wins ties, same convention as syncProducts()
        if (!slmId || seenSlm.has(slmId)) continue;
        seenSlm.add(slmId);
        upsertSlm.run(slmId, (r.SLMNAM || '').trim());
      }
    }
    db.exec('COMMIT');
    console.log(`[importFromExpress] customers: imported ${imported}, salesmen: ${seenSlm.size}`);
    return imported;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Stock intentionally stays TSS-only (per the original requirement: "Stock มาจาก Z:\ExpressI\TSS
// โดยแยกเป็นคลังทุกคลัง"). CONSI has its own STLOC.DBF but it's deliberately unused — TSS's own
// STLOC.DBF already carries consignment-partner locations as LOCCOD 03-06 (Villa/Tops/Lotus/Makro,
// see ISTAB.DBF TABTYP='21' in syncWarehouses() below), so consigned stock sitting at those partners
// is already counted as a warehouse dimension of TSS's stock — not a separate company book to merge in.
async function syncStock(db) {
  const rows = await readTable(STOCK_COMPANY, 'STLOC.DBF');
  // FIXED 2026-08-06: this never set `unit` explicitly, so every row silently fell back to the
  // column's schema default ('กก.') regardless of the SKU's real stock unit — confirmed wrong for
  // e.g. 10022-9 (real unit "แพ", per products.unit which syncProducts() above already gets right
  // from STMAS.QUCOD). Look it up from `products` (already refreshed for this cycle, since
  // syncProducts() runs before syncStock() in runImport() below) instead of leaving it to the default.
  const insert = db.prepare(`INSERT INTO stock (sku, warehouse, qty, unit, last_updated) VALUES (?, ?, ?, ?, ?)`);
  const getProductUnit = db.prepare(`SELECT unit FROM products WHERE code = ?`);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM stock');
    let n = 0;
    for (const r of rows) {
      if (!r.STKCOD || !r.LOCCOD) continue;
      const sku = r.STKCOD.trim();
      const unit = getProductUnit.get(sku)?.unit || 'กก.';
      insert.run(sku, r.LOCCOD.trim(), r.LOCBAL || 0, unit, toIsoDate(r.LMOVDAT) || new Date().toISOString());
      n++;
    }
    db.exec('COMMIT');
    console.log(`[importFromExpress] stock: replaced with ${n} sku/warehouse rows`);
    return n;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Daily stock movement ledger from Express's real per-transaction stock card (STCRD.DBF) — `stock`
// above is a current-balance snapshot only (no history at all); this is the actual day-by-day
// activity behind it. Document-number prefix -> category confirmed directly by the user 2026-07-22:
//   sold: AB/DA/BE/AK/DD/BM/LF/OL/DB/DM (การขาย) + OT/OR (ใบเบิกสินค้า — internal issue, still an
//     outbound reduction with no better bucket among the 4 named ones)
//   received: RC/RH/RR/RN/RI/RS (รับเข้า) + PM (รับเข้าจากลูกค้า) + JU/JW (รับสินค้าล่วงหน้า)
//   transferred: RL/VL/TP/MK/TG/LT (โอนย้าย) — same qty posted at both LOCCOD 01 (TSS's own
//     warehouse) and 03-06 (consignment-partner locations, see syncStock's comment above); 01 is
//     always the source (-qty) and any other LOCCOD is the destination (+qty), NOT signed in TRNQTY
//     itself, unlike converted below.
//   converted: FF (แปลง) — TRNQTY IS already signed here: negative = raw material consumed,
//     positive = finished good produced (confirmed empirically — paired lines within one DOCNUM sum
//     to ~0 for a straight conversion).
//   other: everything else (CN/XV/SR/XZ/HN/HI/SS credit note, GR debt reduction, XX waste, TK stock
//     count adjustment, PI production adjustment, KA/KB samples) — a deliberate catch-all, not a
//     mistake: keeps received+sold+converted+transferred+other reconciling exactly to the real
//     day-over-day change even though these sub-types' own signs haven't been individually verified.
const STCRD_CATEGORY = {
  AB: 'sold', DA: 'sold', BE: 'sold', AK: 'sold', DD: 'sold', BM: 'sold', LF: 'sold', OL: 'sold', DB: 'sold', DM: 'sold', OT: 'sold', OR: 'sold',
  // ADDED (2026-08-19 ตามที่ผู้ใช้ระบุ): JX/JT = การรับเข้าล่วงหน้าก่อนเอกสาร RH/RS ตัวจริงจะมาแทนที่ (ถ้า
  // RH/RS มาแล้ว JX/JT จะถูกลบทิ้ง) — ผู้ใช้ยืนยันให้ถือเป็น "รับเข้า" เหมือน RH/RS ตอนคำนวณเทียบยอดนับสต็อก
  RC: 'received', RH: 'received', RR: 'received', RN: 'received', RI: 'received', RS: 'received', PM: 'received', JU: 'received', JW: 'received',
  JX: 'received', JT: 'received',
  RL: 'transferred', VL: 'transferred', TP: 'transferred', MK: 'transferred', TG: 'transferred', LT: 'transferred',
  FF: 'converted',
  CN: 'other', XV: 'other', SR: 'other', XZ: 'other', HN: 'other', HI: 'other', SS: 'other', GR: 'other', XX: 'other', TK: 'other', PI: 'other', KA: 'other', KB: 'other',
};

// STCRD.POSOPR = the line's stock direction, as observed on real data (2026-09-23):
//   0 RH/RS receipt, 1 PM return / JT advance receipt / FF output, 3 transfer destination  -> into stock
//   4 transfer source, 6 KA/KB/KM/XX issue, 8 FF raw material, 9 every sale prefix         -> out of stock
// Anything else (e.g. OE with POSOPR ">") keeps TRNQTY's own sign, as before.
const STCRD_POSOPR_IN = new Set(['0', '1', '3']);
const STCRD_POSOPR_OUT = new Set(['4', '6', '8', '9']);
function stcrdSignedQty(posopr, qty) {
  const pos = String(posopr || '').trim();
  if (STCRD_POSOPR_IN.has(pos)) return Math.abs(qty);
  if (STCRD_POSOPR_OUT.has(pos)) return -Math.abs(qty);
  return qty;
}
// Bucket for prefixes STCRD_CATEGORY doesn't list, so they are still counted instead of dropped.
const STCRD_CATEGORY_BY_POSOPR = { '0': 'received', '1': 'received', '3': 'transferred', '4': 'transferred', '9': 'sold', '6': 'other', '8': 'other' };

// WMS report's own category scheme (confirmed with the user 2026-07-24/27) — see the
// stock_movements_wms_daily comment in db/schema.sql for the full rationale. Narrower/differently
// sliced than STCRD_CATEGORY above, so kept as separate constants rather than reusing it.
// RESOLVED 2026-08-17: audited every STCRD prefix that fell through this scheme uncategorized
// (found via SKU 10140-105's Express-vs-WMS mismatch) and confirmed what each one actually is:
//   OL  = promo giveaway pulled against a real SO (a real outbound movement, sale-equivalent)
//   KB  = internal borrow / office withdrawal ("เบิกยืมสินค้า", "ออฟฟิตเบิก") (real outflow)
//   GR  = transfer receipt into a non-01 warehouse referencing an inter-branch transfer doc (ITAR) —
//     same shape as RL/VL/TP etc., just a prefix the transfer set didn't include yet
//   CP  = a receiving-correction entry paired 1:1 with a same-day, same-qty JU entry (confirmed via
//     SKU 10140-105 2026-07-08: JU6000043 and CP0000009 both +799, referencing the same RH6900618
//     receipt that was itself only keyed for 1 unit) — counting both double-counts a single physical
//     receipt, so only CP is counted here and JU is deliberately left out of every set.
//   PM  = customer product returns ("การรับคืนสินค้า", confirmed by the user 2026-08-17) — own
//     return_qty bucket rather than folded into received_qty, so the WMS report can show it as its
//     own column instead of looking like a physical warehouse receipt.
//   XX  = "สรุปของเสีย,เศษสไลด์,ชิม..." monthly waste/spoilage/tasting write-off ("การตัดสูญเสีย",
//     confirmed by the user 2026-08-17) — own writeoff_qty bucket for the same reason as PM above.
// ADDED (2026-08-19 ตามที่ผู้ใช้ระบุ): JX/JT = การรับเข้าล่วงหน้าก่อนเอกสาร RH/RS ตัวจริงจะมาแทนที่ (ถ้า
// RH/RS มาแล้ว JX/JT จะถูกลบทิ้งจาก Express) — ผู้ใช้ยืนยันให้ถือเป็น "รับเข้า" (received_qty) เหมือน RH/RS
// เท่านั้น (ไม่ใช่ต้นทุนซื้อ — ดู RH_RS_PREFIXES ด้านล่างซึ่งจงใจไม่รวม JX/JT เพราะเป็นเอกสารชั่วคราวที่ถูกลบทิ้ง
// เมื่อ RH/RS ตัวจริงมา ไม่ควรใช้เป็นฐานต้นทุนที่นิ่งแล้ว)
const WMS_RECEIVED_PREFIXES = new Set(['RH', 'RS', 'CP', 'JX', 'JT']);
const WMS_GENERAL_SALE_PREFIXES = new Set([
  'IV', 'AB', 'BE', 'DA', 'AK', 'AY', 'DD', 'DM', 'GP', 'DB', 'IT', 'IE', 'BM', 'FB', 'ON', 'INV', 'BA', 'CJ', 'CK', 'IC', 'DV', 'DL', 'OL', 'KB',
]);
const WMS_TRANSFER_PREFIXES = new Set(['RL', 'VL', 'TP', 'MK', 'TG', 'LT', 'GR']);
const WMS_RETURN_PREFIXES = new Set(['PM']);
const WMS_WRITEOFF_PREFIXES = new Set(['XX']);
const WMS_CONSI_WAREHOUSES = new Set(['03', '04', '05']);
// Purchase-cost basis for the tgm-wms conversion-BOM cost comparison feature (added 2026-08-18,
// confirmed with the user) — RH/RS only, deliberately narrower than WMS_RECEIVED_PREFIXES (which also
// includes CP, a one-off dedup correction for a specific receiving discrepancy, not a real purchase).
const RH_RS_PREFIXES = new Set(['RH', 'RS']);
// ADDED (2026-08-19 ตามที่ผู้ใช้ระบุ, ยืนยันด้วยรายงาน Stock Card จริงของ SKU 10098-9): เอกสาร VL/LT/TP คือ
// การส่งของออกไปสาขา/ลูกค้าปลายทางจริง (พบส่งไปสาขาต่างๆ เช่น "กาญจนาภิเษก"/"พระราม3"/"แจ้งวัฒนะ" ฯลฯ ไม่ใช่
// แค่คลังฝากขาย 03/04/05 อย่างเดียว) — ผู้ใช้ต้องการให้ปลายทางเป็นแบบไหนก็ตาม ถือเป็น "ขายออกไปแล้ว" เหมือนกัน
// หมด ไม่จำกัดเฉพาะ WMS_CONSI_WAREHOUSES เดิม แยกเป็น field ใหม่ต่างหาก (dispatched_qty) ไม่ปนกับ consi/
// transfer bucket เดิม (ยังคงพฤติกรรมเดิมของทุกหน้าที่ใช้ "net" อยู่ต่อไปเป๊ะๆ) เพราะผู้ใช้ระบุชัดว่าต้องการผลนี้
// "เฉพาะในหน้าสรุปสต็อก+ตรวจนับ" ของ tgm-wms เท่านั้น ไม่ใช่ทุกหน้าที่มีคำว่า "net"
const WMS_DISPATCHED_PREFIXES = new Set(['VL', 'LT', 'TP']);
// FIXED (2026-09-22 ตามที่ผู้ใช้ระบุ "หน้าสรุปสต็อก+ตรวจนับ...ยังมีเอาคลัง 8 มารวมอีก" แม้กดคำนวณใหม่แล้ว):
// tgm-wms's net_no10 kind excludes warehouses 02/08/10 entirely (KIND_EXTRA_EXCLUDE_WAREHOUSES ใน App.jsx)
// — เพิ่มขึ้นทีละตัวหลังจากช่อง dispatched_qty นี้ถูกสร้างไปแล้ว (02 เพิ่ม 2026-09-11, 08 เพิ่ม 2026-09-21)
// แต่ไม่เคยย้อนมาอัพเดทเงื่อนไขตรงนี้ให้ตรงกันเลย — ผลคือเอกสาร VL/LT/TP ที่ปลายทางเป็นคลัง 02/08/10 ยังถูกนับ
// เข้า "dispatched" (หักออกอีกชั้นนึง) ทั้งที่ยอดปิดวันของฝั่ง tgm-wms (getStockAsOfDateByWarehouse) ได้ตัดยอด
// คงเหลือของคลัง 02/08/10 ออกไปจากผลรวมทั้งหมดอยู่แล้วตั้งแต่ต้น (เหมือน consi 03/04/05) — กลายเป็นหักซ้ำสอง
// ชั้นสำหรับของที่โยกเข้าคลัง 02/08/10 พอดี (บั๊กคลาสเดียวกับที่เคยแก้ไปแล้วกับ consi 03/04/05 เมื่อ 2026-08-21
// ด้านบน แค่ไม่เคยขยายมาครอบคลุม 02/08/10 ที่เพิ่มเข้ามาทีหลัง) — รวมเป็น set เดียวกันไว้กันลืมขยายซ้ำอีกรอบถ้า
// tgm-wms เพิ่มคลังยกเว้นตัวใหม่ในอนาคต ต้องแก้ทั้ง 2 ที่คู่กันเสมอ (ที่นี่ + KIND_EXTRA_EXCLUDE_WAREHOUSES)
const WMS_NET_NO10_EXTRA_EXCLUDE_WAREHOUSES = new Set(['02', '08', '10']);


const INVOICE_LINE_COMPANIES = ['TSS', 'CONSI'];

function addInvoiceLine(invoiceLines, company, r, day) {
  const prefix = (r.DOCNUM || '').slice(0, 2);
  if (!WMS_GENERAL_SALE_PREFIXES.has(prefix)) return;
  const sku = cleanText(r.STKCOD);
  const warehouse = cleanText(r.LOCCOD);
  const docNum = cleanText(r.DOCNUM);
  const seqNum = cleanText(r.SEQNUM);
  if (!docNum || !sku) return;
  const qty = Number(r.XTRNQTY) || Number(r.TRNQTY) || 0;
  const val = Number(r.TRNVAL) || 0;
  const key = `${company}|${docNum}|${seqNum}|${sku}|${warehouse}`;
  if (!invoiceLines.has(key)) {
    invoiceLines.set(key, {
      company,
      docNum,
      seqNum,
      docDate: day || toIsoDate(r.DOCDAT),
      sku,
      skuName: cleanText(r.STKDES),
      warehouse,
      qty: 0,
      unitCode: cleanText(r.TQUCOD),
      unitFactor: Number(r.TFACTOR) || null,
      lineValue: 0,
      refNum: cleanText(r.REFNUM || r.RDOCNUM),
    });
  }
  const line = invoiceLines.get(key);
  line.qty += Math.abs(qty);
  line.lineValue += val;
}

async function addCompanyInvoiceLines(invoiceLines, company) {
  const rows = await readTable(company, 'STCRD.DBF');
  for (const r of rows) addInvoiceLine(invoiceLines, company, r, toIsoDate(r.DOCDAT));
  return rows.length;
}


function parseInvoiceSourceRef(raw) {
  const text = cleanText(raw);
  if (!text) return null;
  const m = text.match(/^([A-Z0-9-]+)\s+(\d+)$/i);
  if (m) return { docNum: m[1], seqNum: String(Number(m[2])) };
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
    return { docNum: parts.slice(0, -1).join(''), seqNum: String(Number(parts[parts.length - 1])) };
  }
  return { docNum: text, seqNum: '' };
}

function componentCandidateKey(docNum, seqNum) {
  return `${cleanText(docNum)}|${String(seqNum || '').trim().replace(/^0+(?=\d)/, '')}`;
}

async function buildInvoiceLineComponents(invoiceLines) {
  const rows = [];
  for (const company of INVOICE_LINE_COMPANIES) {
    const remarks = await readTable(company, 'ARTRNRM.DBF');
    const remarkByDocSeq = new Map();
    for (const rm of remarks) {
      const docNum = cleanText(rm.DOCNUM);
      const seqNum = cleanText(rm.SEQNUM).replace(/^0+(?=\d)/, '');
      if (!docNum || !seqNum) continue;
      const parsed = parseSalesLineComponentRemark(rm.REMARK);
      if (!parsed?.childCode) continue;
      const key = componentCandidateKey(docNum, seqNum);
      if (!remarkByDocSeq.has(key)) remarkByDocSeq.set(key, []);
      remarkByDocSeq.get(key).push({ ...parsed, sourceDocNum: docNum, sourceSeqNum: seqNum });
    }

    const headerSoByDoc = new Map();
    try {
      const headers = await readTable(company, 'ARTRN.DBF');
      for (const h of headers) {
        const docNum = cleanText(h.DOCNUM);
        const soNum = cleanText(h.SONUM);
        if (docNum && soNum) headerSoByDoc.set(docNum, soNum);
      }
    } catch (_) {}

    for (const d of invoiceLines.values()) {
      if (d.company !== company) continue;
      if (!/^90022(?:-|$)/.test(d.sku || '')) continue;
      const seq = cleanText(d.seqNum).replace(/^0+(?=\d)/, '');
      const candidates = [];
      if (d.docNum && seq) candidates.push({ docNum: d.docNum, seqNum: seq });
      const ref = parseInvoiceSourceRef(d.refNum);
      if (ref?.docNum) candidates.push({ docNum: ref.docNum, seqNum: ref.seqNum || seq });
      const soFromHeader = headerSoByDoc.get(d.docNum);
      if (soFromHeader && seq) candidates.push({ docNum: soFromHeader, seqNum: seq });

      const seenCandidate = new Set();
      const seenComponent = new Set();
      for (const c of candidates) {
        const key = componentCandidateKey(c.docNum, c.seqNum);
        if (seenCandidate.has(key)) continue;
        seenCandidate.add(key);
        const found = remarkByDocSeq.get(key) || [];
        for (const comp of found) {
          const unique = `${company}|${d.docNum}|${seq}|${comp.sourceDocNum}|${comp.sourceSeqNum}|${comp.childCode}|${comp.note}`;
          if (seenComponent.has(unique)) continue;
          seenComponent.add(unique);
          rows.push({
            company,
            docNum: d.docNum,
            seqNum: seq,
            parentSku: d.sku,
            sourceDocNum: comp.sourceDocNum,
            sourceSeqNum: comp.sourceSeqNum,
            childCode: comp.childCode,
            childName: comp.childName,
            childQty: comp.childQty,
            note: comp.note,
          });
        }
      }
    }
  }
  return rows;
}

async function syncStockMovements(db) {
  const rows = await readTable(STOCK_COMPANY, 'STCRD.DBF');
  const daily = new Map(); // `${sku}|${warehouse}|${day}` -> {received,sold,converted,transferred,other}
  const wmsDaily = new Map(); // `${sku}|${day}` -> {received,general_sale,consi,transfer,converted,reserved,return,writeoff,received_value}
  const invoiceLines = new Map(); // `${doc}|${seq}|${sku}|${warehouse}` -> invoice item line from STCRD
  // Bundle/promo codes (e.g. 20284-A = "1 แถม 1" of 20284-5) get a header line on every document plus
  // component lines carrying PSTKCOD = the bundle code. Express moves stock only on the components, so
  // the header line must not count as a stock movement for the bundle code.
  const bundleParentsByDoc = new Map();
  for (const r of rows) {
    const parent = (r.PSTKCOD || '').trim();
    if (!parent) continue;
    const doc = (r.DOCNUM || '').trim();
    if (!bundleParentsByDoc.has(doc)) bundleParentsByDoc.set(doc, new Set());
    bundleParentsByDoc.get(doc).add(parent);
  }
  for (const r of rows) {
    if (!r.STKCOD || !r.LOCCOD) continue;
    const day = toIsoDate(r.DOCDAT);
    if (!day) continue;
    const prefix = (r.DOCNUM || '').slice(0, 2);
    const sku = r.STKCOD.trim();
    const warehouse = r.LOCCOD.trim();
    // FIXED (2026-08-21, confirmed via a standalone read of Z:\ExpressI\TSS\STCRD.DBF against a real
    // printed Express stock-card report for SKU 10140-105/2026-08-21): TRNQTY is in whatever unit that
    // SPECIFIC document's product-code variant was recorded in — bundle/promo sub-codes (e.g. "10140-A1",
    // a "1 free 1" pack variant of base SKU 10140-105, see PSTKCOD) carry a TFACTOR (unit conversion
    // factor, e.g. 2) meaning TRNQTY is HALF of the real base-unit quantity. XTRNQTY is Express's own
    // already-converted quantity (= TRNQTY × TFACTOR when TFACTOR≠1, verified equal to TRNQTY when
    // TFACTOR=1) — it's what the printed report's "จำนวนรับ/จำนวนจ่าย" columns actually show. Using raw
    // TRNQTY silently undercounted every TFACTOR≠1 row (confirmed: AB+BE+DB summed to 467 via TRNQTY vs
    // the report's true 633; LT summed to 85 vs the report's true 170 — both reconcile exactly via
    // XTRNQTY instead) — this was NOT a missing-rows/incomplete-sync issue as first suspected, every row
    // was present and captured, just read from the wrong field. Likely the real explanation behind
    // several of this session's "incomplete history" Express-mismatch reports for OTHER SKUs too,
    // wherever a promotional/bundle sub-code with TFACTOR≠1 was involved.
    const qty = Number(r.XTRNQTY) || 0;
    const val = Number(r.TRNVAL) || 0;

    addInvoiceLine(invoiceLines, STOCK_COMPANY, r, day);

    // FIXED (2026-09-23, verified against Express's own "สินค้าคงเหลือ แยกตามคลังสินค้า" report for
    // 2026-09-22: report + these movements now reproduces live STLOC for all but 10 of ~3,255 SKUs, down
    // from 205). The per-warehouse ledger used to (a) drop any prefix missing from STCRD_CATEGORY —
    // BA/IE/IT/IV/FB/CK/CJ/AY/LE/KM sales and issues were never counted — (b) take sign from the prefix,
    // adding KA/KB/XX issues to stock instead of subtracting them, and assuming warehouse 01 is always a
    // transfer's source, and (c) count bundle header lines. POSOPR already records each line's real
    // direction, so use it; the category only decides which bucket the signed amount lands in.
    const isBundleHeader = bundleParentsByDoc.get((r.DOCNUM || '').trim())?.has(sku);
    const signed = stcrdSignedQty(r.POSOPR, qty);
    if (!isBundleHeader && signed !== 0) {
      const category = STCRD_CATEGORY[prefix] || STCRD_CATEGORY_BY_POSOPR[String(r.POSOPR || '').trim()] || 'other';
      const key = `${sku}|${warehouse}|${day}`;
      if (!daily.has(key)) daily.set(key, { received: 0, sold: 0, converted: 0, transferred: 0, other: 0, pm: 0, wmsReceived: 0 });
      daily.get(key)[category] += signed;
      if (prefix === 'PM' && category === 'received') daily.get(key).pm += signed;
      // the WMS "รับเข้า" definition (RH/RS/CP/JX/JT), per warehouse — what tgm-wms backs out of the
      // count day's Express figure, see migrations.js's wms_received_qty comment
      if (WMS_RECEIVED_PREFIXES.has(prefix)) daily.get(key).wmsReceived += signed;
    }

    // WMS report's own categorization, computed in the same pass to avoid a second DBF read/parse.
    const wmsKey = `${sku}|${day}`;
    const ensureWms = () => {
      if (!wmsDaily.has(wmsKey)) wmsDaily.set(wmsKey, { received: 0, general_sale: 0, consi: 0, transfer: 0, converted: 0, reserved: 0, return: 0, writeoff: 0, received_value: 0, dispatched: 0 });
      return wmsDaily.get(wmsKey);
    };
    if (WMS_RECEIVED_PREFIXES.has(prefix)) {
      ensureWms().received += qty;
    }
    if (RH_RS_PREFIXES.has(prefix)) {
      ensureWms().received_value += val; // purchase cost basis — RH/RS only, see RH_RS_PREFIXES comment
    }
    // FIXED (2026-08-21, confirmed live: SKU 20189-5 on 2026-08-20 had consi_qty=5 and dispatched_qty=8
    // from the SAME sync pass — Express showed a true remaining balance of 3.1 but tgm-wms's Express
    // column computed 0, because getExpressForCountSummary subtracts dispatched_qty ON TOP of "net",
    // and "net" already subtracts consi_qty — a VL/LT/TP document landing in warehouse 03/04/05 was
    // being credited to BOTH consi_qty (line below) AND dispatched_qty (this block), double-subtracting
    // the same physical units): exclude WMS_CONSI_WAREHOUSES here too, matching the destination the
    // "consi" bucket below already claims — dispatched_qty should only cover VL/LT/TP shipments to
    // destinations "net" does NOT already exclude (real branches, warehouse 09, 10, 11, 19, ...).
    if (WMS_DISPATCHED_PREFIXES.has(prefix) && warehouse !== '01' && warehouse !== '19' && !WMS_CONSI_WAREHOUSES.has(warehouse) && !WMS_NET_NO10_EXTRA_EXCLUDE_WAREHOUSES.has(warehouse)) {
      // only the destination-side row is recorded, same reasoning as the transfer/consi bucket below —
      // independent top-level `if` (not part of the if/else chain) so this doesn't change what consi/
      // transfer/reserved already get credited — this is purely an ADDITIONAL field for tgm-wms's
      // StockCountSummaryPage to subtract on top, not a replacement for the existing buckets
      ensureWms().dispatched += qty;
    }
    if (WMS_GENERAL_SALE_PREFIXES.has(prefix)) {
      ensureWms().general_sale -= qty;
    } else if (prefix === 'FF') {
      ensureWms().converted += qty; // already signed in TRNQTY, same as stock_movements_daily
    } else if (WMS_TRANSFER_PREFIXES.has(prefix) && warehouse !== '01') {
      // only the destination-side row is recorded — see schema.sql comment for why
      const bucket = WMS_CONSI_WAREHOUSES.has(warehouse) ? 'consi' : (warehouse === '09' ? 'reserved' : 'transfer');
      ensureWms()[bucket] += qty;
    } else if (WMS_RETURN_PREFIXES.has(prefix)) {
      ensureWms().return += qty;
    } else if (WMS_WRITEOFF_PREFIXES.has(prefix)) {
      ensureWms().writeoff -= qty;
    }
  }
  for (const company of INVOICE_LINE_COMPANIES) {
    if (company === STOCK_COMPANY) continue;
    await addCompanyInvoiceLines(invoiceLines, company);
  }
  const invoiceLineComponents = await buildInvoiceLineComponents(invoiceLines);

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM stock_movements_daily');
    const insert = db.prepare(`
      INSERT INTO stock_movements_daily (sku, warehouse, day, received_qty, sold_qty, converted_qty, transferred_qty, other_qty, pm_qty, wms_received_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    for (const [key, d] of daily) {
      const [sku, warehouse, day] = key.split('|');
      insert.run(sku, warehouse, day, d.received, d.sold, d.converted, d.transferred, d.other, d.pm, d.wmsReceived);
      n++;
    }

    for (const company of INVOICE_LINE_COMPANIES) db.prepare('DELETE FROM invoice_lines WHERE company = ?').run(company);
    const insertInvoiceLine = db.prepare(`
      INSERT INTO invoice_lines (company, doc_num, seq_num, doc_date, sku, sku_name, warehouse, qty, unit_code, unit_factor, line_value, ref_num, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    let nInvoiceLines = 0;
    for (const d of invoiceLines.values()) {
      insertInvoiceLine.run(d.company, d.docNum, d.seqNum, d.docDate, d.sku, d.skuName, d.warehouse, d.qty, d.unitCode, d.unitFactor, d.lineValue, d.refNum);
      nInvoiceLines++;
    }

    for (const company of INVOICE_LINE_COMPANIES) db.prepare('DELETE FROM invoice_line_components WHERE company = ?').run(company);
    const insertInvoiceLineComponent = db.prepare(`
      INSERT OR IGNORE INTO invoice_line_components (company, doc_num, seq_num, parent_sku, source_doc_num, source_seq_num, child_code, child_name, child_qty, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `);
    let nInvoiceLineComponents = 0;
    for (const c of invoiceLineComponents) {
      insertInvoiceLineComponent.run(c.company, c.docNum, c.seqNum, c.parentSku, c.sourceDocNum, c.sourceSeqNum, c.childCode, c.childName, c.childQty, c.note);
      nInvoiceLineComponents++;
    }

    db.exec('DELETE FROM stock_movements_wms_daily');
    const insertWms = db.prepare(`
      INSERT INTO stock_movements_wms_daily (sku, day, received_qty, general_sale_qty, consi_qty, transfer_qty, converted_qty, reserved_qty, return_qty, writeoff_qty, received_value, dispatched_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let nWms = 0;
    for (const [key, d] of wmsDaily) {
      const [sku, day] = key.split('|');
      insertWms.run(sku, day, d.received, d.general_sale, d.consi, d.transfer, d.converted, d.reserved, d.return, d.writeoff, d.received_value, d.dispatched);
      nWms++;
    }

    db.exec('COMMIT');
    console.log(`[importFromExpress] stock movements: ${n} sku/warehouse/day rows, ${nWms} sku/day WMS rows, ${nInvoiceLines} invoice lines, ${nInvoiceLineComponents} invoice line components`);
    return n;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Warehouse code -> name lookup, from Express's generic ISTAB.DBF code-table file (TABTYP='21' rows).
// Small, stable reference table — plain upsert-by-code, no delete-and-reinsert needed.
async function syncWarehouses(db) {
  const rows = await readTable(STOCK_COMPANY, 'ISTAB.DBF');
  const upsert = db.prepare(`
    INSERT INTO warehouses (code, name, description, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description,
      updated_at = excluded.updated_at
  `);
  // FIXED (2026-09-13, /code-review): unwrapped, same gap as syncProducts()/syncCustomers() had —
  // wrapped for the same reason, same established convention.
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.TABTYP !== WAREHOUSE_TABTYP || !r.TYPCOD) continue;
      upsert.run(r.TYPCOD.trim(), (r.SHORTNAM || '').trim() || r.TYPCOD.trim(), (r.TYPDES || '').trim());
      n++;
    }
    db.exec('COMMIT');
    console.log(`[importFromExpress] warehouses: upserted ${n} codes`);
    return n;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// RESOLVED 2026-07-17 (confirmed with user): TSSN-68 and TSS-NV are the same underlying company
// book across a cutover — TSS-NV's Dec 2025–Apr 2026 orders are byte-identical duplicates of
// TSSN-68's (same order_no/order_date/total, confirmed by diffing outbound_orders), because TSS-NV
// was seeded from TSSN-68's history when it was set up, before the two genuinely diverged from
// May 2026 onward. Counting both companies as-is over that window double-counts every sale in it.
// Fix: keep December 2025 (and earlier) from TSSN-68 only; keep January 2026 onward from TSS-NV
// only. This must live here (not a one-off DB fix) because syncSales() wipes and reimports each
// company's full history from its DBF every 5-minute cycle — a manual row fix would be undone by
// the next cron tick.
const CUTOVER_DATE = new Date('2026-01-01T00:00:00Z');
const COMPANY_DATE_CUTOFF = {
  'TSS-68': { before: CUTOVER_DATE },   // TSS-68 is the 2568 archive of TSS; 2026 rows duplicate TSS
  'TSSN-68': { before: CUTOVER_DATE },  // keep only orders strictly before the cutover
  'TSS-NV': { atOrAfter: CUTOVER_DATE }, // keep only orders on/after the cutover
};

function passesCompanyDateCutoff(company, dateValue) {
  const cutoff = COMPANY_DATE_CUTOFF[company];
  if (!cutoff) return true;
  const d = dateValue;
  if (!(d instanceof Date) || isNaN(d)) return false;
  if (cutoff.before && !(d < cutoff.before)) return false;
  if (cutoff.atOrAfter && !(d >= cutoff.atOrAfter)) return false;
  return true;
}

async function syncSales(db) {
  const knownSkus = loadKnownSkuSet(db);
  // dlv_date (DLVDAT) added 2026-08-27 — see schema.sql's comment on outbound_orders.dlv_date
  const insertOrder = db.prepare(`
    INSERT INTO outbound_orders (id, company, order_no, order_date, dlv_date, cust_code, slm_id, doc_status, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET order_date = excluded.order_date, dlv_date = excluded.dlv_date,
      cust_code = excluded.cust_code, slm_id = excluded.slm_id, doc_status = excluded.doc_status,
      total = excluded.total, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  const insertLine = db.prepare(`
    INSERT INTO outbound_lines (order_id, seq_num, sku, qty, unit_price, line_value) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT OR IGNORE INTO sales_line_components (company, order_id, order_no, seq_num, parent_sku, child_code, child_name, child_qty, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTx = db.prepare(`
    INSERT INTO sales_transactions (company, tx_date, sku, cust_code, slm_id, qty, amount, so_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rollupHistory = db.prepare(`
    INSERT INTO sales_history (slm_id, sku, ym, qty, amount)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slm_id, sku, ym) DO UPDATE SET qty = excluded.qty, amount = excluded.amount
  `);

  let ordersImported = 0;
  let linesImported = 0;
  let componentsImported = 0;
  const docStatCounts = {};
  // accumulated ACROSS all (non-CONSI) companies before writing — sales_history is a single blended
  // total per (slm_id, sku, ym), so it must sum every company's contribution in one pass. Rolling it up
  // and writing it out company-by-company (the original bug here) meant each company's upsert overwrote
  // the previous one's numbers instead of adding to them — the final table only reflected the last
  // company processed, silently dropping the other 5's sales.
  const monthly = new Map(); // `${slm_id}|${sku}|${ym}` -> {qty, amount}

  for (const company of SALES_COMPANIES) {
    const headers = await readTable(company, 'OESO.DBF');
    const items = await readTable(company, 'OESOIT.DBF');
    const remarks = await readTable(company, 'ARTRNRM.DBF');

    const byOrder = new Map();
    for (const h of headers) {
      docStatCounts[h.DOCSTAT] = (docStatCounts[h.DOCSTAT] || 0) + 1;
      if (!ORDER_DOCSTAT_INCLUDE.includes(h.DOCSTAT)) continue;
      if (!passesCompanyDateCutoff(company, h.SODAT)) continue;
      byOrder.set(h.SONUM, h);
    }

    db.exec('BEGIN');
    try {
      // wipe this company's rows before reinserting (mirror semantics, avoids duplicate accumulation)
      db.prepare('DELETE FROM sales_line_components WHERE company = ?').run(company);
      db.prepare('DELETE FROM outbound_lines WHERE order_id IN (SELECT id FROM outbound_orders WHERE company = ?)').run(company);
      db.prepare('DELETE FROM outbound_orders WHERE company = ?').run(company);
      db.prepare('DELETE FROM sales_transactions WHERE company = ?').run(company);

      for (const [sonum, h] of byOrder) {
        const orderId = `${company}:${sonum}`;
        insertOrder.run(orderId, company, sonum, toIsoDate(h.SODAT), toIsoDate(h.DLVDAT), h.CUSCOD || null, normalizeSlmCode(h.SLMCOD) || null, h.DOCSTAT || null, h.TOTAL || 0);
        ordersImported++;
      }

      const lineByOrderSeq = new Map();
      for (const it of items) {
        if (!byOrder.has(it.SONUM)) continue; // excluded order (not DOCSTAT='M') or line has no header
        const h = byOrder.get(it.SONUM);
        const orderId = `${company}:${it.SONUM}`;
        const qty = it.ORDQTY || 0;
        const value = it.TRNVAL || 0;
        const seqNum = cleanText(it.SEQNUM);
        const sku = cleanText(it.STKCOD) || null;
        insertLine.run(orderId, seqNum || null, sku, qty, it.UNITPR || 0, value);
        lineByOrderSeq.set(`${it.SONUM}|${seqNum}`, { orderId, orderNo: it.SONUM, parentSku: sku });
        insertTx.run(company, toIsoDate(it.SODAT || h.SODAT), sku, h.CUSCOD || null, normalizeSlmCode(h.SLMCOD) || null, qty, value, it.SONUM);
        linesImported++;

        // plain sales_history stays CONSI-free — see file header. Consignment numbers still live in
        // sales_transactions/outbound_* (company='CONSI') and the v_sc_consi_monthly view built on top.
        const period = ym(it.SODAT || h.SODAT);
        if (period && it.STKCOD && company !== CONSI_COMPANY) {
          const key = `${normalizeSlmCode(h.SLMCOD) || 'ALL'}|${it.STKCOD}|${period}`;
          const cur = monthly.get(key) || { qty: 0, amount: 0 };
          cur.qty += qty;
          cur.amount += value;
          monthly.set(key, cur);

          const allKey = `ALL|${it.STKCOD}|${period}`;
          const curAll = monthly.get(allKey) || { qty: 0, amount: 0 };
          curAll.qty += qty;
          curAll.amount += value;
          monthly.set(allKey, curAll);
        }
      }


      for (const rm of remarks) {
        const orderNo = cleanText(rm.DOCNUM);
        if (!byOrder.has(orderNo)) continue;
        const seqNum = cleanText(rm.SEQNUM);
        const parent = lineByOrderSeq.get(`${orderNo}|${seqNum}`);
        if (!parent?.parentSku) continue;
        const component = parseSalesLineComponentRemark(rm.REMARK);
        if (!acceptsComponent(parent.parentSku, component?.childCode, knownSkus)) continue;
        insertComponent.run(company, parent.orderId, parent.orderNo, seqNum, parent.parentSku, component.childCode, component.childName, component.childQty, component.note);
        componentsImported++;
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM sales_history');
    for (const [key, agg] of monthly) {
      const [slm_id, sku, period] = key.split('|');
      rollupHistory.run(slm_id, sku, period, agg.qty, agg.amount);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  console.log(`[importFromExpress] sales: ${ordersImported} orders, ${linesImported} lines, ${componentsImported} line components. DOCSTAT seen: ${JSON.stringify(docStatCounts)}`);
  return { ordersImported, linesImported, componentsImported };
}

// Real invoiced revenue per Express's own AR ledger (ARTRN.DBF) — see db/schema.sql's
// invoice_sales_monthly comment for why this exists alongside the OESO-derived tables above.
// RECTYP: '1' = cash invoice, '3' = credit invoice, '4' = debit note (all three counted as
// revenue), '5' = credit note/return (subtracted).
// FIXED (2026-08-11): this originally summed TOTAL (VAT-inclusive) and skipped RECTYP='4'
// entirely, landing ~0.15% over a real tax-invoice report (TSS, July 2026: ฿129,917,166 vs the
// report's ฿129,718,431.69). Reconciled to the cent by reading ARTRN.DBF directly: the report's
// figure is exactly SUM(NETVAL) [sales value net of VAT, not TOTAL] over RECTYP 1+3+4-5 — NETVAL
// is what "ยอดขาย" means on Express's own report, TOTAL is the VAT-inclusive amount the customer
// is actually billed. Switched the amount source to NETVAL and added '4' to the included set.
// (Deliberately NOT changing syncInvoices() below, which shares this same RECTYP/company loop
// shape but serves WMS dispatch matching against the real billed amount — TOTAL is correct there.)
async function syncInvoiceSales(db) {
  // Plain INSERT, not upsert: each company's rows are deleted immediately below before these run,
  // so there's never a pre-existing row to conflict with within one sync cycle.
  const insert = db.prepare(`
    INSERT INTO invoice_sales_monthly (company, ym, cust_code, slm_code, amount, invoice_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Include RECTYP='0' as revenue-bearing AI invoices. Confirmed from live TSS ARTRN on
  // 2026-09-18: Express's 2026 year-to-date sales total includes these February AI69...
  // records, and excluding them leaves the dashboard short by ~300,949 THB.
  const INVOICE_RECTYP = new Set(['0', '1', '3', '4', '5']);
  let rowsImported = 0;

  for (const company of SALES_COMPANIES) {
    const rows = await readTable(company, 'ARTRN.DBF');
    const monthly = new Map(); // `${ym}|${cust_code}|${slm_code}` -> {amount, invoice_count}

    for (const r of rows) {
      if (!INVOICE_RECTYP.has(r.RECTYP)) continue;
      if (isExcludedSalesDocNum(r.DOCNUM)) continue;
      if (!passesCompanyDateCutoff(company, r.DOCDAT)) continue;
      const period = ym(r.DOCDAT);
      if (!period) continue;
      const custCode = (r.CUSCOD || '').trim() || '(none)';
      // ARTRN carries its own SLMCOD per transaction — the salesperson recorded at invoice time,
      // not necessarily the customer's current owner in the customers table.
      const slmCode = normalizeSlmCode(r.SLMCOD) || '(none)';
      const signedNetVal = r.RECTYP === '5' ? -(Number(r.NETVAL) || 0) : (Number(r.NETVAL) || 0);
      const key = `${period}|${custCode}|${slmCode}`;
      const cur = monthly.get(key) || { amount: 0, invoice_count: 0 };
      cur.amount += signedNetVal;
      if (r.RECTYP !== '5') cur.invoice_count += 1;
      monthly.set(key, cur);
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM invoice_sales_monthly WHERE company = ?').run(company);
      for (const [key, agg] of monthly) {
        const [period, custCode, slmCode] = key.split('|');
        insert.run(company, period, custCode, slmCode, agg.amount, agg.invoice_count);
        rowsImported++;
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  console.log(`[importFromExpress] invoice sales: ${rowsImported} company/month/customer rows`);
  return rowsImported;
}

// Individual tax-invoice HEADER records — see db/schema.sql's `invoices` table comment for why this
// exists alongside syncInvoiceSales()'s aggregated rollup above. Same RECTYP filter/sign convention
// as syncInvoiceSales() (kept identical deliberately — this is the same underlying data, just not
// pre-aggregated). Scoped to a rolling recent window: dispatch work only cares about invoices that
// might still need fulfilling, not multi-year history.
const INVOICE_SYNC_WINDOW_DAYS = 90;

async function syncInvoices(db) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INVOICE_SYNC_WINDOW_DAYS);
  const routeNames = await loadRouteNameMap();
  const shipToAddresses = await loadShipToAddressMap();

  const upsert = db.prepare(`
    INSERT INTO invoices (doc_num, doc_date, cust_code, slm_code, so_num, total, rectyp, route_code, route_name, ship_to_code, ship_to_address, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(doc_num) DO UPDATE SET doc_date = excluded.doc_date, cust_code = excluded.cust_code,
      slm_code = excluded.slm_code, so_num = excluded.so_num, total = excluded.total,
      rectyp = excluded.rectyp, route_code = excluded.route_code, route_name = excluded.route_name,
      ship_to_code = excluded.ship_to_code, ship_to_address = excluded.ship_to_address,
      updated_at = excluded.updated_at
  `);
  // Keep the document-level invoice import aligned with syncInvoiceSales() above.
  const INVOICE_RECTYP = new Set(['0', '1', '3', '5']);
  const seen = new Set();

  for (const company of SALES_COMPANIES) {
    const rows = await readTable(company, 'ARTRN.DBF');
    for (const r of rows) {
      if (!INVOICE_RECTYP.has(r.RECTYP)) continue;
      if (!r.DOCNUM) continue;
      if (isExcludedSalesDocNum(r.DOCNUM)) continue;
      if (!(r.DOCDAT instanceof Date) || isNaN(r.DOCDAT) || r.DOCDAT < cutoff) continue;
      const docNum = r.DOCNUM.trim();
      if (seen.has(docNum)) continue; // dedupe across companies (first company in SALES_COMPANIES wins, mirrors syncProducts)
      seen.add(docNum);
      const signedTotal = r.RECTYP === '5' ? -(Number(r.TOTAL) || 0) : (Number(r.TOTAL) || 0);
      // ADDED 2026-09-16 (สายรถ feature — see ROUTE_TABTYP comment above): ARTRN.AREACOD is Express's own
      // per-invoice delivery-route code; route_name resolved via ISTAB TABTYP=41, falls back to the raw
      // code itself if a code exists with no matching ISTAB row (better than showing nothing at all).
      const routeCode = (r.AREACOD || '').trim() || null;
      const routeName = routeCode ? (routeNames.get(routeCode) || routeCode) : null;
      const custCode = (r.CUSCOD || '').trim() || null;
      const shipToCode = (r.SHIPTO || '').trim() || null;
      const shipToAddress = custCode && shipToCode ? (shipToAddresses.get(`${custCode}|${shipToCode}`) || null) : null;
      upsert.run(
        docNum, toIsoDate(r.DOCDAT), custCode, normalizeSlmCode(r.SLMCOD) || null,
        (r.SONUM || '').trim() || null, signedTotal, r.RECTYP, routeCode, routeName, shipToCode, shipToAddress,
      );
    }
  }

  // mirror semantics: drop invoices that fell out of the recent window or no longer exist upstream
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _seen_invoices (doc_num TEXT PRIMARY KEY)');
  db.exec('DELETE FROM _seen_invoices');
  const insertSeen = db.prepare('INSERT OR IGNORE INTO _seen_invoices (doc_num) VALUES (?)');
  for (const docNum of seen) insertSeen.run(docNum);
  const deleted = db.prepare('DELETE FROM invoices WHERE doc_num NOT IN (SELECT doc_num FROM _seen_invoices)').run();

  console.log(`[importFromExpress] invoices: upserted ${seen.size} (recent ${INVOICE_SYNC_WINDOW_DAYS}d window), removed ${deleted.changes} fallen out of window`);
  return seen.size;
}

// Promotion price documents — see db/schema.sql's promo_docs comment for the full story. Confirmed
// 2026-08-2x by inspecting real production DBF data: Express has no separate quotation/promotion
// file, these are OESO.DBF header rows (SORECTYP='5') whose SONUM happens to start with 'P1' or 'P2',
// living in the exact same file as every other Sales Order. Price is per product line
// (OESOIT.DBF.UNITPR), not the header total, so this reads both files and joins on SONUM.
//
// Scoped to TSS+CONSI only (confirmed 2026-08-24) — checked every company in SALES_COMPANIES
// individually against real DBF data first: TGM/TSS-68/TSS-67 do have P1/P2 documents, but their
// handful of DOCSTAT='M' rows all turned out to have ZERO matching OESOIT.DBF line items (empty
// header-only documents), so including them contributed nothing but wasted sync time reading their
// (large) OESO/OESOIT files every cycle.
//
// DOCSTAT filter is per-company. Originally (2026-08-24) TSS kept 'M' only (confirmed), matching
// ORDER_DOCSTAT_INCLUDE's convention for regular orders, while CONSI's P1/P2 documents — almost
// entirely DOCSTAT='N' (not yet confirmed) — additionally included 'N' since 'M' only produced zero
// CONSI rows.
// WIDENED 2026-08-26 (real bug report: "created promo docs from yesterday/today aren't showing"):
// checked every TSS promo doc created in the prior 2 days (54 rows, by CHGDAT) and found 51 'N' + 3
// 'C', literally ZERO 'M' — a brand-new TSS document always starts 'N' and only becomes 'M' once
// someone confirms it in Express, so the old 'M'-only rule hid every TSS promo doc for however long
// that confirmation lag runs. TSS now matches CONSI's rule (M+N). 'C' stays excluded everywhere —
// confirmed elsewhere in this file (see this function's header comment) that 'C' means closed/
// cancelled. index.html's promoRender() shows a status badge per row so an 'N' row is never mistaken
// for a confirmed 'M' one.
const PROMO_DOC_PREFIXES = ['P1', 'P2'];
const PROMO_DOC_COMPANIES = ['TSS', 'CONSI'];
const PROMO_DOC_STATUS_INCLUDE = { TSS: ['M', 'N'], CONSI: ['M', 'N'] };

async function syncPromoDocs(db) {
  const insert = db.prepare(`
    INSERT INTO promo_docs (company, sonum, seqnum, cust_code, cust_name, sku, sku_name, unit_price, start_date, due_date, docstat, create_date, doc_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const custName = db.prepare('SELECT name FROM customers WHERE code = ?');
  let rowsImported = 0;

  for (const company of PROMO_DOC_COMPANIES) {
    const statusInclude = PROMO_DOC_STATUS_INCLUDE[company] || ['M'];
    const headers = await readTable(company, 'OESO.DBF');
    // Confirmed against real DBF data 2026-08-26: OESO.DBF's header-level SODAT/DLVDAT are always
    // identical to the corresponding OESOIT.DBF line's SODAT/DLVDAT (a line simply inherits its
    // header's dates) — that's what start_date/due_date below already read.
    //
    // create_date/doc_ref are new, header-only fields with no line-level counterpart. Confirmed by
    // matching a live document (P26900491, company TSS) against Express's own UI screenshots:
    // create_date is CHGDAT, NOT SODAT — Express's "รายละเอียดแฟ้มข้อมูล" (record info) popup shows
    // "ผู้บันทึก: TIPPAWAN" / "วันที่: 21/08/69" for that exact record, which matched USERID=TIPPAWAN
    // and CHGDAT=2026-08-21 exactly (its SODAT was coincidentally the same day too, but sibling
    // P26900467/468/469 show CHGDAT running days after SODAT, proving they're genuinely different
    // fields — SODAT is the order/validity date already shown as start_date, CHGDAT is Express's own
    // "recorded" date). doc_ref is YOUREF ("your reference") — confirmed against the same live
    // document: its on-screen "อ้างอิง" field read "119150/119149", an exact match for that record's
    // YOUREF. RFF, the other Express reference field, was checked across all 8 company books (230k+
    // OESO.DBF rows total) and found empty on literally every single row — never used.
    const headerBySonum = new Map();
    for (const h of headers) {
      const sonum = (h.SONUM || '').trim();
      if (!sonum || !PROMO_DOC_PREFIXES.some((p) => sonum.startsWith(p))) continue;
      if (!statusInclude.includes(h.DOCSTAT)) continue;
      headerBySonum.set(sonum, {
        docstat: h.DOCSTAT,
        createDate: toIsoDate(h.CHGDAT),
        docRef: (h.YOUREF || '').trim() || null,
      });
    }
    // FIXED (found by /qa-tester review): this used to `continue` here when a company had no
    // matching SONUM, which skipped the DELETE below too — if a company that HAD promo_docs rows
    // from a prior cycle lost all its P1/P2+DOCSTAT='M' documents (expired/cancelled in Express),
    // its stale rows would sit in promo_docs forever with no signal anything was wrong. Every sibling
    // sync function in this file (syncInvoiceSales, syncInvoices) always deletes-then-reinserts
    // regardless of whether there's new data — this now matches that. Only the OESOIT.DBF read
    // (potentially hundreds of thousands of rows per company) is skipped as an optimization; the
    // wipe+reinsert below always runs.
    const rows = [];
    if (headerBySonum.size > 0) {
      const lines = await readTable(company, 'OESOIT.DBF');
      for (const l of lines) {
        const sonum = (l.SONUM || '').trim();
        const header = headerBySonum.get(sonum);
        if (!header) continue;
        const custCode = (l.CUSCOD || '').trim() || null;
        rows.push({
          sonum,
          seqnum: (l.SEQNUM || '').trim(),
          custCode,
          custName: custCode ? custName.get(custCode)?.name || null : null,
          sku: (l.STKCOD || '').trim() || null,
          skuName: (l.STKDES || '').trim() || null,
          unitPrice: Number(l.UNITPR) || 0,
          startDate: toIsoDate(l.SODAT),
          dueDate: toIsoDate(l.DLVDAT),
          docstat: header.docstat,
          createDate: header.createDate,
          docRef: header.docRef,
        });
      }
    }

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM promo_docs WHERE company = ?').run(company);
      for (const r of rows) {
        insert.run(company, r.sonum, r.seqnum, r.custCode, r.custName, r.sku, r.skuName, r.unitPrice, r.startDate, r.dueDate, r.docstat, r.createDate, r.docRef);
        rowsImported++;
      }

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  console.log(`[importFromExpress] promo docs: ${rowsImported} line rows`);
  return rowsImported;
}

// Confirmed with user 2026-08-13: Express's STKGRP master defines only 001-006 as real product
// categories (see index.html's _STKGRP_LABELS/expressGroupLabel) — everything else (FO/EO/JO/BO/HO/
// BK/HR/FIX/LO/CO/OT/IC/DO/GO/คชจ/blank) is a non-product cost/expense code that occasionally lands
// on an order line. Excluded below so the order-based rollups (Dashboard tiles, Sales Overview's
// product/customer/salesperson breakdown) only count real product sales. Deliberately NOT applied to
// invoice_sales_monthly (the reconciled headline total, syncInvoiceSales() above) — ARTRN.DBF carries
// no SKU/STKGRP field at all, so that figure can't be filtered by product group; it stays the full
// invoice total to keep matching Express's own tax-invoice report exactly.
const REAL_PRODUCT_GROUPS = ['001', '002', '003', '004', '005', '006'];
const REAL_PRODUCT_GROUPS_SQL = REAL_PRODUCT_GROUPS.map((g) => `'${g}'`).join(',');

// Rebuilds the 3 materialized sales rollup tables from sales_transactions (see db/schema.sql for why
// these are real tables instead of views — a live GROUP BY over ~1M rows took 2.7-3.3s *per paginated
// query*, dozens of times per page load). Runs once per 5-minute cycle, after syncSales() has refreshed
// sales_transactions, so these are never more than one cycle stale.
//
// Scoped to a rolling window (current + previous month) instead of the full ~1.4M-row history: closed
// months are immutable once synced (syncSales() re-mirrors the same DBF values every cycle), so only
// the current/previous month can still receive backdated corrections (late invoices, credit notes).
// Rebuilding just that window measured ~4x faster per query (2875ms -> 653ms on the dashboard rollup
// alone, live) and cuts refreshSalesRollups from ~27s to a few seconds — this ran on its own worker
// thread already (see jobs/syncWorker.js) so it never blocked the HTTP server, but a shorter cycle
// still means less DB write-lock contention and a smaller window for WAL checkpoint stalls to land in.
function refreshSalesRollups(db) {
  const t0 = Date.now();
  // A brand-new/empty DB (fresh install, or these tables recreated) has no prior full history to
  // fall back on — do one full rebuild in that case; every cycle after that, the table is non-empty
  // and this takes the fast scoped path.
  const isEmpty = db.prepare('SELECT COUNT(*) AS n FROM v_sc_dashboard_sales_monthly').get().n === 0;
  const cutoffYm = isEmpty ? '0000-00' : db.prepare("SELECT strftime('%Y-%m','now','-1 month') AS ym").get().ym;

  // 3 separate transactions instead of 1 — measured live at 12-20s+ combined, which sat well above
  // both connections' busy_timeout and was the main source of "database is locked" 500s on ordinary
  // user requests (e.g. the per-request session-expiry UPDATE in middleware/auth.js). Splitting this
  // doesn't reduce total work, but it releases the write lock between tables so a request queued up
  // behind one ~4-7s chunk isn't also stuck behind the other two.
  function runRollupStep(deleteSql, insertSql, label) {
    db.exec('BEGIN');
    try {
      db.prepare(deleteSql).run(cutoffYm);
      db.prepare(insertSql).run(cutoffYm);

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  runRollupStep(
    'DELETE FROM v_sc_dashboard_sales_monthly WHERE ym >= ?',
    `INSERT INTO v_sc_dashboard_sales_monthly (ym, company, prod_code, prod_name, prod_group, qty, amount, invoice_count)
     SELECT strftime('%Y-%m', t.tx_date), t.company, t.sku, p.name, p.group_name, SUM(t.qty), SUM(t.amount), COUNT(DISTINCT t.so_ref)
     FROM sales_transactions t
     LEFT JOIN products p ON p.code = t.sku
     WHERE t.tx_date IS NOT NULL AND t.sku IS NOT NULL AND strftime('%Y-%m', t.tx_date) >= ?
       AND p.group_name IN (${REAL_PRODUCT_GROUPS_SQL})
     GROUP BY 1, t.company, t.sku`,
  );

  runRollupStep(
    'DELETE FROM v_sales_history_company WHERE ym >= ?',
    `INSERT INTO v_sales_history_company (slm_id, sku, ym, qty, amount, company, product_name, group_name, plant)
     SELECT COALESCE(t.slm_id,''), t.sku, strftime('%Y-%m', t.tx_date), SUM(t.qty), SUM(t.amount), t.company, p.name, p.group_name, p.plant
     FROM sales_transactions t
     LEFT JOIN products p ON p.code = t.sku
     WHERE t.tx_date IS NOT NULL AND t.sku IS NOT NULL AND strftime('%Y-%m', t.tx_date) >= ?
       AND p.group_name IN (${REAL_PRODUCT_GROUPS_SQL})
     GROUP BY t.company, COALESCE(t.slm_id,''), t.sku, 3`,
  );

  runRollupStep(
    'DELETE FROM v_sales_overview_sales_monthly WHERE ym >= ?',
    `INSERT INTO v_sales_overview_sales_monthly
       (ym, company, slm_owner, category, corporate, cust_code, cust_name, prod_group, prod_code, prod_name, qty, amount, invoice_count)
     SELECT strftime('%Y-%m', t.tx_date), t.company, COALESCE(t.slm_id,''), cp.category, cp.corporate,
       COALESCE(t.cust_code,''), c.name, p.group_name, t.sku, p.name, SUM(t.qty), SUM(t.amount), COUNT(DISTINCT t.so_ref)
     FROM sales_transactions t
     LEFT JOIN products p ON p.code = t.sku
     LEFT JOIN customers c ON c.code = t.cust_code
     LEFT JOIN customer_profiles cp ON cp.code = t.cust_code
     WHERE t.tx_date IS NOT NULL AND t.sku IS NOT NULL AND strftime('%Y-%m', t.tx_date) >= ?
       AND p.group_name IN (${REAL_PRODUCT_GROUPS_SQL})
     GROUP BY t.company, COALESCE(t.slm_id,''), COALESCE(t.cust_code,''), t.sku, 1`,
  );

  console.log(`[importFromExpress] refreshSalesRollups: done in ${Date.now() - t0}ms (${isEmpty ? 'full rebuild, first run' : `rebuilt ym >= ${cutoffYm}`})`);
}

async function runImport(db) {
  const startedAt = new Date().toISOString();
  const info = db.prepare('INSERT INTO sync_log (source, started_at, status) VALUES (?, ?, ?)').run(EXPRESS_ROOT, startedAt, 'running');
  const logId = info.lastInsertRowid;
  let rowsProcessed = 0;

  try {
    // ADDED (2026-08-20): confirmed live via service-stdout-20260820T005006 log that Z:\ExpressI can go
    // unreachable mid-session (network drive disconnect) WITHOUT any read throwing — fs.existsSync/
    // readdirSync on a vanished path just come back empty, so findFile()/readTable() silently report "0
    // records" exactly like a genuinely-empty table. syncStock/syncStockMovements/syncSales/
    // syncInvoiceSales/syncInvoices all do a full DELETE+reinsert every cycle with no such distinction —
    // one bad cycle during a network blip wiped `stock` and `stock_movements_wms_daily` down to 0 rows
    // (every table dropped to 0 in the same cycle, right after ~15 healthy cycles in a row, no error
    // logged anywhere). Abort BEFORE any sync runs if the root itself — or TSS's own folder, which every
    // table depends on — isn't there, so a transient network blip just skips a cycle (old data stays
    // intact) instead of silently overwriting real data with a false "0 rows" reading.
    if (!fs.existsSync(EXPRESS_ROOT) || !fs.existsSync(path.join(EXPRESS_ROOT, STOCK_COMPANY))) {
      throw new Error(`Express DBF root unreachable: ${path.join(EXPRESS_ROOT, STOCK_COMPANY)} not found (mapped drive disconnected?) — skipped this cycle to avoid wiping existing data`);
    }
    rowsProcessed += await syncProducts(db);
    rowsProcessed += await syncCustomers(db);
    rowsProcessed += await syncWarehouses(db);
    rowsProcessed += await syncStock(db);
    rowsProcessed += await syncStockMovements(db);
    const salesResult = await syncSales(db);
    rowsProcessed += salesResult.ordersImported + salesResult.linesImported + (salesResult.componentsImported || 0);
    refreshSalesRollups(db);
    rowsProcessed += await syncInvoiceSales(db);
    rowsProcessed += await syncInvoices(db);
    rowsProcessed += await syncPromoDocs(db);

    // standing tripwire: surface data-quality regressions automatically instead of needing a manual
    // DBF-reading investigation every time someone wonders "is the import still correct" — see
    // v_sc_data_confidence / v_sc_import_health_by_company in db/schema.sql for what these mean.
    const confidence = db.prepare('SELECT orphan_sku_consi_count, orphan_sku_sales_count, orphan_sku_stock_count FROM v_sc_data_confidence').get();
    if (confidence.orphan_sku_consi_count > 0 || confidence.orphan_sku_sales_count > 0 || confidence.orphan_sku_stock_count > 0) {
      console.warn(`[importFromExpress] orphan SKU check: consi=${confidence.orphan_sku_consi_count} sales=${confidence.orphan_sku_sales_count} stock=${confidence.orphan_sku_stock_count} (SKUs referenced but missing from products)`);
    }

    db.prepare("UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'ok', rows_processed = ? WHERE id = ?")
      .run(rowsProcessed, logId);
  } catch (e) {
    console.error('[importFromExpress] failed:', e.message);
    db.prepare("UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status = 'error', message = ?, rows_processed = ? WHERE id = ?")
      .run(e.message, rowsProcessed, logId);
  }
}

module.exports = { runImport, refreshSalesRollups, syncProducts, syncSales, syncInvoiceSales, syncInvoices, syncPromoDocs, syncStockMovements, syncWarehouses, isExcludedSalesDocNum, EXPRESS_ROOT, STOCK_COMPANY, SALES_COMPANIES, PRODUCT_COMPANIES };
