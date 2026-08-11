param(
  [Parameter(Mandatory = $true)][ValidateSet("load", "save", "remove")][string]$Action,
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$EncodedIdentity = ""
)
$ErrorActionPreference = "Stop"
if ($Key -notmatch '^[a-f0-9]{64}$') { throw "Credential key is invalid." }
$directory = Join-Path $env:LOCALAPPDATA "Authenti8\Verify\state"
$path = Join-Path $directory "$Key.bin"
if ($Action -eq "load") {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    @([pscustomobject]@{ found = $false }) | ConvertTo-Json -Compress
    exit 0
  }
  $protected = [IO.File]::ReadAllBytes($path)
  $clear = [Security.Cryptography.ProtectedData]::Unprotect(
    $protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $identity = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json
  @([pscustomobject]@{ found = $true; identity = $identity }) | ConvertTo-Json -Compress -Depth 5
  exit 0
}
if ($Action -eq "remove") {
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  @([pscustomobject]@{ removed = $true }) | ConvertTo-Json -Compress
  exit 0
}
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedIdentity))
$clear = [Text.Encoding]::UTF8.GetBytes($json)
$protected = [Security.Cryptography.ProtectedData]::Protect(
  $clear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$temporary = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
[IO.File]::WriteAllBytes($temporary, $protected)
Move-Item -LiteralPath $temporary -Destination $path -Force
@([pscustomobject]@{ saved = $true }) | ConvertTo-Json -Compress
