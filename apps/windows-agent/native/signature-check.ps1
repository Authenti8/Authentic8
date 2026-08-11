param([string]$Path = $([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName))
$signature = Get-AuthenticodeSignature -LiteralPath $Path
@([pscustomobject]@{
  path = $Path
  status = [string]$signature.Status
  signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
  signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
}) | ConvertTo-Json -Compress
