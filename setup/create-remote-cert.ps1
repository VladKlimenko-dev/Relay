<# Called by Relay Settings. JSON stdin only. Never modifies firewall or certificate trust. #>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$generated = $null
try {
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -gt 16000) { throw "Invalid input." }
  $c = $raw | ConvertFrom-Json
  if ($c.pfx) {
    $pfx = [string]$c.pfx
    $passphrase = [string]$c.passphrase
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $pfx, $passphrase, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  } else {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse([string]$c.address, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw "IPv4 required." }
    $generated = New-SelfSignedCertificate -Type Custom -Subject "CN=$($c.address)" `
      -CertStoreLocation "Cert:\CurrentUser\My" -KeyAlgorithm RSA -KeyLength 3072 `
      -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddMonths(12) `
      -TextExtension @("2.5.29.17={text}IPAddress=$($c.address)&IPAddress=127.0.0.1&DNS=localhost", "2.5.29.37={text}1.3.6.1.5.5.7.3.1") `
      -KeyUsage DigitalSignature,KeyEncipherment
    $cert = $generated
    $passphrase = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
    $pfx = Join-Path ([string]$c.directory) ("remote-" + $generated.Thumbprint + ".pfx")
    $null = Export-PfxCertificate -Cert $cert -FilePath $pfx `
      -Password (ConvertTo-SecureString $passphrase -AsPlainText -Force) -CryptoAlgorithmOption AES256_SHA256
  }
  @{ pfx=$pfx; passphrase=$passphrase; certificate=[Convert]::ToBase64String($cert.RawData) } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine("Certificate creation/export failed.")
  exit 1
} finally {
  if ($generated) { Remove-Item ("Cert:\CurrentUser\My\" + $generated.Thumbprint) -ErrorAction SilentlyContinue }
  if ($cert) { $cert.Dispose() }
  $passphrase = $null; $raw = $null; $c = $null
}
