@echo off
rem WAO Windows manual start (scripts/win-start.cmd). Self-locating: works from
rem any cwd. Requires node on PATH (win-install.ps1 persists it for you); the
rem registry autostart launcher does NOT rely on this file — it bakes absolute
rem paths at enable time. Foreground start: Ctrl+C triggers the four-phase stop.
cd /d "%~dp0.."
node "src\index.js" start %*
