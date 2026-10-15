@echo off
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)
node.exe server.mjs --open
if errorlevel 1 pause
