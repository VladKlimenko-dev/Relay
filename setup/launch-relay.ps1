<# One entry point: prerequisite/setup checks, public GitHub update, then application start. #>
param(
  [switch]$Setup, [switch]$UpdateOnly, [switch]$Offline,
  [ValidateSet("", "llamacpp", "ollama")][string]$Runtime = "",
  [ValidateSet("", "38-27b", "38-27b-q5", "36-27b", "36-35b")][string]$Model = "",
  [ValidateSet("auto", "vulkan", "sycl", "cuda", "cpu")][string]$Backend = "auto",
  [switch]$Toolchains, [switch]$UpdateLlama,
  [int]$Ctx = 0, [switch]$KvInRam, [int]$Port = 5000, [int]$LlamaPort = 8080, [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
try {
  . (Join-Path $PSScriptRoot "models.ps1")
  . (Join-Path $PSScriptRoot "github-update-files.ps1")
  if ($Offline -and $UpdateOnly) { throw "Choose either -Offline or -UpdateOnly." }
  if (Test-RelayServerRunning $Root $Port) {
    if ($Setup -or $UpdateOnly -or $Toolchains -or $UpdateLlama) {
      throw "Relay is already running. Open Status in the app and shut down before updating or running setup."
    }
    $url = "http://127.0.0.1:$Port"
    $marker = Join-Path $Root ".relay-server.json"
    if (Test-Path -LiteralPath $marker) {
      $saved = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ($saved.port) { $url = "http://127.0.0.1:$($saved.port)" }
    }
    if (Test-Path -LiteralPath (Join-Path $Root "remote-access.json")) {
      $remote = Get-Content -LiteralPath (Join-Path $Root "remote-access.json") -Raw | ConvertFrom-Json
      $url = "https://127.0.0.1:$($remote.port)"
    }
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host "Relay is already running. Use Status in the app to inspect it or shut down."
    exit 0
  }
  $configFile = Join-Path $Root "relay-config.json"
  $config = $null
  if (Test-Path -LiteralPath $configFile) { $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json }
  $selectedRuntime = if ($Runtime) { $Runtime } elseif ($config.runtime) { [string]$config.runtime } else { "llamacpp" }
  $selectedModel = if ($Model) { $Model } elseif ($config -and $RelayModels.Contains([string]$config.model)) { [string]$config.model } elseif ($config -and $RelayModels.Contains([string](@($config.models)[0]))) { [string](@($config.models)[0]) } else { "38-27b" }
  if ($selectedRuntime -notin @("llamacpp", "ollama")) { throw "Invalid runtime in relay-config.json. Specify -Runtime llamacpp or -Runtime ollama." }
  $selectedBackend = if ($Backend -ne "auto") { $Backend } elseif ($config.backend) { [string]$config.backend } else { "auto" }
  $needsSetup = $Setup -or $Toolchains -or $UpdateLlama -or -not $config
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $needsSetup = $true }
  else {
    try { if ([version]((& node -v).TrimStart("v")) -lt [version]"22.13") { $needsSetup = $true } }
    catch { $needsSetup = $true }
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $needsSetup = $true }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $needsSetup = $true }
  # Thinking summarizer: install once for existing setups; a recorded failure (summarizer = false) is not retried here.
  if ($config -and $null -eq $config.summarizer) { $needsSetup = $true }
  if ($selectedRuntime -eq "llamacpp") {
    $spec = $RelayModels[$selectedModel]
    $modelFile = Join-Path $Root ("models\" + $spec.File)
    if (-not (Test-Path -LiteralPath (Join-Path $Root "tools\llama.cpp\llama-server.exe"))) { $needsSetup = $true }
    if (-not (Test-Path -LiteralPath $modelFile) -or (Get-Item -LiteralPath $modelFile).Length -ne $spec.Bytes) { $needsSetup = $true }
  } elseif (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { $needsSetup = $true }
  Write-Host "Relay | Setup check -> GitHub update -> Start" -ForegroundColor Cyan
  if ($needsSetup) {
    if ($Offline) { throw "Setup or repair is needed; run start-relay.cmd without -Offline while online." }
    if ($UpdateOnly) { throw "First-time setup is needed. Run start-relay.cmd without -UpdateOnly." }
    Write-Host "Installing/repairing prerequisites for $selectedRuntime / $selectedModel. Existing valid models are reused."
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "setup.ps1"),
      "-Runtime", $selectedRuntime, "-Model", $selectedModel, "-Backend", $selectedBackend)
    if ($Toolchains) { $arguments += "-Toolchains" }
    if ($UpdateLlama) { $arguments += "-UpdateLlama" }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) { throw "Setup failed. See the setup output; the application was not started." }
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  }
  if (-not $Offline) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "github-update.ps1") -Port $Port
    $updateExit = $LASTEXITCODE
    if ($updateExit -eq 1) { throw "Update is incomplete. Resolve the error and rerun start-relay.cmd. Local data is still present." }
    if ($updateExit -ne 0) {
      if ($UpdateOnly) { throw "GitHub could not be checked; no update was installed." }
      Write-Host "GitHub is unavailable. Starting the existing local version instead." -ForegroundColor Yellow
    }
  } elseif (Test-Path -LiteralPath (Join-Path $Root ".relay-update-pending.json")) {
    throw "An earlier update did not finish. Re-run online to repair it before using -Offline."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Root "dist\index.cjs")) -or -not (Test-Path -LiteralPath (Join-Path $Root "node_modules"))) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "setup\update-relay.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Application build failed." }
  }
  if ($UpdateOnly) { Write-Host "Update check complete. Run start-relay.cmd to start Relay."; exit 0 }
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "setup\start-relay.ps1"),
    "-Runtime", $selectedRuntime, "-Model", $selectedModel, "-Ctx", $Ctx, "-Port", $Port, "-LlamaPort", $LlamaPort)
  if ($KvInRam) { $arguments += "-KvInRam" }
  if ($NoBrowser) { $arguments += "-NoBrowser" }
  & powershell @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host "RELAY STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
