@echo off
setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo Bun was not found in PATH. Install Bun or add it to PATH, then try again.
  pause
  exit /b 1
)

bun run dev
if errorlevel 1 pause
