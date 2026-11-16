@echo off
setlocal
set "TP_ROOT=%~dp0"
if not exist "%TP_ROOT%runtime\node.exe" goto missing
"%TP_ROOT%runtime\node.exe" "%TP_ROOT%app\preflight.mjs" --check
if errorlevel 1 goto blocked
"%TP_ROOT%runtime\node.exe" "%TP_ROOT%app\browser-readiness.mjs" --inspect
set "TP_EXIT=%ERRORLEVEL%"
echo.
echo This diagnostic never installs a browser extension or grants access.
echo An authorized owner must separately approve browser connection and each tab.
pause
exit /b %TP_EXIT%
:missing
echo The developer-beta ZIP is incomplete. Re-extract it into a new empty folder.
pause
exit /b 2
:blocked
echo Package verification failed. Browser configuration was not inspected.
pause
exit /b 1
