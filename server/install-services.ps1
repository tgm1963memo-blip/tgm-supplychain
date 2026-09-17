# Run this script as Administrator (right-click PowerShell -> "Run as Administrator", then run this file)
# Sets up TGM Supply Chain server + Cloudflare Tunnel as permanent Windows services.
#
# Deliberately NOT setting $ErrorActionPreference = 'Stop': in Windows PowerShell 5.1, any stderr
# line from a native exe (nssm.exe included) raises a NativeCommandError regardless of `2>$null`
# redirection, and 'Stop' would escalate that to a terminating error — which killed this script on
# its very first (expected, harmless) "Can't open service!" from Reset-NssmService on a fresh
# machine that has no such service yet. Leaving the default 'Continue' preference lets each nssm
# call's own success/failure speak for itself; the final Get-Service block is the real verdict.

# Uses the 8.3 short path (no Thai characters) for $serverDir on purpose — Windows PowerShell 5.1
# reads a BOM-less script file using the system ANSI codepage (874/Thai here), not UTF-8, so a
# literal Thai path baked into this file corrupts into mojibake and breaks parsing. The short path
# sidesteps the whole issue; it's ASCII-only and points at the exact same folder.
$nssm = "C:\Users\TSS\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe"
$serverDir = "C:\Users\TSS\OneDrive\BEDD~1\TGM-SU~1\server"
$nodeExe = "C:\Program Files\nodejs\node.exe"
$cloudflaredExe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

function Reset-NssmService($name) {
  & $nssm stop $name 2>$null | Out-Null
  & $nssm remove $name confirm 2>$null | Out-Null
}

Write-Host "=== TGMSupplyChainServer ==="
# FIXED (2026-09-10, real outage): Reset-NssmService REMOVES the service before reinstalling it,
# which wipes EVERY previously-`nssm set` parameter — AppEnvironmentExtra included. This script never
# re-set DB_PATH here, so the first time it was re-run (to add TGMQuickTunnel below), the live server
# silently lost its DB_PATH override and fell back to db/init.js's default path (server/db/tgm.db,
# INSIDE this OneDrive-synced folder — exactly what DB_PATH exists to avoid, see server/.env's
# 2026-08-03 incident comment). That default file happened to already exist (a stray empty dev DB from
# an unrelated debugging session) with its own freshly-seeded SADM user, so the app kept running and
# LOOKED fine — Dashboard just silently showed real-looking-but-empty data (₿0 everywhere) and the
# real SADM password stopped working, both because every request was quietly being served from the
# wrong, nearly-empty database. Setting AppEnvironmentExtra here every time this script runs prevents
# a repeat.
Reset-NssmService "TGMSupplyChainServer"
& $nssm install TGMSupplyChainServer $nodeExe "server.js"
& $nssm set TGMSupplyChainServer AppDirectory $serverDir
& $nssm set TGMSupplyChainServer AppEnvironmentExtra "DB_PATH=C:\TGM-Data\supplychain-db\tgm.db"
& $nssm set TGMSupplyChainServer Start SERVICE_AUTO_START
& $nssm set TGMSupplyChainServer AppStdout (Join-Path $serverDir "service-stdout.log")
& $nssm set TGMSupplyChainServer AppStderr (Join-Path $serverDir "service-stderr.log")
& $nssm set TGMSupplyChainServer AppRotateFiles 1
& $nssm set TGMSupplyChainServer AppRotateBytes 5242880
& $nssm set TGMSupplyChainServer AppExit Default Restart
& $nssm set TGMSupplyChainServer AppRestartDelay 3000
& $nssm start TGMSupplyChainServer

Write-Host "`n=== TGMCloudflareTunnel ==="
# Named tunnel (permanent hostname supplychain.tgm.co.th) — replaces the old quick-tunnel command,
# which got a brand-new random *.trycloudflare.com URL every time it reconnected. This one reads
# C:\Users\TSS\.cloudflared\config.yml (tunnel ID + credentials file + ingress rule), so the address
# never changes across restarts/reboots.
Reset-NssmService "TGMCloudflareTunnel"
& $nssm install TGMCloudflareTunnel $cloudflaredExe "tunnel --config C:\Users\TSS\.cloudflared\config.yml run"
& $nssm set TGMCloudflareTunnel Start SERVICE_AUTO_START
& $nssm set TGMCloudflareTunnel AppStdout (Join-Path $serverDir "tunnel-stdout.log")
& $nssm set TGMCloudflareTunnel AppStderr (Join-Path $serverDir "tunnel-stderr.log")
& $nssm set TGMCloudflareTunnel AppRotateFiles 1
& $nssm set TGMCloudflareTunnel AppRotateBytes 5242880
& $nssm set TGMCloudflareTunnel AppExit Default Restart
& $nssm set TGMCloudflareTunnel AppRestartDelay 3000
& $nssm start TGMCloudflareTunnel

Write-Host "`n=== TGMQuickTunnel ==="
# Stopgap quick tunnel (2026-09-10) — this is NOT the permanent supplychain.tgm.co.th tunnel above;
# vercel-deploy/build.js's API_BASE_URL still points at a *.trycloudflare.com quick-tunnel hostname
# because tgm.co.th's nameservers still aren't confirmed pointed at Cloudflare (see build.js's
# comments). The quick tunnel used to be started by hand in a terminal window, which meant it died
# silently every time this machine rebooted or whoever restarted TGMSupplyChainServer happened to
# also close that terminal (confirmed: this caused two production outages within 48h, 2026-09-08 and
# 2026-09-10). Wrapping it as its own NSSM service makes it survive both of those. It does NOT fix
# the other half of the problem: a quick tunnel gets a brand-new random hostname every time this
# process itself restarts (crash, reboot, `nssm restart TGMQuickTunnel`) — after any such restart,
# read the new URL from tunnel-quick-stderr.log (`INF |  https://<words>.trycloudflare.com  |` line)
# and update vercel-deploy/build.js's API_BASE_URL, then rebuild+redeploy. --config points at the
# empty file below, NOT the default ~/.cloudflared/config.yml — otherwise cloudflared silently
# inherits the named tunnel's hostname-restricted ingress rules and 404s every request (see
# build.js's 2026-08-26 comment for the incident this caused).
Reset-NssmService "TGMQuickTunnel"
& $nssm install TGMQuickTunnel $cloudflaredExe "tunnel --config $serverDir\empty-cloudflared-config.yml --url http://localhost:3000"
& $nssm set TGMQuickTunnel Start SERVICE_AUTO_START
& $nssm set TGMQuickTunnel AppStdout (Join-Path $serverDir "tunnel-quick-stdout.log")
& $nssm set TGMQuickTunnel AppStderr (Join-Path $serverDir "tunnel-quick-stderr.log")
& $nssm set TGMQuickTunnel AppRotateFiles 1
& $nssm set TGMQuickTunnel AppRotateBytes 5242880
& $nssm set TGMQuickTunnel AppExit Default Restart
& $nssm set TGMQuickTunnel AppRestartDelay 3000
& $nssm start TGMQuickTunnel

Start-Sleep -Seconds 6
Write-Host "`n=== Status ==="
Get-Service TGMSupplyChainServer, TGMCloudflareTunnel, TGMQuickTunnel | Format-Table Name, Status, StartType

Write-Host "`n=== Permanent URL (once DNS confirmed): https://supplychain.tgm.co.th ==="
Write-Host "=== Current stopgap URL: check server\tunnel-quick-stderr.log for the live *.trycloudflare.com hostname ==="
