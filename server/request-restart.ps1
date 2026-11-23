# Run ON THE EDITING MACHINE when backend changes are ready to go live. Drops .restart-request into
# the OneDrive-synced folder; the server's auto-restart-watcher.ps1 picks it up once sync has
# settled, checks and restarts, and writes .restart-status.txt, which syncs back and is printed here.
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$requestFile = Join-Path $serverDir '.restart-request'
$statusFile = Join-Path $serverDir '.restart-status.txt'
$timeoutMinutes = 5

$before = if (Test-Path $statusFile) { (Get-Item $statusFile).LastWriteTimeUtc } else { [datetime]::MinValue }
Set-Content -Path $requestFile -Value (Get-Date -Format o)
Write-Host 'Restart requested. Waiting for OneDrive sync + server check (usually 1-2 minutes)...'

$deadline = (Get-Date).AddMinutes($timeoutMinutes)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  if ((Test-Path $statusFile) -and (Get-Item $statusFile).LastWriteTimeUtc -gt $before) {
    $status = Get-Content $statusFile -Encoding UTF8
    $color = if ($status[0] -match ' OK ') { 'Green' } else { 'Red' }
    Write-Host ''
    Write-Host $status[0] -ForegroundColor $color
    $status | Select-Object -Skip 1 | ForEach-Object { Write-Host "  $_" }
    return
  }
}
Write-Host "No answer from the server after $timeoutMinutes minutes." -ForegroundColor Yellow
Write-Host 'Check: OneDrive is syncing on both machines, and the TGMAutoRestartWatcher task is running on the server.'
