@echo off
setlocal
set "TP_ROOT=%~dp0"
if not exist "%TP_ROOT%runtime\node.exe" (
  echo Tetherplane setup is incomplete. Re-extract the entire developer-beta ZIP.
  pause
  exit /b 2
)
"%TP_ROOT%runtime\node.exe" "%TP_ROOT%app\preflight.mjs" --start
if errorlevel 1 (
  echo No changes were made to existing Tetherplane installations.
  pause
  exit /b 1
)
exit /b 0
