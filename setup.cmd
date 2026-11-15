@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\setup.ps1" %*
pause
