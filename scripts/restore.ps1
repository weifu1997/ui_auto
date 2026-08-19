param([Parameter(Mandatory=$true)][string]$Backup, [string]$Root = "D:\AutoFlow")
$ErrorActionPreference = "Stop"
$backupPath = (Resolve-Path -LiteralPath $Backup).Path
if (-not (Test-Path -LiteralPath (Join-Path $backupPath "backup.json"))) { throw "Invalid AutoFlow backup" }
$service = Join-Path $Root "AutoFlow.exe"
if (Test-Path -LiteralPath $service) { & $service stop }
$data = Join-Path $Root "data"; New-Item -ItemType Directory -Force -Path $data | Out-Null
foreach ($name in @("platform.sqlite", "autoflow.sqlite")) {
  Remove-Item -LiteralPath (Join-Path $data ("$name-wal")) -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $data ("$name-shm")) -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath (Join-Path $backupPath $name)) { Copy-Item -LiteralPath (Join-Path $backupPath $name) -Destination (Join-Path $data $name) -Force }
}
$artifactBackup = Join-Path $backupPath "artifacts"
if (Test-Path -LiteralPath $artifactBackup) {
  $artifactTarget = Join-Path $data "artifacts"
  if (Test-Path -LiteralPath $artifactTarget) { Remove-Item -LiteralPath $artifactTarget -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $artifactTarget | Out-Null
  Get-ChildItem -LiteralPath $artifactBackup -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $artifactTarget -Recurse -Force
  }
}
if (Test-Path -LiteralPath $service) { & $service start }
