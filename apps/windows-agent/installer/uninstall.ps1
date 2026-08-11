$ErrorActionPreference = "Stop"
$installerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDirectory = Split-Path -Parent $installerDirectory
Remove-Item -LiteralPath "HKCU:\Software\Classes\authenti8" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Authenti8Verify" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.authenti8.verify" -Recurse -Force -ErrorAction SilentlyContinue
$cleanup = "Start-Sleep -Seconds 2; Remove-Item -LiteralPath '$($installDirectory.Replace("'", "''"))' -Recurse -Force"
$powershell = Join-Path $PSHOME "powershell.exe"
Start-Process -FilePath $powershell -ArgumentList "-NoProfile", "-NonInteractive", "-Command", $cleanup -WindowStyle Hidden
