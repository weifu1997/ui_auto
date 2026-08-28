[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$Root = "D:\AutoFlow", [Parameter(Mandatory=$true)][string]$Package, [string]$PythonExe = "")
$ErrorActionPreference = "Stop"
if (-not $PSCmdlet.ShouldProcess($Root, "Upgrade AutoFlow")) { return }
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$service = Join-Path $Root "AutoFlow.exe"
if (Test-Path -LiteralPath $service) {
  & $service stop
  if ($LASTEXITCODE -ne 0) { throw "AutoFlow service stop failed with exit code $LASTEXITCODE" }
}
& (Join-Path $PSScriptRoot "backup.ps1") -Root $Root | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$current = Join-Path $Root "app"
$previous = Join-Path $Root ("app-previous-" + $stamp)
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { "python" }
$previousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
$moved = $false
try {
  Move-Item -LiteralPath $current -Destination $previous
  $moved = $true
  New-Item -ItemType Directory -Path $current | Out-Null
  Expand-Archive -LiteralPath $packagePath -DestinationPath $current -Force
  Push-Location $current
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
  Pop-Location
  & $python -m pip install --upgrade uv
  if ($LASTEXITCODE -ne 0) { throw "pip install uv failed with exit code $LASTEXITCODE" }
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Root "browsers"
  $env:UV_PROJECT_ENVIRONMENT = Join-Path $current "venv"
  Push-Location (Join-Path $current "server-py")
  & $python -m uv sync --no-dev --locked --python $python
  if ($LASTEXITCODE -ne 0) { throw "uv sync failed with exit code $LASTEXITCODE" }
  & $python -m uv run --no-dev --frozen python -m playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "python playwright install failed with exit code $LASTEXITCODE" }
  Pop-Location
  if (Test-Path -LiteralPath $service) {
    & $service start
    if ($LASTEXITCODE -ne 0) { throw "AutoFlow service start failed with exit code $LASTEXITCODE" }
  }
  Start-Sleep -Seconds 3
  Invoke-RestMethod -Uri "http://127.0.0.1:8787/ready" | Out-Null
}
catch {
  if (Test-Path -LiteralPath $service) { & $service stop }
  if (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current -Recurse -Force }
  if ($moved -and (Test-Path -LiteralPath $previous)) { Move-Item -LiteralPath $previous -Destination $current }
  if (Test-Path -LiteralPath $service) { & $service start }
  Write-Host "Upgrade failed and the previous version was restored."
  Write-Host "If the database is inconsistent, restore the pre-upgrade backup manually: scripts\restore.ps1 -Backup <backup-directory>."
  throw "Upgrade failed and previous version was restored"
}
finally {
  $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserPath
  Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue
}
