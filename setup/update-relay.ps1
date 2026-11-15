<# Lightweight upgrade: no model downloads, no changes to runtime/model selection. #>
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "Close Relay first. Updating application and built-in search only; models/configuration are kept." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "Node is missing. Run setup.cmd for a first installation."; exit 1 }
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Host "Dependency installation failed."; exit 1 }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { Write-Host "Application build failed."; exit 1 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "search.ps1") -Root $Root
if ($LASTEXITCODE -ne 0) { Write-Host "App updated; search installation will retry at next startup." -ForegroundColor Yellow }
else { Write-Host "App and built-in search ready. Run start-relay.cmd." -ForegroundColor Green }
