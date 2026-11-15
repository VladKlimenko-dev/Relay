<# Targeted launch/process-ownership checks; does not launch or terminate model processes. #>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $Root "setup/background-process.ps1")
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
foreach ($file in Get-ChildItem (Join-Path $Root "setup/*.ps1")) {
  $errors = $null; $tokens = $null
  $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  Assert (-not $errors) "Parse failure in $($file.Name): $errors"
}
$start = Get-Content (Join-Path $Root "setup/start-relay.ps1") -Raw
Assert ($start -notmatch '\$node.WaitForExit') "Launcher still waits for the server"
Assert ($start -notmatch '\-NoNewWindow') "Server still inherits the console"
Assert (([regex]::Matches($start, "-RedirectStandardOutput")).Count -eq 3) "Missing server/model log redirection"
Assert (([regex]::Matches($start, "-WindowStyle Hidden")).Count -eq 3) "Model/server not hidden"
$cmd = Get-Content (Join-Path $Root "start-relay.cmd") -Raw
Assert ($cmd -match 'if not "%result%"=="0" pause') "Launcher still pauses on success"
$temp = Join-Path ([IO.Path]::GetTempPath()) ("relay-background-test-" + [Guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory $temp
try {
  [IO.File]::WriteAllText((Join-Path $temp "relay.stderr.log"), "previous diagnostics")
  Backup-RelayLogs $temp "relay"
  Assert ([IO.File]::ReadAllText((Join-Path $temp "relay.stderr.log.previous")) -eq "previous diagnostics") "Previous log was lost"
  $process = Get-Process -Id $PID
  Save-RelayProcess $temp ".relay-model.json" $process
  $saved = Get-Content (Join-Path $temp ".relay-model.json") -Raw | ConvertFrom-Json
  Assert ($saved.pid -eq $PID -and $saved.executable -eq $process.Path) "Incorrect process identity"
  $refused = $false
  try { Stop-RelayOwnedModel $temp } catch { $refused = $true }
  Assert $refused "Unrelated process was not refused"
  # A recycled PID with a different start time must not be stopped.
  $saved.startedAt = [DateTime]::UtcNow.AddDays(-1).ToString("o")
  $saved | ConvertTo-Json | Set-Content (Join-Path $temp ".relay-model.json")
  Stop-RelayOwnedModel $temp
  Assert (-not (Test-Path (Join-Path $temp ".relay-model.json"))) "Stale marker not removed"
  Assert ($null -ne (Get-Process -Id $PID)) "Recycled PID was stopped"
  Write-Host "PASS: PowerShell parsing, hidden launch/log wiring, automatic launcher exit, log retention, unrelated-process and recycled-PID safeguards"
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
