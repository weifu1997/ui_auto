param([string]$Root = "D:\AutoFlow", [Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = "Stop"
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$service = Join-Path $Root "AutoFlow.exe"; & $service stop
& (Join-Path $PSScriptRoot "backup.ps1") -Root $Root | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"; $current = Join-Path $Root "app"; $previous = Join-Path $Root ("app-previous-" + $stamp)
Move-Item -LiteralPath $current -Destination $previous
New-Item -ItemType Directory -Path $current | Out-Null
Expand-Archive -LiteralPath $packagePath -DestinationPath $current -Force
Push-Location $current; npm ci; npm run build; Pop-Location
try { & $service start; Start-Sleep -Seconds 3; Invoke-RestMethod -Uri "http://127.0.0.1:8787/ready" | Out-Null }
catch { & $service stop; Remove-Item -LiteralPath $current -Recurse -Force; Move-Item -LiteralPath $previous -Destination $current; & $service start; Write-Host "Upgrade failed and the previous version was restored."; Write-Host "If the database is inconsistent, restore the pre-upgrade backup manually: scripts\restore.ps1 -Backup <升级前 backups 目录>"; throw "Upgrade failed and previous version was restored" }
