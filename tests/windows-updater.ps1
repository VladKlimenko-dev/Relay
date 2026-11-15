<# Targeted, offline updater tests. No dependencies installed and no model/server started.
   Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-updater.ps1 #>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root "setup/github-update-files.ps1")
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
$temp = Join-Path ([IO.Path]::GetTempPath()) ("relay-test-" + [Guid]::NewGuid().ToString("N"))
try {
  foreach ($file in Get-ChildItem (Join-Path $Root "setup/*.ps1")) {
    $errors = $null; $tokens = $null
    $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    Assert (-not $errors) "PowerShell parse error: $($file.Name): $errors"
  }
  $src = Join-Path $temp "source"
  $stage = Join-Path $temp "stage"
  $dest = Join-Path $temp "installed"
  $prefix = Join-Path $src "Relay-abcdef"
  foreach ($dir in @("server", "setup", "models", "secrets", "sessions", "workspace", "tools")) {
    $null = New-Item -ItemType Directory -Force (Join-Path $prefix $dir)
    $null = New-Item -ItemType Directory -Force (Join-Path $dest $dir)
  }
  $protected = @("models/local.gguf", "secrets/token", "sessions/session.json", "workspace/project", "tools/runtime",
    "data.db", "data.db-wal", "data.db-shm", "data.db-journal", "relay-config.json", "search-settings.json",
    "remote-access.json", "relay-public.cer", ".env")
  foreach ($name in (@("package.json", "package-lock.json", "server/index.ts", "setup/launch-relay.ps1") + $protected)) {
    [IO.File]::WriteAllText((Join-Path $prefix $name), "download")
    [IO.File]::WriteAllText((Join-Path $dest $name), "local")
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $temp "test.zip"
  [IO.Compression.ZipFile]::CreateFromDirectory($src, $zip)
  Expand-RelayGitHubSnapshot $zip $stage
  Copy-RelayGitHubSnapshot $stage $dest
  foreach ($name in $protected) {
    Assert ([IO.File]::ReadAllText((Join-Path $dest $name)) -eq "local") "Local data replaced: $name"
    Assert (-not (Test-RelayCodePath $name)) "Protected path accepted: $name"
  }
  Assert ([IO.File]::ReadAllText((Join-Path $dest "server/index.ts")) -eq "download") "Code not updated"
  foreach ($name in @("../server/x", "server/../x", "/server/x", "server/x:stream", "server/x. /y")) {
    Assert (-not (Test-RelayCodePath $name)) "Unsafe path accepted: $name"
  }
  $badZip = Join-Path $temp "bad.zip"
  $archive = [IO.Compression.ZipFile]::Open($badZip, "Create")
  $null = $archive.CreateEntry("Relay-abcdef/../sessions/overwrite")
  $archive.Dispose()
  $refused = $false
  try { Expand-RelayGitHubSnapshot $badZip (Join-Path $temp "bad-stage") } catch { $refused = $true }
  Assert $refused "Archive traversal accepted"
  $process = Get-Process -Id $PID
  @{ pid=$PID; startedAt=$process.StartTime.ToUniversalTime().ToString("o") } |
    ConvertTo-Json | Set-Content (Join-Path $dest ".relay-server.json")
  Assert (Test-RelayServerRunning $dest 65432) "Running server process marker missed"
  Remove-Item (Join-Path $dest ".relay-server.json")
  Write-Host "PASS: parser, protected data, source replacement, traversal rejection and process marker"

  # Exercise launcher dispatch in child PowerShells, replacing native installers and servers with mocks.
  foreach ($name in @("launch-relay.ps1", "github-update-files.ps1", "models.ps1")) {
    Copy-Item (Join-Path $Root "setup/$name") (Join-Path $dest "setup/$name") -Force
  }
  $null = New-Item -ItemType Directory -Force (Join-Path $dest "dist")
  $null = New-Item -ItemType Directory -Force (Join-Path $dest "node_modules")
  [IO.File]::WriteAllText((Join-Path $dest "dist/index.cjs"), "fixture")
  @{ runtime="ollama"; model="38-27b-q5"; backend="cuda"; models=@("38-27b-q5") } |
    ConvertTo-Json | Set-Content (Join-Path $dest "relay-config.json")
  $shell = (Get-Process -Id $PID).Path
  $log = Join-Path $temp "calls.txt"
  $env:RELAY_TEST_LOG = $log
  $env:RELAY_TEST_LAUNCHER = Join-Path $dest "setup/launch-relay.ps1"
  $mock = @'
function node { "v24.0.0" }
function npm.cmd { }
function git { }
function ollama { }
function powershell {
  ($args -join "|") | Add-Content -LiteralPath $env:RELAY_TEST_LOG
  $global:LASTEXITCODE = 0
  if (($args -join "|") -match "github-update\.ps1") { $global:LASTEXITCODE = [int]$env:RELAY_TEST_UPDATE_EXIT }
}
& $env:RELAY_TEST_LAUNCHER
'@
  foreach ($case in @(
    @{ Name="offline"; Args="-Offline -Ctx 65536 -KvInRam -NoBrowser -Port 65432"; UpdateExit=0; ExpectedExit=0; Starts=$true },
    @{ Name="network fallback"; Args="-Port 65432"; UpdateExit=2; ExpectedExit=0; Starts=$true },
    @{ Name="incomplete update"; Args="-Port 65432"; UpdateExit=1; ExpectedExit=1; Starts=$false },
    @{ Name="update only"; Args="-UpdateOnly -Port 65432"; UpdateExit=0; ExpectedExit=0; Starts=$false },
    @{ Name="repair selection"; Args="-Setup -Port 65432"; UpdateExit=0; ExpectedExit=0; Starts=$true }
  )) {
    [IO.File]::WriteAllText($log, "")
    $env:RELAY_TEST_UPDATE_EXIT = [string]$case.UpdateExit
    & $shell -NoProfile -Command ($mock.TrimEnd() + " " + $case.Args) | Out-Host
    Assert ($LASTEXITCODE -eq $case.ExpectedExit) "Wrong launcher exit: $($case.Name)"
    $calls = [IO.File]::ReadAllText($log)
    Assert (($calls -match "start-relay\.ps1") -eq $case.Starts) "Wrong start decision: $($case.Name)"
    if ($case.Name -eq "offline") {
      Assert ($calls -notmatch "github-update\.ps1") "Offline contacted GitHub"
      Assert ($calls -match "\-Ctx\|65536" -and $calls -match "\-KvInRam" -and $calls -match "\-NoBrowser") "Launch flags lost"
    }
    if ($case.Name -eq "repair selection") {
      Assert ($calls -match "setup\.ps1\|-Runtime\|ollama\|-Model\|38-27b-q5\|-Backend\|cuda") "Repair changed model/runtime/backend"
    }
    Write-Host "PASS: $($case.Name)"
  }
  # Unix permits link creation without Windows developer-mode/admin requirements.
  if ([IO.Path]::DirectorySeparatorChar -eq "/") {
    Remove-Item (Join-Path $dest "server") -Recurse -Force
    $null = New-Item -ItemType SymbolicLink -Path (Join-Path $dest "server") -Target (Join-Path $dest "sessions")
    $refused = $false
    try { Copy-RelayGitHubSnapshot $stage $dest } catch { $refused = $true }
    Assert $refused "Linked application destination accepted"
    Write-Host "PASS: symbolic-link destination rejection"
  }
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:RELAY_TEST_LOG, Env:RELAY_TEST_LAUNCHER, Env:RELAY_TEST_UPDATE_EXIT -ErrorAction SilentlyContinue
}
