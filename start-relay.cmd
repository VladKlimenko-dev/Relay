@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\launch-relay.ps1" %*
set "result=%errorlevel%"
pause
exit /b %result%
