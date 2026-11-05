# Runs ON THE SERVER (installed as a SYSTEM scheduled task by install-auto-restart.ps1).
# Watches the OneDrive-synced backend code and restarts TGMSupplyChainServer once a change has
# finished syncing, so code edited on another machine goes live without remoting in.
#
# Two modes:
#   default (Request) - restarts only after someone runs request-restart.ps1 (drops .restart-request).
#                       Half-finished saves sync over but never go live until asked.
#   -Auto             - restarts on any backend code change, once it has been quiet for $QuietSeconds.
#
# Safety: waits for the folder to stop changing (OneDrive delivers files one by one), runs
# `node --check` on every changed .js first, refuses to restart if package.json/package-lock.json
# changed (needs npm install by hand), and checks /api/health after restarting. Every result is
# written to .restart-status.txt, which OneDrive syncs back to the editing machine.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts with the ANSI codepage
# (874/Thai), so paths are derived at runtime instead of written literally (see install-services.ps1).
param(
  [switch]$Auto,
  [int]$QuietSeconds = 45,
  [int]$PollSeconds = 10
)

$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sharedDir = Join-Path (Split-Path -Parent $serverDir) 'shared'
$serviceName = 'TGMSupplyChainServer'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$requestFile = Join-Path $serverDir '.restart-request'
$statusFile = Join-Path $serverDir '.restart-status.txt'
$logFile = Join-Path $serverDir 'auto-restart.log'
$skipDirs = @('node_modules', 'tests', '.impeccable')

$port = 3000
$envFile = Join-Path $serverDir '.env'
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
$healthUrl = "http://127.0.0.1:$port/api/health"

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Write-Status($result, $lines) {
  $body = @("$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $result") + $lines
  Set-Content -Path $statusFile -Value $body -Encoding UTF8
  Write-Log "$result $($lines -join ' | ')"
}

# path -> "ticks|length" for every file whose change needs a restart
function Get-Snapshot {
  $files = @()
  $files += Get-ChildItem -Path $serverDir -File -Force | Where-Object { $_.Extension -in '.js', '.json' -or $_.Name -eq '.env' }
  Get-ChildItem -Path $serverDir -Directory -Force | Where-Object { $_.Name -notin $skipDirs } | ForEach-Object {
    $files += Get-ChildItem -Path $_.FullName -Recurse -File -Include *.js, *.json, *.sql -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $sharedDir) { $files += Get-ChildItem -Path $sharedDir -Recurse -File -Include *.js -ErrorAction SilentlyContinue }
  $snap = @{}
  foreach ($f in $files) { $snap[$f.FullName] = "$($f.LastWriteTimeUtc.Ticks)|$($f.Length)" }
  $snap
}

function Get-Changed($old, $new) {
  $changed = @()
  foreach ($k in $new.Keys) { if ($old[$k] -ne $new[$k]) { $changed += $k } }
  foreach ($k in $old.Keys) { if (-not $new.ContainsKey($k)) { $changed += $k } }
  $changed
}

function Get-Signature($snap) {
  $req = if (Test-Path $requestFile) { (Get-Item $requestFile).LastWriteTimeUtc.Ticks } else { 0 }
  (($snap.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';') + ";req=$req"
}

function Test-Health {
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
  }
  $false
}

function Invoke-Restart($changed) {
  $rel = $changed | ForEach-Object { $_.Replace((Split-Path -Parent $serverDir) + '\', '') }

  $pkg = $changed | Where-Object { (Split-Path -Leaf $_) -in 'package.json', 'package-lock.json' }
  if ($pkg) {
    Write-Status 'BLOCKED' (@('package.json changed - run npm install on the server, then restart by hand:', '  cd server; npm install; Restart-Service TGMSupplyChainServer') + $rel)
    return $false
  }

  $errors = @()
  foreach ($f in ($changed | Where-Object { $_ -like '*.js' -and (Test-Path $_) })) {
    $out = & $nodeExe --check $f 2>&1
    if ($LASTEXITCODE -ne 0) { $errors += "--- $f"; $errors += ($out | Select-Object -First 8 | ForEach-Object { "$_" }) }
  }
  if ($errors) {
    Write-Status 'FAILED (syntax error - not restarted, server still runs the old code)' $errors
    return $false
  }

  try {
    Restart-Service -Name $serviceName -Force -ErrorAction Stop
  } catch {
    Write-Status 'FAILED (could not restart service)' @("$_")
    return $false
  }

  if (Test-Health) {
    Write-Status 'OK (restarted, /api/health responds)' $rel
    return $true
  }
  $stderr = Get-ChildItem -Path $serverDir -Filter 'service-stderr*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $tail = if ($stderr) { Get-Content $stderr.FullName -Tail 20 } else { @() }
  Write-Status 'FAILED (restarted but /api/health does not respond - check below)' (@($rel) + '--- service-stderr tail:' + $tail)
  return $false
}

$mode = if ($Auto) { 'Auto' } else { 'Request' }
Write-Log "watcher started (mode=$mode, quiet=${QuietSeconds}s, health=$healthUrl)"

$baseline = Get-Snapshot          # assume the running service already has whatever is on disk now
$lastSig = Get-Signature $baseline
$lastChange = Get-Date
$failedSig = $null                # don't retry the exact same broken state every poll

while ($true) {
  Start-Sleep -Seconds $PollSeconds
  try {
    $snap = Get-Snapshot
    $sig = Get-Signature $snap
    if ($sig -ne $lastSig) { $lastSig = $sig; $lastChange = Get-Date; continue }
    if (((Get-Date) - $lastChange).TotalSeconds -lt $QuietSeconds) { continue }

    $requested = Test-Path $requestFile
    $changed = @(Get-Changed $baseline $snap)
    if (-not $requested -and (-not $Auto -or $changed.Count -eq 0)) { continue }
    if (-not $requested -and $sig -eq $failedSig) { continue }

    if ($requested) { Remove-Item $requestFile -Force -ErrorAction SilentlyContinue }
    $ok = Invoke-Restart $changed
    $lastSig = Get-Signature $snap   # request file is gone now, so re-sign before remembering a failure
    if ($ok) { $baseline = $snap; $failedSig = $null } else { $failedSig = $lastSig }
  } catch {
    Write-Log "watcher error: $_"
  }
}
