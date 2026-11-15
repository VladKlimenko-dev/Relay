<#
  Starts the model server and Relay, then opens http://127.0.0.1:5000.
  Defaults come from relay-config.json written by setup.

  Examples:
    start-relay.cmd                         configured runtime and model
    start-relay.cmd -Model 36-35b           use Qwen3.6-35B-A3B
    start-relay.cmd -Runtime ollama         use Ollama
    start-relay.cmd -Ctx 65536              larger context (uses more VRAM)
    start-relay.cmd -KvInRam                context cache in RAM: 256K context, much slower
#>
param(
  [ValidateSet("", "llamacpp", "ollama")] [string]$Runtime = "",
  [ValidateSet("", "38-27b", "38-27b-q5", "36-27b", "36-35b")] [string]$Model = "",
  [int]$Ctx = 0,            # 0 = automatic: model ArcCtx on a 24 GB Arc (128K for the default), 32K otherwise, 256K with -KvInRam
  [switch]$KvInRam,
  [int]$Port = 5000,
  [int]$LlamaPort = 8080,
  [switch]$NoBrowser
)
$ErrorActionPreference = "Continue"
# winget, npm, Python and llama.cpp print UTF-8; without this, Russian Windows (OEM 866) shows garbled text.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "models.ps1")
. (Join-Path $PSScriptRoot "background-process.ps1")
$LogDir = Join-Path $Root "logs"
$null = New-Item -ItemType Directory -Force -Path $LogDir
function Fail($text) { Write-Host "START STOPPED: $text" -ForegroundColor Red; exit 1 }
function Up($url) {
  # Plain HTTP request with no proxy: a system proxy can swallow 127.0.0.1 requests in Windows PowerShell 5.1.
  try {
    $req = [System.Net.WebRequest]::Create($url); $req.Proxy = $null; $req.Timeout = 3000
    $res = $req.GetResponse(); $ok = [int]$res.StatusCode -eq 200; $res.Close(); $ok
  } catch { $false }
}

$cfgFile = Join-Path $Root "relay-config.json"
if (-not (Test-Path $cfgFile)) { Fail "relay-config.json not found. Run setup.cmd first." }
$cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
if (-not $Runtime) { $Runtime = $cfg.runtime }
if (-not $Model) {
  # Older setup versions saved only the first character of the model key; fall back to the "models" list.
  $saved = [string]$cfg.model
  if (-not $RelayModels.Contains($saved)) { $saved = [string](@($cfg.models)[0]) }
  if ($RelayModels.Contains($saved)) { $Model = $saved }
}
$spec = $RelayModels[$Model]
$server = Join-Path $Root "tools\llama.cpp\llama-server.exe"
$arc = $null
if ($Runtime -eq "llamacpp" -and (Test-Path $server)) {
  # Ask llama.cpp itself which GPUs it sees; do not rely on the backend saved by setup.
  $arc = & $server --list-devices 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match "^\s*(Vulkan|SYCL)\d+:.*Arc" } | Select-Object -First 1
}
if ($Ctx -le 0) {
  # Qwen3.8-27B: 16 of 64 layers use full attention (4 KV heads x 256 dims) -> about 34-43 KiB per token at q8_0.
  # 24 GB Arc: Q4_K_M 15.3 GiB + 128K cache (4.3-5.4 GiB) + compute fits; reported peak 21.4 GiB on a B60.
  $Ctx = if ($KvInRam) { 262144 } elseif (($arc -or $cfg.backend -in @("vulkan", "sycl")) -and $spec.ArcCtx) { $spec.ArcCtx } else { 32768 }
}
if (-not $spec) { Fail "Unknown model '$Model' in relay-config.json. Run setup.cmd again." }
if (-not (Test-Path (Join-Path $Root "dist\index.cjs"))) { Fail "Relay is not built. Run setup.cmd first." }

# Run in a child PowerShell so search failure never exits the model/app launcher.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "search.ps1") -Root $Root
if ($LASTEXITCODE -ne 0) { Write-Host "Built-in search unavailable; continuing with local coding. See Settings > Web search." -ForegroundColor Yellow }

