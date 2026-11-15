@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\launch-relay.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
