<# Public repository updater. No GitHub token is read, requested or sent. #>
param([int]$Port = 5000)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "github-update-files.ps1")
$VersionFile = Join-Path $Root ".relay-version.json"
$PendingFile = Join-Path $Root ".relay-update-pending.json"
$temp = $null
$applying = $false
try {
  if (Test-RelayServerRunning $Root $Port) { throw "Relay is already running. Save/pause the session and close the server before updating." }
  Write-Host "Checking VladKlimenko-dev/Relay on GitHub (main)..." -ForegroundColor Cyan
  $headers = @{ "User-Agent"="Relay-Windows-Updater"; "Accept"="application/vnd.github+json" }
  $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/VladKlimenko-dev/Relay/commits/main" -Headers $headers -TimeoutSec 20
  $sha = [string]$commit.sha
  if ($sha -notmatch '^[a-f0-9]{40}$') { throw "GitHub returned an invalid revision." }
  $installed = ""
  if (Test-Path -LiteralPath $VersionFile) { $installed = (Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json).sha }
  if ($installed -eq $sha -and -not (Test-Path -LiteralPath $PendingFile)) {
    Write-Host "Application is up to date." -ForegroundColor Green
    exit 0
  }
  $temp = Join-Path ([IO.Path]::GetTempPath()) ("Relay-GitHub-" + [Guid]::NewGuid().ToString("N"))
  $stage = Join-Path $temp "app"
  $null = New-Item -ItemType Directory -Path $stage -Force
  $archive = Join-Path $temp "update.zip"
  Write-Host "Downloading application revision $($sha.Substring(0, 12)); model files are not part of the update."
  Invoke-WebRequest -Uri "https://codeload.github.com/VladKlimenko-dev/Relay/zip/$sha" -OutFile $archive -UseBasicParsing -TimeoutSec 120
  Expand-RelayGitHubSnapshot $archive $stage
  $applying = $true
  @{ sha=$sha; startedAt=[DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $PendingFile -Encoding UTF8
  Copy-RelayGitHubSnapshot $stage $Root
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "setup\update-relay.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Application rebuild failed. Your data was kept; rerun start-relay.cmd to retry the update." }
  @{ sha=$sha; repository="VladKlimenko-dev/Relay"; updatedAt=[DateTime]::UtcNow.ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $VersionFile -Encoding UTF8
  Remove-Item -LiteralPath $PendingFile -Force
  Write-Host "GitHub update installed. Models, sessions, database, workspace, credentials and configuration were preserved." -ForegroundColor Green
} catch {
  Write-Host "GitHub update: $($_.Exception.Message)" -ForegroundColor Yellow
  if ($applying -or (Test-Path -LiteralPath $PendingFile)) { exit 1 }
  # No application file has been touched: launcher may safely use the installed version.
  exit 2
} finally {
  if ($temp -and (Test-Path -LiteralPath $temp)) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
exit 0
