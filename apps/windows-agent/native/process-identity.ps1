param([Parameter(Mandatory = $true)][string]$EncodedPaths)
$ErrorActionPreference = "SilentlyContinue"
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPaths))
$paths = ConvertFrom-Json $json
$rows = foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  [pscustomobject]@{
    path = $path
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    signerSubject = if ($signature.Status -eq "Valid" -and $signature.SignerCertificate) {
      $signature.SignerCertificate.Subject
    } else { $null }
    signerThumbprint = if ($signature.Status -eq "Valid" -and $signature.SignerCertificate) {
      $signature.SignerCertificate.Thumbprint
    } else { $null }
  }
}
@($rows) | ConvertTo-Json -Compress -Depth 3
