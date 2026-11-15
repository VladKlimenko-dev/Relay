function Backup-RelayLogs([string]$Directory, [string]$Name) {
  foreach ($stream in @("stdout", "stderr")) {
    $file = Join-Path $Directory "$Name.$stream.log"
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination "$file.previous" -Force -ErrorAction Stop }
  }
}
function Save-RelayProcess([string]$Root, [string]$Marker, $Process) {
  # PID alone is unsafe: Windows may reuse it after a process exits.
  @{ pid=$Process.Id; startedAt=$Process.StartTime.ToUniversalTime().ToString("o"); executable=$Process.Path } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root $Marker) -Encoding UTF8 -ErrorAction Stop
}
function Stop-RelayOwnedModel([string]$Root) {
  $marker = Join-Path $Root ".relay-model.json"
  if (-not (Test-Path -LiteralPath $marker)) { return }
  $saved = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $process = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
  if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$saved.startedAt).ToUniversalTime().Ticks) {
    if ($process.ProcessName -notin @("llama-server", "ollama") -or -not $saved.executable -or $process.Path -ne $saved.executable) {
      throw "Model process identity does not match; it was not stopped."
    }
    # Include model runner children (notably Ollama's GPU worker), but never stop by process name.
    & taskkill.exe /PID $process.Id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not $process.HasExited) { throw "The model process could not be stopped." }
    if (-not $process.WaitForExit(10000)) { throw "The model process did not exit." }
  }
  Remove-Item -LiteralPath $marker -Force -ErrorAction Stop
}
