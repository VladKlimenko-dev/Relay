<# Installs/repairs Relay's private Python search environment. No Docker or service. #>
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$SearchDir = Join-Path $Root "tools\search"
$SearchPython = Join-Path $SearchDir "Scripts\python.exe"
$ReadyFile = Join-Path $SearchDir "relay-ready"
$probe = "from ddgs import DDGS; import importlib.metadata; DDGS(); assert importlib.metadata.version('ddgs') == '9.16.1'"
if (Test-Path $SearchPython) {
  & $SearchPython -I -c $probe *> $null
  if ($LASTEXITCODE -eq 0) {
    Set-Content -Path $ReadyFile -Value "9.16.1" -Encoding Ascii
    Write-Host "Built-in search: ready (no API key)." -ForegroundColor Green; exit 0
  }
}
Write-Host "Installing Relay's built-in search component..." -ForegroundColor Cyan
function Find-SearchPython {
  foreach ($candidate in @("py", "python", "python3")) {
    $cmd = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { continue }
    $prefix = @()
    if ($candidate -eq "py") { $prefix = @("-3") }
    $exe = & $cmd.Source @prefix -c "import sys; assert sys.version_info >= (3,10); print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path ([string]$exe))) { return [string]$exe }
  }
}
$BasePython = Find-SearchPython
if (-not $BasePython -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Write-Host "Python is missing; installing Python 3.12. Windows may ask for permission."
  & winget install --id Python.Python.3.12 -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $BasePython = Find-SearchPython
}
if (-not $BasePython) { Write-Host "Search installation needs Python 3.10+. Run setup.cmd or reopen this window after Python installation." -ForegroundColor Yellow; exit 1 }
# Recreate a broken/moved venv, without touching models or the system Python packages.
if (Test-Path $SearchDir) { Remove-Item $SearchDir -Recurse -Force -ErrorAction Stop }
& $BasePython -m venv $SearchDir
if ($LASTEXITCODE -ne 0) { Write-Host "Could not create search environment." -ForegroundColor Yellow; exit 1 }
& $SearchPython -m pip install --disable-pip-version-check --only-binary=:all: --index-url https://pypi.org/simple --timeout 20 --retries 2 "ddgs==9.16.1" | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "Search download failed. Relay can run without web search; the next launch will retry." -ForegroundColor Yellow; exit 1 }
& $SearchPython -I -c $probe *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Search dependency check failed." -ForegroundColor Yellow; exit 1 }
Set-Content -Path $ReadyFile -Value "9.16.1" -Encoding Ascii
Write-Host "Built-in search installed. No extra server, URL or API key required." -ForegroundColor Green
exit 0
