<#
  Relay setup for Windows 10/11 x64.
  Checks and installs: winget prerequisites, Node.js LTS, Python + pip, huggingface_hub, Git,
  llama.cpp (Vulkan build for Intel Arc, CUDA build for NVIDIA), optional Ollama, the model files, and Relay.
  Safe to re-run: anything already present is kept.

  Examples:
    setup.cmd                              llama.cpp + Qwen3.8-27B (default)
    setup.cmd -Model 38-27b-q5             Qwen3.8-27B Q5_K_M (48K context instead of 128K)
    setup.cmd -Model all                   download every model in setup\models.ps1 for comparison
    setup.cmd -Backend sycl                Intel SYCL build instead of Vulkan (experimental on Arc)
    setup.cmd -Runtime ollama              use Ollama instead of llama.cpp
    setup.cmd -Toolchains                  also install .NET SDK and CMake, check MSVC
    setup.cmd -UpdateLlama                 replace llama.cpp with the newest build
#>
param(
  [ValidateSet("llamacpp", "ollama", "both")] [string]$Runtime = "llamacpp",
  [ValidateSet("38-27b", "38-27b-q5", "36-27b", "36-35b", "all")] [string]$Model = "38-27b",
  [ValidateSet("auto", "vulkan", "sycl", "cuda", "cpu")] [string]$Backend = "auto",
  [switch]$Toolchains,
  [switch]$SkipModels,
  [switch]$UpdateLlama,
  [switch]$NoSummarizer    # skip the small CPU model for thinking summaries
)
$ErrorActionPreference = "Continue"   # native tools write to stderr; failures are checked explicitly
# winget, npm, Python and llama.cpp print UTF-8; without this, Russian Windows (OEM 866) shows garbled text.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $Root "tools"
$LlamaDir = Join-Path $ToolsDir "llama.cpp"
$ModelsDir = Join-Path $Root "models"
. (Join-Path $PSScriptRoot "models.ps1")
# @() outside the if: an if-statement unrolls a one-item array into a plain string, and $Selected[0] became its first character.
$Selected = @(if ($Model -eq "all") { $RelayModels.Keys } else { $Model })
$UseLlama = $Runtime -ne "ollama"
$UseOllama = $Runtime -ne "llamacpp"
$Warnings = New-Object System.Collections.Generic.List[string]

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "   ..  $text" }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow; $Warnings.Add($text) }
function Fail($text) { Write-Host ""; Write-Host "SETUP STOPPED: $text" -ForegroundColor Red; exit 1 }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Winget-Install($id, $name) {
  if (-not (Has "winget")) { Fail "winget is missing. Install 'App Installer' from the Microsoft Store, then re-run, or install $name manually." }
  Info "Installing $name with winget ($id)..."
  & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}
function Download($url, $target) {
  Info "Downloading $url"
  if (Has "curl.exe") { & curl.exe -L --fail --retry 3 -o $target $url; if ($LASTEXITCODE -ne 0) { Fail "Download failed: $url" } }
  else { Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -ErrorAction Stop }
}

Write-Host "Relay setup  |  root: $Root  |  runtime: $Runtime  |  model: $Model"

# ---------------------------------------------------------------- system
Step "System"
if (-not [Environment]::Is64BitOperatingSystem) { Fail "64-bit Windows is required." }
Ok ("Windows " + [Environment]::OSVersion.Version + ", PowerShell " + $PSVersionTable.PSVersion)
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($ramGB -lt 30) { Warn "RAM is $ramGB GB; 32 GB is recommended." } else { Ok "RAM $ramGB GB" }

