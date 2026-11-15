@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\configure-remote.ps1" %*
pause
