<# Only stop a model process started and recorded by this Relay installation. #>
$ErrorActionPreference = "Stop"
try {
  . (Join-Path $PSScriptRoot "background-process.ps1")
  Stop-RelayOwnedModel (Split-Path -Parent $PSScriptRoot)
  exit 0
} catch {
  Write-Error $_
  exit 1
}