$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) (driver $($_.DriverVersion))" })
$gpus | ForEach-Object { Ok "GPU: $_" }
$HasArc = [bool]($gpus | Where-Object { $_ -match "Arc" })
$HasNvidia = [bool]($gpus | Where-Object { $_ -match "NVIDIA" })
if ($Backend -eq "auto") { $Backend = if ($HasArc) { "vulkan" } elseif ($HasNvidia) { "cuda" } else { "cpu" } }
Ok "llama.cpp backend: $Backend"
if ($HasArc) {
  Info "Intel Arc: install the newest Arc Pro driver from intel.com and enable Resizable BAR (ReBAR) and Above 4G Decoding in BIOS; without ReBAR llama.cpp is very slow."
  if ($HasNvidia) { Info "NVIDIA card also present. start-relay pins llama.cpp to the Arc card." }
}
if ($Backend -eq "cuda" -and (Has "nvidia-smi")) {
  $driver = [double](((& nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1) -replace "^(\d+\.\d+).*", '$1'))
  if ($driver -and $driver -lt 528) { Warn "NVIDIA driver $driver is older than 528 (needed for CUDA 12)." }
}
if ($Backend -eq "cpu") { Warn "No supported GPU detected. llama.cpp will use the CPU build and be very slow." }

$needGB = 3
if (-not $SkipModels) {
  foreach ($m in $Selected) {
    if ($UseLlama) {
      $f = Join-Path $ModelsDir $RelayModels[$m].File
      if (-not (Test-Path $f) -or (Get-Item $f).Length -ne $RelayModels[$m].Bytes) { $needGB += [math]::Ceiling($RelayModels[$m].Bytes / 1GB) }
    }
    if ($UseOllama) { $needGB += $RelayModels[$m].OllamaGB }
  }
}
$drive = Get-PSDrive -Name (Split-Path -Qualifier $Root).TrimEnd(":")
$freeGB = [math]::Floor($drive.Free / 1GB)
if ($freeGB -lt $needGB) { Fail "Drive $($drive.Name): has $freeGB GB free, setup needs about $needGB GB." }
Ok "Disk $($drive.Name): $freeGB GB free, about $needGB GB needed"

# ---------------------------------------------------------------- node
Step "Node.js (>= 22.13, runs Relay)"
function Node-Version { if (Has "node") { try { [version]((& node -v).TrimStart("v")) } catch { $null } } }
$nv = Node-Version
if (-not $nv -or $nv -lt [version]"22.13") {
  if ($nv) { Info "Found Node $nv (too old)." }
  Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS"
  $nv = Node-Version
  if (-not $nv -or $nv -lt [version]"22.13") { Fail "Node.js 22.13+ is still not available. Open a new terminal and re-run, or install it from nodejs.org." }
}
Ok "Node $nv, npm $(& npm -v)"

# ---------------------------------------------------------------- python
Step "Python + pip (downloads models)"
function Find-Python {
  foreach ($cand in @(@("py", "-3"), @("python"))) {
    if (-not (Has $cand[0])) { continue }
    $pre = @($cand | Select-Object -Skip 1)
    try { $v = & $cand[0] @pre -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null } catch { continue }
    if ($LASTEXITCODE -eq 0 -and $v -and [version]$v -ge [version]"3.10") { return , $cand }
  }
  return $null
}
$py = Find-Python
if (-not $py) {
  Winget-Install "Python.Python.3.12" "Python 3.12"
  $py = Find-Python
  if (-not $py) { Fail "Python 3.10+ is still not available. Open a new terminal and re-run." }
}
# Resolve the real executable path: a function named like the "py" launcher would call itself forever.
$PyExe = (Get-Command $py[0] -CommandType Application | Select-Object -First 1).Source
$PyPre = @($py | Select-Object -Skip 1)
function Invoke-Py { & $PyExe @PyPre @args }
Ok ("Python " + (Invoke-Py -c "import sys;print(sys.version.split()[0])"))
Invoke-Py -m pip --version *> $null
if ($LASTEXITCODE -ne 0) { Info "pip missing, running ensurepip"; Invoke-Py -m ensurepip --upgrade | Out-Host }
Invoke-Py -m pip --version *> $null
if ($LASTEXITCODE -ne 0) { Fail "pip could not be installed." }
Ok ("pip " + ((Invoke-Py -m pip --version) -split " ")[1])
Invoke-Py -c "import huggingface_hub" *> $null
if ($LASTEXITCODE -ne 0) {
  Info "Installing huggingface_hub"
  Invoke-Py -m pip install --user --disable-pip-version-check -U "huggingface_hub[hf_xet]" | Out-Host
  Invoke-Py -c "import huggingface_hub" *> $null
  if ($LASTEXITCODE -ne 0) { Fail "huggingface_hub installation failed." }
}
Ok ("huggingface_hub " + (Invoke-Py -c "import huggingface_hub as h;print(h.__version__)"))

