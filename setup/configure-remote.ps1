<# Local-only configuration. Does NOT open the firewall/router or upload anything.
   Existing CA-issued PFX may be supplied; otherwise creates an IP certificate
   whose public .cer must be trusted explicitly on each client device. #>
param([int]$HttpsPort = 5443, [string]$CertificatePfx = "")
$ErrorActionPreference = "Stop"
try {
  $Root = Split-Path -Parent $PSScriptRoot
  Set-Location $Root
  if (-not (Test-Path "dist\configure-access.mjs")) { throw "Run setup.cmd first to rebuild Relay." }
  if ($HttpsPort -lt 1024 -or $HttpsPort -gt 65535) { throw "HTTPS port must be 1024-65535." }
  Write-Host "Stop Relay before configuring. One owner account has full access to projects and GitHub." -ForegroundColor Yellow
  Write-Host "Use a PUBLIC IPv4 address for internet access, not the PC's 192.168.x.x address."
  $address = (Read-Host "Public IP (or DNS hostname matching your own PFX certificate)").Trim()
  $ip = $null
  $isIp = [Net.IPAddress]::TryParse($address, [ref]$ip)
  if ($isIp -and $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw "This setup supports IPv4. Use a DNS hostname with your own PFX for other setups." }
  if (-not $isIp -and ($address -notmatch '^[A-Za-z0-9.-]+$' -or -not $CertificatePfx)) {
    throw "Enter an IPv4 address, or pass -CertificatePfx with a certificate for your hostname."
  }
  $username = (Read-Host "Relay username (3-64 letters, digits, dot, underscore, hyphen)").Trim()
  if ($username -notmatch '^[A-Za-z0-9._-]{3,64}$') { throw "Invalid username." }
  $secure = Read-Host "New unique Relay password (at least 15 characters)" -AsSecureString
  $confirm = Read-Host "Repeat password" -AsSecureString
  function Plain($v) {
    $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($v)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
  }
  $password = Plain $secure
  if ($password.Length -lt 15 -or $password.Length -gt 256 -or $password -cne (Plain $confirm)) { throw "Passwords must match and be 15-256 characters." }
  $null = New-Item -ItemType Directory -Force "secrets"
  if ($CertificatePfx) {
    $pfx = (Resolve-Path $CertificatePfx).Path
    $pfxPass = Plain (Read-Host "PFX certificate password" -AsSecureString)
  } else {
    Write-Host "Creating a self-signed certificate. Trust the exported public certificate on each client before signing in; do not bypass browser warnings." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate -Type Custom -Subject "CN=$address" `
      -CertStoreLocation "Cert:\CurrentUser\My" -KeyAlgorithm RSA -KeyLength 3072 `
      -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddMonths(12) `
      -TextExtension @("2.5.29.17={text}IPAddress=$address&IPAddress=127.0.0.1&DNS=localhost", "2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
      -KeyUsage DigitalSignature,KeyEncipherment
    $pfxPass = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
    $pfx = Join-Path $Root ("secrets\remote-" + $cert.Thumbprint + ".pfx")
    $null = Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $pfxPass -AsPlainText -Force) -CryptoAlgorithmOption AES256_SHA256
    $null = Export-Certificate -Cert $cert -FilePath (Join-Path $Root "relay-public.cer")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { Write-Host ("Certificate SHA-256 fingerprint: " + [BitConverter]::ToString($sha.ComputeHash($cert.RawData)).Replace("-", "")) }
    finally { $sha.Dispose() }
    Write-Host "Public certificate: relay-public.cer. Never share the .pfx or secrets folder."
  }
  $env:DATA_FILE = Join-Path $Root "data.db"
  $origin = "https://${address}:$HttpsPort"
  $payload = @{ username=$username; password=$password; publicOrigin=$origin; port=$HttpsPort; pfx=$pfx; passphrase=$pfxPass } | ConvertTo-Json -Compress
  $OutputEncoding = [Text.UTF8Encoding]::new($false)
  $payload | & node "dist\configure-access.mjs"
  if ($LASTEXITCODE -ne 0) { throw "Could not save remote access configuration." }
  @{ url=$origin; port=$HttpsPort } | ConvertTo-Json | Set-Content -Encoding UTF8 "remote-access.json"
  Write-Host "Configured: $origin" -ForegroundColor Green
  Write-Host "Restart using start-relay.cmd. Open only TCP $HttpsPort in Windows Firewall and forward the same TCP port on your router to this PC."
  Write-Host "Do NOT expose HTTP 5000, llama.cpp 8080 or Ollama 11434. No firewall/router rules were changed."
} catch { Write-Host "CONFIGURATION STOPPED: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
finally { $password = $null; $pfxPass = $null; $payload = $null; $secure = $null; $confirm = $null }
