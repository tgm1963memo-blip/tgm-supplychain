# Run ON THE SERVER as Administrator. Registers auto-restart-watcher.ps1 as a scheduled task that
# starts at boot under SYSTEM (needed to restart the TGMSupplyChainServer service).
#   .\install-auto-restart.ps1          -> Request mode (restart only when request-restart.ps1 is run)
#   .\install-auto-restart.ps1 -Auto    -> restart automatically on every backend code change
#   .\install-auto-restart.ps1 -Remove  -> uninstall
# The server's OneDrive must keep this folder downloaded ("Always keep on this device"); SYSTEM
# cannot open online-only placeholder files.
param([switch]$Auto, [switch]$Remove)

$taskName = 'TGMAutoRestartWatcher'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
if ($Remove) { Write-Host "Removed $taskName"; return }

# 8.3 short path keeps Thai characters out of the task's command line (same reason as install-services.ps1)
$fso = New-Object -ComObject Scripting.FileSystemObject
$script = $fso.GetFile((Join-Path $PSScriptRoot 'auto-restart-watcher.ps1')).ShortPath

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
if ($Auto) { $arg += ' -Auto' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName

$mode = if ($Auto) { 'Auto' } else { 'Request' }
Write-Host "Installed $taskName (mode=$mode). Log: server\auto-restart.log  Status: server\.restart-status.txt"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