# ---------------------------------------------------------------- git
Step "Built-in web search (no key or separate server)"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "search.ps1") -Root $Root
if ($LASTEXITCODE -ne 0) { Warn "Search could not be installed; startup will retry. Coding remains available offline." }

# ---------------------------------------------------------------- git
Step "Git (GitHub integration)"
if (-not (Has "git")) { Winget-Install "Git.Git" "Git" }
if (Has "git") { Ok (& git --version) } else { Warn "Git is not on PATH yet. Open a new terminal later." }

# ---------------------------------------------------------------- llama.cpp
if ($UseLlama) {
  Step "llama.cpp server"
  $server = Join-Path $LlamaDir "llama-server.exe"
  if ((Test-Path $server) -and -not $UpdateLlama) {
    Ok ("llama-server present (" + (Get-Content (Join-Path $LlamaDir "VERSION.txt") -ErrorAction SilentlyContinue) + ")")
  } else {
    $flavor = @{ vulkan = "vulkan-x64"; sycl = "sycl-x64"; cuda = "cuda-12.4-x64"; cpu = "cpu-x64" }[$Backend]
    $needRt = $Backend -eq "cuda"
    try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "relay-setup" } -ErrorAction Stop
    $pick = $null
    foreach ($r in $releases) {
      $main = $r.assets | Where-Object { $_.name -match "^llama-b\d+-bin-win-$([regex]::Escape($flavor))\.zip$" } | Select-Object -First 1
      $rt = $r.assets | Where-Object { $_.name -eq "cudart-llama-bin-win-$flavor.zip" } | Select-Object -First 1
      if ($main -and ($rt -or -not $needRt)) { $pick = @{ Tag = $r.tag_name; Main = $main; Runtime = $rt }; break }
    }
    if (-not $pick) { Fail "No Windows $flavor llama.cpp build found in recent releases." }
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    if (Test-Path $LlamaDir) { Remove-Item -Recurse -Force $LlamaDir -ErrorAction Stop }
    $zip = Join-Path $env:TEMP $pick.Main.name
    Download $pick.Main.browser_download_url $zip
    Expand-Archive -Path $zip -DestinationPath $LlamaDir -Force -ErrorAction Stop
    if ($needRt -and $pick.Runtime) {
      $rzip = Join-Path $env:TEMP $pick.Runtime.name
      Download $pick.Runtime.browser_download_url $rzip
      Expand-Archive -Path $rzip -DestinationPath $LlamaDir -Force -ErrorAction Stop
    }
    $found = Get-ChildItem -Path $LlamaDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
    if (-not $found) { Fail "llama-server.exe not found in the downloaded archive." }
    if ($found.DirectoryName -ne $LlamaDir) { Get-ChildItem $found.DirectoryName | Move-Item -Destination $LlamaDir -Force }
    "$($pick.Tag) $flavor" | Set-Content (Join-Path $LlamaDir "VERSION.txt")
    Ok "llama.cpp $($pick.Tag) ($flavor) installed in tools\llama.cpp"
    } catch { Fail "llama.cpp install failed: $($_.Exception.Message)" }
  }
  $ver = & $server --version 2>&1 | Select-Object -First 3
  if ($LASTEXITCODE -ne 0) { Warn "llama-server did not start: $ver. Install the latest Microsoft Visual C++ Redistributable (winget install Microsoft.VCRedist.2015+.x64)." }
  else {
    $devs = @(& $server --list-devices 2>&1 | Where-Object { $_ -match "^\s*(Vulkan|SYCL|CUDA)\d+:" } | ForEach-Object { $_.Trim() })
    if ($devs.Count) { $devs | ForEach-Object { Ok "llama.cpp device: $_" } } else { Warn "llama.cpp found no GPU device. Update the graphics driver." }
  }
}

