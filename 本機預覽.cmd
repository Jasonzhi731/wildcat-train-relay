@echo off
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1"
pause
