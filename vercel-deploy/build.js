// Builds the Vercel-hosted copy of index.html: the source file (../index.html) is served
// same-origin locally, so it infers API_BASE from location.origin. A Vercel-hosted copy has no
// same-origin API to fall back to, so this injects a window.TGM_API_BASE override pointing at the
// Cloudflare Tunnel hostname for this machine's local server, before the main app script runs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { minify } = require('terser');
const { extract } = require('../deploy-shared/extract');

// TEMPORARY STOPGAP #2 (2026-08-26): ngrok's free account hit its MONTHLY BANDWIDTH CAP (every API
// call started failing with a 403 "network bandwidth limit" error, code 725 — confirmed via
// https://dashboard.ngrok.com/billing) — a real, full outage, not a code bug. Checked whether the
// original https://supplychain.tgm.co.th Cloudflare Tunnel (see the 2026-08-04 note below — it's
// still running as a Windows service on the DB PC right now, config at
// C:\Users\TSS\.cloudflared\config.yml) was usable yet: still isn't, tgm.co.th's nameservers still
// aren't pointed at Cloudflare (unchanged since 2026-08-04). Started an ad-hoc Cloudflare "quick
// tunnel" instead (`cloudflared tunnel --config <empty file> --url http://localhost:3000` — the
// --config override matters, otherwise cloudflared silently loads ~/.cloudflared/config.yml and
// applies THAT tunnel's hostname-restricted ingress rules, 404-ing every request to the quick
// tunnel's own random hostname). No bandwidth cap on this, unlike ngrok — but the URL is NOT stable:
// it changes every time this process restarts (machine reboot, terminal closed, crash), unlike
// ngrok's assigned-static-domain free tier. Whoever restarts it must get the new
// https://<random-words>.trycloudflare.com URL from its own console output, paste it in below,
// rebuild, redeploy, and re-run `vercel alias set`. MUST be swapped to
// https://supplychain.tgm.co.th (stable, already running as a service, survives reboots on its own)
// once tgm.co.th's nameservers actually point at Cloudflare — that fixes both the bandwidth-cap risk
// and this URL-instability problem in one move; ask IT/whoever manages the tgm.co.th registrar.
// UPDATE (2026-09-13): rotated again after a TGMSupplyChainServer restart (deploying the session-
// throttle fix + code-review security fixes) — the TGMQuickTunnel service should survive a main-
// server restart per the 2026-09-10b note above, but the hostname changed anyway; new URL read
// straight from server/tunnel-quick-stderr.log and confirmed live via curl before using it here.
// UPDATE (2026-09-15): quick tunnel rotated again (recurring failure mode — see history above).
// New URL confirmed live via /api/health before using it here. This is what caused the reported
// "SADM can't log in" issue — it wasn't credentials, the API host was unreachable for everyone.
const API_BASE_URL = require('../deploy-shared/api-config').getApiBase();
// Earlier stopgap (ngrok, free bandwidth cap hit 2026-08-26 — do not use until upgraded/reset):
// const API_BASE_URL = 'https://tactless-decency-liquefy.ngrok-free.dev';
// Real, permanent value (restore once tgm.co.th's Nameservers point to Cloudflare):
// const API_BASE_URL = 'https://supplychain.tgm.co.th';
//
// UPDATE (2026-09-10b): the quick tunnel is now its own NSSM Windows service (`TGMQuickTunnel`, see
// server/install-services.ps1) instead of an ad-hoc terminal process — it survives reboots and
// TGMSupplyChainServer restarts on its own now, which is what caused the two outages below. This
// does NOT make the URL itself permanent: this service's OWN restart (crash, reboot, `nssm restart
// TGMQuickTunnel`, or reinstalling via install-services.ps1) still gets cloudflare to hand out a
// brand-new random hostname, same as any quick tunnel. After any such restart, read the new URL from
// server/tunnel-quick-stderr.log and repeat this update+build+deploy. The permanent fix is still
// getting tgm.co.th's nameservers confirmed pointed at Cloudflare so `supplychain.tgm.co.th` can be
// used instead (see the 2026-09-08 note below for why that's not ready yet).
//
// UPDATE (2026-09-10, SECOND outage of this exact kind in ~48h — see 2026-09-08 note below for the
// first): the quick-tunnel URL from 2026-09-08 died again (this dev machine's own TGMSupplyChainServer
// service restart on 2026-09-09, done to pick up the promo-draft redesign's schema changes, seems to
// have also taken down the ad-hoc `cloudflared` process the old URL depended on — that process was
// never a service, so nothing brought it back). Started a fresh quick tunnel the same way (--config
// empty-cloudflared-config.yml, NOT the default config — see the 2026-08-26 note) and confirmed it
// live via /api/health before swapping in this URL. Checked `supplychain.tgm.co.th` again too — still
// does not resolve externally (tested via a fetch from outside this machine's own network, not just
// this machine's resolver), so the nameserver switch still hasn't propagated / hasn't happened. This
// was a recurring failure mode (2 outages in 2 days) — fixed for good in the 2026-09-10b update above
// by making the quick tunnel its own service.
// UPDATE (2026-09-08, previous quick-tunnel URL died — ERR_NAME_NOT_RESOLVED reported on Dashboard):
// swapped in a fresh quick-tunnel URL. While investigating, found `supplychain.tgm.co.th` now
// resolves via external DNS (queried 8.8.8.8 directly) to the named tunnel's cfargotunnel.com CNAME
// — the nameserver switch this comment has been waiting on may have actually happened. BUT this dev
// machine's own default DNS resolver still can't resolve it (`curl https://supplychain.tgm.co.th`
// fails with "Could not resolve host" even though `nslookup ... 8.8.8.8` succeeds) — likely
// propagation lag or a stale local/ISP resolver cache, not a config problem. Do NOT switch
// API_BASE_URL to it yet based on this alone — confirm it resolves from an end user's own network
// first (their office wifi, not this machine), since a premature switch could break the site for
// everyone the same way this quick-tunnel death just did. If confirmed working, switch here and this
// whole "URL dies on every restart" problem goes away for good.

