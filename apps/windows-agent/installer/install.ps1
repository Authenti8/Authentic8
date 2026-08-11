param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [string]$InstallDirectory = "$env:LOCALAPPDATA\Authenti8\Verify",
  [string]$ExtensionId = "",
  [string]$ActivationUrl = ""
)
$ErrorActionPreference = "Stop"
$os = Get-CimInstance Win32_OperatingSystem
if ([Environment]::OSVersion.Version.Build -lt 22000 -or $os.ProductType -ne 1) {
  throw "Authenti8 Verify currently supports Windows 11 workstations only."
}
$executable = Join-Path $PackageDirectory "Authenti8Verify.exe"
$nativeHostExecutable = Join-Path $PackageDirectory "Authenti8VerifyNativeHost.exe"
foreach ($signedExecutable in @($executable, $nativeHostExecutable)) {
  if (-not (Test-Path -LiteralPath $signedExecutable -PathType Leaf)) {
    throw "An Authenti8 Verify executable is missing."
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $signedExecutable
  if ($signature.Status -ne "Valid" -or -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Authenti8(,|$)') {
    throw "Installation refused: an Authenti8 Verify executable is not Authenticode-signed."
  }
}
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
Copy-Item -Path (Join-Path $PackageDirectory "*") -Destination $InstallDirectory -Recurse -Force
$installedExecutable = Join-Path $InstallDirectory "Authenti8Verify.exe"
$protocol = "HKCU:\Software\Classes\authenti8"
New-Item -Path $protocol -Force | Out-Null
Set-ItemProperty -Path $protocol -Name "(default)" -Value "URL:Authenti8 Verify Protocol"
Set-ItemProperty -Path $protocol -Name "URL Protocol" -Value ""
$command = New-Item -Path "$protocol\shell\open\command" -Force
Set-ItemProperty -Path $command.PSPath -Name "(default)" -Value "`"$installedExecutable`" `"%1`""
$uninstall = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Authenti8Verify"
New-Item -Path $uninstall -Force | Out-Null
Set-ItemProperty -Path $uninstall -Name DisplayName -Value "Authenti8 Verify"
Set-ItemProperty -Path $uninstall -Name Publisher -Value "Authenti8"
Set-ItemProperty -Path $uninstall -Name UninstallString -Value "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -File `"$InstallDirectory\installer\uninstall.ps1`""
if ($ExtensionId) {
  if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "The Chrome extension ID is invalid." }
  $manifestPath = Join-Path $InstallDirectory "installer\native-messaging-host.json"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw
  $manifest = $manifest.Replace("AUTHENTI8_INSTALL_PATH", $InstallDirectory.Replace("\", "\\"))
  $manifest = $manifest.Replace("AUTHENTI8_EXTENSION_ID", $ExtensionId)
  [IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
  $nativeHost = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.authenti8.verify"
  New-Item -Path $nativeHost -Force | Out-Null
  Set-ItemProperty -Path $nativeHost -Name "(default)" -Value $manifestPath
}
if ($ActivationUrl) {
  if ($ActivationUrl -notmatch '^authenti8://verify\?token=[a-f0-9]{64}$') {
    throw "The Authenti8 activation URL is invalid."
  }
  Start-Process -FilePath $installedExecutable -ArgumentList $ActivationUrl
}
