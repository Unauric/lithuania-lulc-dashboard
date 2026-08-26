@echo off
REM Double-click this to start the dashboard correctly every time.
REM See start_dashboard.ps1 for what it actually does.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_dashboard.ps1"
pause
