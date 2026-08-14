param(
  [Parameter(Mandatory = $true)][ValidateSet("enqueue", "claim", "ack")][string]$Action,
  [string]$Value = ""
)
$ErrorActionPreference = "Stop"
$directory = Join-Path $env:LOCALAPPDATA "Authenti8\Verify\state"
$path = Join-Path $directory "browser-evidence.bin"
$mutex = [Threading.Mutex]::new($false, "Local\Authenti8BrowserEvidence")
if (-not $mutex.WaitOne(5000)) { throw "Browser evidence store is busy." }
try {
  $state = [pscustomobject]@{ queue = @(); inFlight = $null }
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $protected = [IO.File]::ReadAllBytes($path)
    $clear = [Security.Cryptography.ProtectedData]::Unprotect(
      $protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $stored = [Text.Encoding]::UTF8.GetString($clear) | ConvertFrom-Json
    if ($null -ne $stored.queue) {
      $state = [pscustomobject]@{ queue = @($stored.queue); inFlight = $stored.inFlight }
    } else {
      $state.queue = @($stored)
    }
  }
  $response = $null
  if ($Action -eq "enqueue") {
    $incoming = @([Text.Encoding]::UTF8.GetString(
      [Convert]::FromBase64String($Value)) | ConvertFrom-Json)
    $state.queue = @($state.queue + $incoming | Select-Object -Last 500)
    $response = [pscustomobject]@{ saved = $true }
  } elseif ($Action -eq "claim") {
    if ($null -eq $state.inFlight -and $state.queue.Count -gt 0) {
      $state.inFlight = [pscustomobject]@{
        claimId = [Guid]::NewGuid().ToString(); evidence = @($state.queue)
      }
      $state.queue = @()
    }
    if ($null -eq $state.inFlight) {
      $response = [pscustomobject]@{ evidence = @() }
    } else {
      $response = $state.inFlight
    }
  } else {
    $acknowledged = $null -ne $state.inFlight -and $state.inFlight.claimId -eq $Value
    if ($acknowledged) { $state.inFlight = $null }
    $response = [pscustomobject]@{ acknowledged = $acknowledged }
  }
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $json = $state | ConvertTo-Json -Compress -Depth 8
  $clear = [Text.Encoding]::UTF8.GetBytes($json)
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $clear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $temporary = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllBytes($temporary, $protected)
  Move-Item -LiteralPath $temporary -Destination $path -Force
  @($response) | ConvertTo-Json -Compress -Depth 8
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