# ---------------------------------------------------------------- ollama
if ($UseOllama) {
  Step "Ollama"
  if (-not (Has "ollama")) { Winget-Install "Ollama.Ollama" "Ollama" }
  if (-not (Has "ollama")) { Fail "Ollama is not on PATH. Open a new terminal and re-run." }
  Ok (& ollama --version 2>&1 | Select-Object -First 1)
  try { Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 -ErrorAction Stop | Out-Null }
  catch {
    Info "Starting Ollama server"
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 5
  }
}

# ---------------------------------------------------------------- models
if (-not $SkipModels) {
  Step "Models"
  foreach ($m in $Selected) {
    $spec = $RelayModels[$m]
    if ($UseLlama) {
      $f = Join-Path $ModelsDir $spec.File
      if ((Test-Path $f) -and (Get-Item $f).Length -eq $spec.Bytes) { Ok "$($spec.File) present" }
      else {
        Info "Downloading $($spec.File) ($([math]::Round($spec.Bytes / 1GB, 1)) GB) from $($spec.Repo). Interrupted downloads resume on re-run."
        New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
        Invoke-Py (Join-Path $PSScriptRoot "download_model.py") $spec.Repo $spec.File $ModelsDir | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail "Model download failed. Re-run setup to resume." }
        # huggingface_hub verifies the download itself; the catalog size is only a hint (files can be re-uploaded).
        if (-not (Test-Path $f)) { Fail "$($spec.File) is missing after download. Re-run setup." }
        $got = (Get-Item $f).Length
        if ($got -ne $spec.Bytes) { Warn "$($spec.File) is $got bytes, catalog says $($spec.Bytes). Hugging Face verified it, so continuing." }
        else { Ok "$($spec.File) downloaded and size verified" }
      }
    }
    if ($UseOllama) {
      $list = (& ollama list 2>$null) -join "`n"
      if ($list -match [regex]::Escape($spec.OllamaTag)) { Ok "Ollama has $($spec.OllamaTag)" }
      else {
        Info "ollama pull $($spec.OllamaTag)"
        & ollama pull $spec.OllamaTag | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail "ollama pull $($spec.OllamaTag) failed." }
        Ok "Ollama has $($spec.OllamaTag)"
      }
    }
  }
}

