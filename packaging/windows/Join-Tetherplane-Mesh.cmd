@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Join-Tetherplane-Mesh.ps1"
set "result=%errorlevel%"
echo.
if not "%result%"=="0" echo Mesh installer stopped without overwriting an existing installation.
echo Press any key to close this window.
pause >nul
exit /b %result%
