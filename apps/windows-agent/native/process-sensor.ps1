$ErrorActionPreference = "SilentlyContinue"
$rows = Get-CimInstance Win32_Process | ForEach-Object {
  $path = $_.ExecutablePath
  $file = if ($path) { Get-Item -LiteralPath $path } else { $null }
  $version = if ($file) { $file.VersionInfo.FileVersion } else { $null }
  [pscustomobject]@{
    processId = [int]$_.ProcessId
    parentProcessId = [int]$_.ParentProcessId
    executableName = [string]$_.Name
    path = $path
    size = if ($file) { [long]$file.Length } else { $null }
    modifiedAt = if ($file) { $file.LastWriteTimeUtc.ToString("o") } else { $null }
    productName = if ($file) { $file.VersionInfo.ProductName } else { $null }
    fileVersion = $version
    startedAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }
  }
}
@($rows) | ConvertTo-Json -Compress -Depth 4
