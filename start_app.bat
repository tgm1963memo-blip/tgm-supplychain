@echo off
cd /d "%~dp0"
set PORT=5500
start "" "http://127.0.0.1:%PORT%/index.html"
"C:\Users\TSS\AppData\Local\Programs\Python\Python312\python.exe" -m http.server %PORT% --bind 127.0.0.1
pause
