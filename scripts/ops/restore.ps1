param([Parameter(Mandatory=$true)][string]$Backup, [string]$Root = "D:\AutoFlow", [string]$PythonExe = "")
$ErrorActionPreference = "Stop"
$backupPath = (Resolve-Path -LiteralPath $Backup).Path
if (-not (Test-Path -LiteralPath (Join-Path $backupPath "backup.json"))) { throw "Invalid AutoFlow backup" }
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { Join-Path $Root "app\venv\Scripts\python.exe" }
$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$manifestScript = Join-Path $scriptRoot "backup-manifest.py"
& $python $manifestScript verify $backupPath
if ($LASTEXITCODE -ne 0) { throw "Backup manifest verification failed" }
$service = Join-Path $Root "AutoFlow.exe"
if (Test-Path -LiteralPath $service) {
  & $service stop
  if ($LASTEXITCODE -ne 0) { throw "AutoFlow service stop failed with exit code $LASTEXITCODE" }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $running = Get-Process -Name "AutoFlow" -ErrorAction SilentlyContinue
    if (-not $running) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  if (Get-Process -Name "AutoFlow" -ErrorAction SilentlyContinue) {
    throw "AutoFlow service did not stop before restore"
  }
}
$data = Join-Path $Root "data"; New-Item -ItemType Directory -Force -Path $data | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $backupPath "platform.sqlite"))) { throw "Backup missing platform.sqlite" }
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
if (Test-Path -LiteralPath $service) {
  & $service start
  if ($LASTEXITCODE -ne 0) { throw "AutoFlow service start failed with exit code $LASTEXITCODE" }
}
