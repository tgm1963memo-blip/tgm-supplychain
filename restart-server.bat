@echo off
rem Double-click on the editing machine: asks the server to restart with the synced backend code.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\request-restart.ps1"
pause