const srcPath = path.join(__dirname, '..', 'index.html');
const outDir = path.join(__dirname, 'public');
const outPath = path.join(outDir, 'index.html');

async function build() {
  let html = fs.readFileSync(srcPath, 'utf8');

  // Phase 4 (2026-09-15, menu-fuzzy-willow.md plan): this app is now Sales-only — strip out
  // Planning-only + WMS-only top-level functions/vars and rewrite RNAV via the same AST-based
  // extract.js tool already proven against ../planning-deploy/build.js.
  html = html.replace('<script src="/shared/approval-workflow.js"></script>', '<script id="approval-workflow">' + fs.readFileSync(path.join(__dirname, '../shared/approval-workflow.js'), 'utf8') + '</script>');
  html = extract(html, 'sales');

  // window.TGM_API_BASE + window.APP_DEPT override + a preconnect hint for that same cross-origin
  // host (added 2026-08-27, general load-speed pass): without this the browser doesn't start the
  // TCP/TLS handshake to the API origin until the app's first real fetch() call fires deep into
  // init — preconnect lets that handshake happen in parallel with the rest of page parsing instead.
  const marker = '<head>';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('Could not find <head> in index.html');
  // id="tgm-api-base-inject" is load-bearing, not decorative: without it this tag's own bare
  // <script> would collide with the indexOf('<script>') search below (which must find ONLY the big
  // inline app script further down the file) — found live via a real build that silently minified
  // this 1-line snippet instead of the actual app code, leaving the deployed app un-minified with no
  // error raised.
  const inject = `<head>\n<link rel="preconnect" href="${API_BASE_URL}">\n<script id="tgm-api-base-inject">window.TGM_API_BASE='${API_BASE_URL}';window.APP_DEPT='sales';</script>`;
  html = html.slice(0, idx) + inject + html.slice(idx + marker.length);

  // Minify only the deployed COPY's inline app script — never touch ../index.html itself, which
  // deliberately keeps this project's extensive historical "why" comments for future development.
  // Added 2026-08-27: measured real savings on this exact file — minifying dropped the raw script
  // ~19%, and (importantly, since gzip compression was already added earlier the same week) STILL
  // saved ~20% / ~43KB after gzip too, because mangling identifiers and stripping comments reduces
  // the entropy gzip has to encode, not just literal byte count. terser is AST-based, so it's safe
  // against this codebase's Thai string literals, regex literals (e.g. /^[0-9]/), and "//" appearing
  // inside string values — a naive regex-based comment stripper would NOT be safe here.
  // Exactly one inline <script> (no src/attributes) exists in the source — confirmed via
  // `grep -c "<script"` / `grep -c "</script>"` both returning 2 (this one + the deferred Supabase
  // CDN <script src=... defer></script>, which has no body to minify).
  const scriptOpen = '<script>';
  const scriptStart = html.indexOf(scriptOpen);
  if (scriptStart === -1) throw new Error('Could not find the inline <script> in index.html');
  const codeStart = scriptStart + scriptOpen.length;
  const codeEnd = html.indexOf('</script>', codeStart);
  if (codeEnd === -1) throw new Error('Could not find the closing </script> for the inline script');
  const rawScript = html.slice(codeStart, codeEnd);
  // Sanity floor, not a real limit: the app script has been 700KB+ all session — anything smaller
  // here means the id="tgm-api-base-inject" guard above broke and this just grabbed the wrong tag
  // again. Fail loudly instead of silently shipping an un-minified (or empty) build.
  if (rawScript.length < 100_000) throw new Error(`Extracted script looks too small (${rawScript.length} bytes) — likely matched the wrong <script> tag`);

  const result = await minify(rawScript, { compress: true, mangle: true });
  if (!result.code) throw new Error('terser produced no output — check for a minify error: ' + (result.error || 'unknown'));
  html = html.slice(0, codeStart) + result.code + html.slice(codeEnd);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');

  const gzipSize = zlib.gzipSync(html).length;
  console.log(`Built ${outPath} (${(html.length / 1024).toFixed(0)} KB raw, ${(gzipSize / 1024).toFixed(0)} KB gzipped), API_BASE=${API_BASE_URL}`);
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