# ---------------------------------------------------------------- thinking summarizer (CPU only, optional)
# A separate CPU-only llama.cpp build guarantees the small model never touches the GPU used by the main model.
# Any failure here only disables the feature; it never stops setup.
$SummarizerReady = $false
if (-not $NoSummarizer) {
  Step "Thinking summarizer (small CPU-only model, display only)"
  try {
    $cpuDir = Join-Path $ToolsDir "llama.cpp-cpu"
    $cpuServer = Join-Path $cpuDir "llama-server.exe"
    if (-not (Test-Path $cpuServer) -or $UpdateLlama) {
      $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "relay-setup" } -ErrorAction Stop
      $asset = $null; $tag = $null
      foreach ($r in $releases) { $asset = $r.assets | Where-Object { $_.name -match "^llama-b\d+-bin-win-cpu-x64\.zip$" } | Select-Object -First 1; if ($asset) { $tag = $r.tag_name; break } }
      if (-not $asset) { throw "no Windows CPU llama.cpp build in recent releases" }
      if (Test-Path $cpuDir) { Remove-Item -Recurse -Force $cpuDir -ErrorAction Stop }
      $zip = Join-Path $env:TEMP $asset.name
      Download $asset.browser_download_url $zip
      Expand-Archive -Path $zip -DestinationPath $cpuDir -Force -ErrorAction Stop
      $found = Get-ChildItem -Path $cpuDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
      if (-not $found) { throw "llama-server.exe not found in the CPU archive" }
      if ($found.DirectoryName -ne $cpuDir) { Get-ChildItem $found.DirectoryName | Move-Item -Destination $cpuDir -Force }
      "$tag cpu-x64" | Set-Content (Join-Path $cpuDir "VERSION.txt")
    }
    $gpuDevs = @(& $cpuServer --list-devices 2>&1 | Where-Object { "$_" -match "^\s*(Vulkan|SYCL|CUDA)\d+:" })
    if ($gpuDevs.Count) { throw "the CPU build reports a GPU device; refusing to use it for the summarizer" }
    Ok ("CPU llama-server " + (Get-Content (Join-Path $cpuDir "VERSION.txt") -ErrorAction SilentlyContinue))
    $sf = Join-Path $ModelsDir $RelaySummarizer.File
    if (-not ((Test-Path $sf) -and (Get-Item $sf).Length -eq $RelaySummarizer.Bytes)) {
      Info "Downloading $($RelaySummarizer.File) ($([math]::Round($RelaySummarizer.Bytes / 1MB)) MB) from $($RelaySummarizer.Repo)"
      New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
      Invoke-Py (Join-Path $PSScriptRoot "download_model.py") $RelaySummarizer.Repo $RelaySummarizer.File $ModelsDir $RelaySummarizer.Revision | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "download failed (re-run setup to resume)" }
    }
    if ((Get-Item $sf).Length -ne $RelaySummarizer.Bytes) { throw "$($RelaySummarizer.File) has the wrong size" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sf).Hash.ToLower()
    if ($hash -ne $RelaySummarizer.Sha256) { Remove-Item -LiteralPath $sf -Force; throw "$($RelaySummarizer.File) SHA-256 mismatch; the file was removed" }
    Ok "$($RelaySummarizer.File) present, size and SHA-256 verified"
    $SummarizerReady = $true
  } catch { Warn "Thinking summarizer disabled: $($_.Exception.Message). Relay works without it." }
}

# ---------------------------------------------------------------- toolchains
Step "Developer toolchains (for compile/test work)"
if (Has "dotnet") { $sdks = & dotnet --list-sdks 2>$null } else { $sdks = $null }
if ($sdks) { Ok (".NET SDK " + (($sdks | ForEach-Object { ($_ -split " ")[0] }) -join ", ")) }
elseif ($Toolchains) { Winget-Install "Microsoft.DotNet.SDK.10" ".NET SDK 10" } else { Warn ".NET SDK not found (re-run with -Toolchains to install)." }
if (Has "cmake") { Ok (& cmake --version | Select-Object -First 1) }
elseif ($Toolchains) { Winget-Install "Kitware.CMake" "CMake" } else { Warn "CMake not found (re-run with -Toolchains to install)." }
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$msvc = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName } else { $null }
if ($msvc) { Ok "MSVC: $msvc" } else { Warn "MSVC C++ tools not found. Install Visual Studio or Build Tools with 'Desktop development with C++'." }

# ---------------------------------------------------------------- relay
Step "Relay application"
Push-Location $Root
try {
  Info "npm ci"
  & npm ci --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }
  Info "npm run build"
  & npm run build | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "Build failed." }
} finally { Pop-Location }
Ok "Relay built (dist\index.cjs)"

$cfg = [ordered]@{
  runtime = if ($UseLlama) { "llamacpp" } else { "ollama" }
  model   = $Selected[0]
  backend = $Backend
  models  = $Selected
  python  = (@($PyExe) + $PyPre) -join " "
  summarizer = $SummarizerReady
}
$cfg | ConvertTo-Json | Set-Content (Join-Path $Root "relay-config.json")
Ok "Saved relay-config.json"

Write-Host ""
if ($Warnings.Count) { Write-Host "Warnings:" -ForegroundColor Yellow; $Warnings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow } }
Write-Host "Setup complete. Start Relay with: start-relay.cmd" -ForegroundColor Green
