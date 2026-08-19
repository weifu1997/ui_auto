param([string]$NodeExe = "", [string]$PythonExe = "")
$ErrorActionPreference = "Stop"

$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$errors = @()
foreach ($script in Get-ChildItem -LiteralPath $scriptRoot -Filter "*.ps1" -File) {
  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) { $errors += $parseErrors | ForEach-Object { "$($script.Name): $($_.Message)" } }
}
if ($errors.Count -gt 0) { throw ($errors -join [Environment]::NewLine) }
$serviceTemplate = Get-Content -Raw -LiteralPath (Join-Path $scriptRoot "..\deployment\AutoFlow.xml")
$renderedService = $serviceTemplate.Replace("__PLATFORM_SECRET_KEY__", [Security.SecurityElement]::Escape("smoke&secret-with-at-least-32-characters")).Replace("__NOTIFICATION_HOST_ALLOWLIST__", "hooks.corp.test").Replace("__ALLOW_PRIVATE_NOTIFICATION_URLS__", "1")
try { [xml]$renderedService | Out-Null } catch { throw "Rendered WinSW service configuration is invalid: $($_.Exception.Message)" }

$node = if ($NodeExe) { (Resolve-Path -LiteralPath $NodeExe).Path } else { (Get-Command node -ErrorAction Stop).Source }
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { (Get-Command python -ErrorAction Stop).Source }
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$smokeRoot = Join-Path $tempBase ("autoflow-windows-smoke-" + [guid]::NewGuid().ToString("N"))
$restoreRoot = "$smokeRoot-restored"
try {
  foreach ($path in @($smokeRoot, $restoreRoot)) {
    foreach ($folder in @("data", "data\artifacts", "backups", "runtime")) { New-Item -ItemType Directory -Force -Path (Join-Path $path $folder) | Out-Null }
  }
  & $node -e "const {DatabaseSync}=require('node:sqlite'); for (const p of process.argv.slice(1)) { const db=new DatabaseSync(p); db.exec('CREATE TABLE smoke(id INTEGER PRIMARY KEY); INSERT INTO smoke DEFAULT VALUES'); db.close(); }" (Join-Path $smokeRoot "data\platform.sqlite") (Join-Path $smokeRoot "data\autoflow.sqlite")
  if ($LASTEXITCODE -ne 0) { throw "Unable to create smoke databases" }
  $artifactFixture = Join-Path $smokeRoot "data\artifacts\smoke.txt"
  Set-Content -LiteralPath $artifactFixture -Value "artifact" -Encoding ASCII
  if (-not (Test-Path -LiteralPath $artifactFixture)) { throw "Runtime artifact fixture missing" }
  $backupPath = Join-Path $smokeRoot "backups\smoke"
  & (Join-Path $scriptRoot "backup.ps1") -Root $smokeRoot -Destination $backupPath -PythonExe $python | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $backupPath "artifacts\smoke.txt"))) { throw "Backup smoke missing data\\artifacts fixture" }
  & (Join-Path $scriptRoot "restore.ps1") -Backup $backupPath -Root $restoreRoot
  foreach ($required in @("data\platform.sqlite", "data\autoflow.sqlite", "data\artifacts\smoke.txt")) {
    if (-not (Test-Path -LiteralPath (Join-Path $restoreRoot $required))) { throw "Restore smoke missing $required" }
  }
  Remove-Item -LiteralPath $artifactFixture -Force
  $emptyBackupPath = Join-Path $smokeRoot "backups\empty-artifacts"
  & (Join-Path $scriptRoot "backup.ps1") -Root $smokeRoot -Destination $emptyBackupPath -PythonExe $python | Out-Null
  & (Join-Path $scriptRoot "restore.ps1") -Backup $emptyBackupPath -Root $restoreRoot
  if (Test-Path -LiteralPath (Join-Path $restoreRoot "data\artifacts\smoke.txt")) { throw "Empty artifact restore retained a stale artifact" }
  & $python (Join-Path $scriptRoot "sqlite-backup.py") (Join-Path $restoreRoot "data\platform.sqlite") (Join-Path $restoreRoot "data\verified.sqlite")
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $restoreRoot "data\verified.sqlite"))) { throw "Restored SQLite verification failed" }
  & (Join-Path $scriptRoot "retention.ps1") -Root $restoreRoot -ArtifactDays 30 -MinimumFreeGB 0
  Write-Output "Windows deployment script smoke test passed"
} finally {
  foreach ($path in @($smokeRoot, $restoreRoot)) {
    $resolved = [IO.Path]::GetFullPath($path)
    if ($resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith("autoflow-windows-smoke-")) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
