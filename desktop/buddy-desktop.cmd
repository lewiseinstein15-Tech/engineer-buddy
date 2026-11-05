@echo off
rem Buddy Desktop - boots the local server if it is not running, then opens
rem the UI in its own chromeless app window (Edge/Chrome --app mode). Used by
rem the Start Menu shortcut install-launcher.ps1 creates; also fine by hand.
cd /d "%~dp0"
curl -s --max-time 1 http://127.0.0.1:7822/api/health >nul 2>&1
if errorlevel 1 (
  start "buddy-desktop-server" /min node server.mjs
  ping -n 3 127.0.0.1 >nul
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:7822
  exit /b
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:7822
  exit /b
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://127.0.0.1:7822
  exit /b
)
start "" http://127.0.0.1:7822
