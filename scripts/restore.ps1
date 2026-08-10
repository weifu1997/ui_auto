param([Parameter(Mandatory=$true)][string]$Backup, [string]$Root = "D:\AutoFlow")
$ErrorActionPreference = "Stop"
$backupPath = (Resolve-Path -LiteralPath $Backup).Path
if (-not (Test-Path -LiteralPath (Join-Path $backupPath "backup.json"))) { throw "Invalid AutoFlow backup" }
$service = Join-Path $Root "AutoFlow.exe"
if (Test-Path -LiteralPath $service) { & $service stop }
$data = Join-Path $Root "data"; New-Item -ItemType Directory -Force -Path $data | Out-Null
foreach ($name in @("platform.sqlite", "autoflow.sqlite")) { if (Test-Path -LiteralPath (Join-Path $backupPath $name)) { Copy-Item -LiteralPath (Join-Path $backupPath $name) -Destination (Join-Path $data $name) -Force } }
if (Test-Path -LiteralPath (Join-Path $backupPath "artifacts")) {
  $artifactTarget = Join-Path $Root "artifacts"
  New-Item -ItemType Directory -Force -Path $artifactTarget | Out-Null
  Copy-Item -Path (Join-Path $backupPath "artifacts\*") -Destination $artifactTarget -Recurse -Force
}
if (Test-Path -LiteralPath $service) { & $service start }