if ($Runtime -eq "llamacpp") {
  $gguf = Join-Path $Root ("models\" + $spec.File)
  if (-not (Test-Path $server)) { Fail "llama-server.exe missing. Run setup.cmd." }
  if (-not (Test-Path $gguf)) { Fail "$($spec.File) missing. Run: setup.cmd -Model $Model" }
  if (Get-Process -Name "ollama*" -ErrorAction SilentlyContinue) {
    Write-Host "Note: Ollama is running. If it has a model loaded it uses VRAM; run 'ollama stop <model>' or quit Ollama." -ForegroundColor Yellow
  }
  if (-not (Up "http://127.0.0.1:$LlamaPort/health")) {
    # --fit (default on) places as many layers/experts on the GPU as fit, leaving --fit-target MiB free.
    $llamaArgs = @("-m", "`"$gguf`"", "-c", $Ctx, "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja",
      "-np", "1", "--fit-target", "768", "--host", "127.0.0.1", "--port", $LlamaPort, "--alias", $spec.OllamaTag)
    if ($KvInRam) { $llamaArgs += "-nkvo" }  # weights stay in VRAM, context cache and attention go to RAM/CPU
    # With several GPUs (e.g. Arc + NVIDIA), pin llama.cpp to the Arc card so the model is not split across PCIe.
    if ($arc) { $dev = ($arc.Trim() -split ":")[0]; $llamaArgs += @("-dev", $dev); Write-Host "Using $($arc.Trim())" }
    Write-Host "Starting llama-server ($($spec.File), context $Ctx) in the background..."
    Backup-RelayLogs $LogDir "model"
    $modelProcess = Start-Process -FilePath $server -ArgumentList $llamaArgs -WorkingDirectory (Split-Path $server) -WindowStyle Hidden -PassThru -ErrorAction Stop `
      -RedirectStandardOutput (Join-Path $LogDir "model.stdout.log") -RedirectStandardError (Join-Path $LogDir "model.stderr.log")
    Save-RelayProcess $Root ".relay-model.json" $modelProcess
    $deadline = (Get-Date).AddMinutes(15)
    Write-Host "Waiting for the model to load. Diagnostics: logs\model.stderr.log"
    while (-not (Up "http://127.0.0.1:$LlamaPort/health")) {
      if ((Get-Date) -gt $deadline) { Fail "llama-server did not become ready in 15 minutes. Check logs\model.stderr.log." }
      if ($modelProcess.HasExited) { Fail "llama-server exited. Check logs\model.stderr.log; try a smaller -Ctx." }
      Start-Sleep -Seconds 3
    }
  }
  Write-Host "llama-server ready on port $LlamaPort." -ForegroundColor Green
  $env:RELAY_RUNTIME = "openai"
  $env:OPENAI_BASE_URL = "http://127.0.0.1:$LlamaPort/v1"
} else {
  if (-not (Up "http://127.0.0.1:11434/api/tags")) {
    $env:OLLAMA_FLASH_ATTENTION = "1"
    $env:OLLAMA_KV_CACHE_TYPE = "q8_0"
    $env:OLLAMA_VULKAN = "1"
    Write-Host "Starting Ollama server..."
    Backup-RelayLogs $LogDir "model"
    $modelProcess = Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -PassThru -ErrorAction Stop `
      -RedirectStandardOutput (Join-Path $LogDir "model.stdout.log") -RedirectStandardError (Join-Path $LogDir "model.stderr.log")
    Save-RelayProcess $Root ".relay-model.json" $modelProcess
    $deadline = (Get-Date).AddMinutes(1)
    Write-Host "Waiting for Ollama. Diagnostics: logs\model.stderr.log"
    while (-not (Up "http://127.0.0.1:11434/api/tags")) { if ((Get-Date) -gt $deadline) { Fail "Ollama did not start." }; Start-Sleep -Seconds 2 }
  } else {
    Write-Host "Ollama already running. For best memory use set OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 in Windows environment variables and restart Ollama." -ForegroundColor Yellow
  }
  $env:RELAY_RUNTIME = "ollama"
}

$env:NODE_ENV = "production"
$env:PORT = "$Port"
$env:HOST = "127.0.0.1"
$env:DATA_FILE = Join-Path $Root "data.db"
$env:RELAY_CTX = "$Ctx"
$env:RELAY_MODEL = $spec.OllamaTag
$env:RELAY_BACKGROUND = "1"
Write-Host "Relay: http://127.0.0.1:$Port  (runtime $Runtime, model $($spec.OllamaTag)). Starting in the background." -ForegroundColor Green
Backup-RelayLogs $LogDir "relay"
$node = Start-Process -FilePath "node" -ArgumentList "dist\index.cjs" -WorkingDirectory $Root -WindowStyle Hidden -PassThru -ErrorAction Stop `
  -RedirectStandardOutput (Join-Path $LogDir "relay.stdout.log") -RedirectStandardError (Join-Path $LogDir "relay.stderr.log")
$null = $node.Handle   # keep the handle so ExitCode is available if node exits
try {
  @{ pid=$node.Id; startedAt=$node.StartTime.ToUniversalTime().ToString("o"); port=$Port } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $Root ".relay-server.json") -Encoding UTF8
} catch { Write-Host "Could not save the server process marker; update checks will use the local health endpoint." -ForegroundColor Yellow }
$deadline = (Get-Date).AddMinutes(2)
while (-not (Up "http://127.0.0.1:$Port/api/health")) {
  if ($node.HasExited) { Fail "Relay server exited (code $($node.ExitCode)). See logs\relay.stderr.log." }
  if ((Get-Date) -gt $deadline) { Fail "Relay server did not answer on port $Port in 2 minutes. See logs\relay.stderr.log." }
  Start-Sleep -Seconds 1
}
$openUrl = "http://127.0.0.1:$Port"
if (Test-Path (Join-Path $Root "remote-access.json")) {
  $remote = Get-Content (Join-Path $Root "remote-access.json") -Raw | ConvertFrom-Json
  $openUrl = "https://127.0.0.1:$($remote.port)"
  Write-Host "Remote address: $($remote.url). Login required. Certificate trust and network forwarding must be configured separately." -ForegroundColor Green
}
Write-Host "Relay is ready: $openUrl" -ForegroundColor Green
if (-not $NoBrowser) { Start-Process $openUrl }
Write-Host "Relay is running in the background. Use Status in the app to view logs or shut down. Closing the browser does not stop Relay." -ForegroundColor Green
exit 0
