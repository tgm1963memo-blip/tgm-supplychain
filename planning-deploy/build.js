// Builds the Vercel-hosted Planning-department copy of ../index.html. Mirrors ../vercel-deploy/build.js
// (the Sales app's build tooling) with two differences: (1) runs ../deploy-shared/extract.js first to
// strip out Sales-only + WMS-only top-level functions/vars and rewrite RNAV for targetApp='planning'
// (per the approved plan at menu-fuzzy-willow.md — same server/DB, split frontend only); (2) injects
// window.APP_DEPT='planning' alongside window.TGM_API_BASE so doLogin()/restoreSession()'s department
// guard blocks sales_*-exclusive accounts from this build.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { minify } = require('terser');
const { extract } = require('../deploy-shared/extract');

// Same backend as the Sales app (one shared server/DB — see plan) — keep this in sync with
// ../vercel-deploy/build.js's API_BASE_URL by hand whenever the tunnel URL rotates (see that file's
// extensive history of why the URL is not stable). Read the current value from there before deploying.
// UPDATE (2026-09-15): quick tunnel rotated — confirmed live via /api/health before using it here.
const API_BASE_URL = require('../deploy-shared/api-config').getApiBase();

const srcPath = path.join(__dirname, '..', 'index.html');
const outDir = path.join(__dirname, 'public');
const outPath = path.join(outDir, 'index.html');

async function build() {
  let html = fs.readFileSync(srcPath, 'utf8');

  html = html.replace('<script src="/shared/approval-workflow.js"></script>', '<script id="approval-workflow">' + fs.readFileSync(path.join(__dirname, '../shared/approval-workflow.js'), 'utf8') + '</script>');
  html = extract(html, 'planning');

  // แบรนด์เฉพาะแอปนี้: index.html ต้นทางใช้ "TSS Supply Chain" ร่วมกันทั้ง 2 แอป (Phase 0 เปลี่ยนแค่ TGM→TSS
  // เท่านั้น ไม่แยกชื่อต่อแผนก) — ผู้ใช้ขอให้แอป Planning โชว์ "TSS Planning" แทน เพื่อแยกแยะจากแอป Sales บน
  // หน้าจอจริง (สับสนถ้า login คนละเว็บแต่เห็นชื่อเดียวกัน) ทำที่นี่ (build output เท่านั้น) ไม่แก้ index.html
  // ต้นทาง เพราะ vercel-deploy/build.js (แอป Sales) ยังต้องใช้ "TSS Supply Chain" เหมือนเดิม
  html = html.split('TSS Supply Chain').join('TSS Planning');

  // window.TGM_API_BASE + window.APP_DEPT override + preconnect hint — same pattern as vercel-deploy/build.js.
  const marker = '<head>';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('Could not find <head> in index.html');
  const inject = `<head>\n<link rel="preconnect" href="${API_BASE_URL}">\n<script id="tgm-api-base-inject">window.TGM_API_BASE='${API_BASE_URL}';window.APP_DEPT='planning';</script>`;
  html = html.slice(0, idx) + inject + html.slice(idx + marker.length);

  // Minify only the deployed COPY's inline app script — same approach/caveats as vercel-deploy/build.js.
  const scriptOpen = '<script>';
  const scriptStart = html.indexOf(scriptOpen);
  if (scriptStart === -1) throw new Error('Could not find the inline <script> in index.html');
  const codeStart = scriptStart + scriptOpen.length;
  const codeEnd = html.indexOf('</script>', codeStart);
  if (codeEnd === -1) throw new Error('Could not find the closing </script> for the inline script');
  const rawScript = html.slice(codeStart, codeEnd);
  if (rawScript.length < 50_000) throw new Error(`Extracted script looks too small (${rawScript.length} bytes) — likely matched the wrong <script> tag`);

  const result = await minify(rawScript, { compress: true, mangle: true });
  if (!result.code) throw new Error('terser produced no output — check for a minify error: ' + (result.error || 'unknown'));
  html = html.slice(0, codeStart) + result.code + html.slice(codeEnd);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  const gzipSize = zlib.gzipSync(html).length;
  console.log(`Built ${outPath} (${(html.length / 1024).toFixed(0)} KB raw, ${(gzipSize / 1024).toFixed(0)} KB gzipped), API_BASE=${API_BASE_URL}, APP_DEPT=planning`);
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
