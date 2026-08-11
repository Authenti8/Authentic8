param(
  [Parameter(Mandatory = $true)][string]$NewExecutable,
  [Parameter(Mandatory = $true)][string]$InstalledExecutable,
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][string]$ActivationUrl,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256
)
$ErrorActionPreference = "Stop"
if ($ActivationUrl -notmatch '^authenti8://verify\?token=[a-f0-9]{64}$') {
  throw "The Authenti8 activation URL is invalid."
}
if ($ExpectedSha256 -notmatch '^[a-f0-9]{64}$') { throw "The update hash is invalid." }
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
  if ([DateTime]::UtcNow -ge $deadline) { throw "The running agent did not exit for update." }
  Start-Sleep -Milliseconds 250
}
if ((Get-FileHash -LiteralPath $NewExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne
    $ExpectedSha256.ToLowerInvariant()) { throw "The update package hash does not match." }
$staging = Join-Path $env:TEMP "Authenti8-Update-$([Guid]::NewGuid().ToString('N'))"
Expand-Archive -LiteralPath $NewExecutable -DestinationPath $staging
$stagedExecutable = Join-Path $staging "Authenti8Verify.exe"
$stagedNativeHost = Join-Path $staging "Authenti8VerifyNativeHost.exe"
$stagedNative = Join-Path $staging "native"
if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $stagedNativeHost -PathType Leaf) -or
    -not (Test-Path -LiteralPath $stagedNative -PathType Container)) {
  throw "The update package is incomplete."
}
foreach ($signedExecutable in @($stagedExecutable, $stagedNativeHost)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $signedExecutable
  if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Authenti8(,|$)') {
    throw "The downloaded Authenti8 update is not correctly signed."
  }
}
$installDirectory = Split-Path -Parent $InstalledExecutable
$backup = Join-Path $installDirectory ".update-backup-$([Guid]::NewGuid().ToString('N'))"
$journalPath = Join-Path $installDirectory ".update-journal.json"
$newExecutableSha256 = (Get-FileHash -LiteralPath $stagedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
function Write-Journal([string]$Phase) {
  $temporaryJournal = "$journalPath.tmp"
  $json = [pscustomobject]@{ phase = $Phase; backup = $backup; staging = $staging;
    packagePath = $NewExecutable; newExecutableSha256 = $newExecutableSha256 } |
    ConvertTo-Json -Compress
  [IO.File]::WriteAllText($temporaryJournal, $json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryJournal -Destination $journalPath -Force
}
New-Item -ItemType Directory -Path $backup | Out-Null
Write-Journal "prepared"
try {
  $installedManifest = Join-Path $installDirectory "installer\native-messaging-host.json"
  $renderedManifest = if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
    Get-Content -LiteralPath $installedManifest -Raw
  } else { $null }
  foreach ($directory in @("native", "installer")) {
    $installed = Join-Path $installDirectory $directory
    $incoming = Join-Path $staging $directory
    if (Test-Path -LiteralPath $installed) {
      Move-Item -LiteralPath $installed -Destination (Join-Path $backup $directory)
    }
    if (Test-Path -LiteralPath $incoming) {
      Move-Item -LiteralPath $incoming -Destination $installed
    }
  }
  if ($renderedManifest) {
    $incomingManifest = Join-Path $installDirectory "installer\native-messaging-host.json"
    [IO.File]::WriteAllText($incomingManifest, $renderedManifest, [Text.UTF8Encoding]::new($false))
  }
  $installedNativeHost = Join-Path $installDirectory "Authenti8VerifyNativeHost.exe"
  if (Test-Path -LiteralPath $installedNativeHost) {
    Move-Item -LiteralPath $installedNativeHost -Destination (Join-Path $backup "Authenti8VerifyNativeHost.exe")
  }
  Write-Journal "assets_replaced"
  $replacement = "$InstalledExecutable.new"
  Copy-Item -LiteralPath $stagedExecutable -Destination $replacement -Force
  Copy-Item -LiteralPath $stagedNativeHost -Destination (Join-Path $installDirectory "Authenti8VerifyNativeHost.exe.new") -Force
  Write-Journal "commit_executable"
  Move-Item -LiteralPath (Join-Path $installDirectory "Authenti8VerifyNativeHost.exe.new") `
    -Destination (Join-Path $installDirectory "Authenti8VerifyNativeHost.exe") -Force
  Move-Item -LiteralPath $replacement -Destination $InstalledExecutable -Force
} catch {
  foreach ($directory in @("native", "installer")) {
    $installed = Join-Path $installDirectory $directory
    $saved = Join-Path $backup $directory
    Remove-Item -LiteralPath $installed -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $installed }
  }
  $savedNativeHost = Join-Path $backup "Authenti8VerifyNativeHost.exe"
  Remove-Item -LiteralPath (Join-Path $installDirectory "Authenti8VerifyNativeHost.exe") `
    -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $savedNativeHost) {
    Move-Item -LiteralPath $savedNativeHost -Destination (Join-Path $installDirectory "Authenti8VerifyNativeHost.exe")
  }
  Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
  throw
}
Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $NewExecutable -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $journalPath -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $InstalledExecutable -ArgumentList $ActivationUrl
