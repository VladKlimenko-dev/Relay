<# Safe application-only copying from a GitHub snapshot. No git reset/clean, no user-data copy. #>
$RelayCodeDirs = @("client", "server", "shared", "script", "setup", "tests", "public", "attached_assets")
$RelayCodeFiles = @("package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "tailwind.config.ts",
  "postcss.config.js", "components.json", "drizzle.config.ts", "README.md", "QA.md", "LICENSE", ".gitignore", ".env.example",
  "setup.cmd", "start-relay.cmd", "update-relay.cmd", "configure-remote.cmd")
function Test-RelayCodePath([string]$Name) {
  if (-not $Name -or $Name.StartsWith("/") -or $Name -match '[:\\]') { return $false }
  $parts = $Name.Split("/")
  if (@($parts | Where-Object { $_ -in @("", ".", "..") -or $_ -match '[. ]$' }).Count) { return $false }
  if ($parts.Count -eq 1) { return $RelayCodeFiles -contains $Name }
  return $RelayCodeDirs -contains $parts[0]
}
function Assert-RelayDestination([string]$Root, [string]$File) {
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $cursor = [IO.Path]::GetFullPath($File)
  if (-not ($cursor + [IO.Path]::DirectorySeparatorChar).StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Update path escapes the installation."
  }
  while ($cursor -and $cursor.Length -ge $rootPath.Length) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Update refused: an application path is a symbolic link or junction."
      }
    }
    if ($cursor -eq $rootPath) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Expand-RelayGitHubSnapshot([string]$Archive, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
  try {
    if ($zip.Entries.Count -gt 20000) { throw "Update contains too many files." }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = @(); [long]$size = 0; $prefix = $null
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace("\", "/").TrimEnd("/")
      if (-not $name) { continue }
      $parts = $name.Split("/")
      if ($name.StartsWith("/") -or $name -match ':' -or @($parts | Where-Object { $_ -in @("", ".", "..") -or $_ -match '[. ]$' }).Count) {
        throw "Unsafe archive path."
      }
      if (($entry.ExternalAttributes -band 0xF0000000L) -eq 0xA0000000L) { throw "Archive links are not allowed." }
      if (-not $prefix) { $prefix = $parts[0] }
      if ($prefix -ne $parts[0] -or $prefix -notmatch '^Relay-[A-Za-z0-9._-]+$') { throw "Unexpected GitHub archive layout." }
      if ($entry.FullName.EndsWith("/") -or $parts.Count -lt 2) { continue }
      $relative = ($parts | Select-Object -Skip 1) -join "/"
      if (-not (Test-RelayCodePath $relative)) { continue }
      if (-not $seen.Add($relative)) { throw "Duplicate archive path." }
      $size += $entry.Length
      if ($size -gt 268435456) { throw "Application update exceeds 256 MB." }
      $files += @{ Entry=$entry; Relative=$relative }
    }
    foreach ($file in $files) {
      $target = Join-Path $Destination $file.Relative
      Assert-RelayDestination $Destination $target
      $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target))
      $inputStream = $file.Entry.Open()
      $outputStream = [IO.File]::Create($target)
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
  foreach ($required in @("package.json", "package-lock.json", "server/index.ts", "setup/launch-relay.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $Destination $required) -PathType Leaf)) { throw "Incomplete Relay update." }
  }
}
function Copy-RelayGitHubSnapshot([string]$Source, [string]$Target) {
  $sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd("\", "/")
  $files = @(Get-ChildItem -LiteralPath $Source -File -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($sourcePath.Length + 1).Replace("\", "/")
    if (-not (Test-RelayCodePath $relative)) { throw "Staging contains a protected path." }
    Assert-RelayDestination $Source $_.FullName
    Assert-RelayDestination $Target (Join-Path $Target $relative)
    @{ Source=$_.FullName; Relative=$relative }
  })
  foreach ($file in $files) {
    $targetFile = Join-Path $Target $file.Relative
    $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($targetFile))
    Copy-Item -LiteralPath $file.Source -Destination $targetFile -Force
  }
}
function Test-RelayServerRunning([string]$Root, [int]$Port = 5000) {
  $pidFile = Join-Path $Root ".relay-server.json"
  if (Test-Path -LiteralPath $pidFile) {
    try {
      $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
      $process = Get-Process -Id $saved.pid -ErrorAction Stop
      if ($process.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$saved.startedAt).ToUniversalTime().Ticks) { return $true }
    } catch { }
  }
  try {
    $request = [Net.WebRequest]::Create("http://127.0.0.1:$Port/api/health")
    $request.Proxy = $null; $request.Timeout = 1200
    $response = $request.GetResponse()
    try { return [int]$response.StatusCode -eq 200 } finally { $response.Close() }
  } catch { return $false }
}
