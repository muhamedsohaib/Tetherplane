@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Inspect-Tetherplane-Mesh.ps1"
set "result=%errorlevel%"
echo.
echo No installation, pairing, revocation or service restart was attempted.
echo Press any key to close.
pause >nul
exit /b %result%
