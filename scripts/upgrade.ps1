param([string]$Root = "D:\AutoFlow", [Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = "Stop"
$packagePath = (Resolve-Path -LiteralPath $Package).Path
& (Join-Path $PSScriptRoot "backup.ps1") -Root $Root | Out-Null
$service = Join-Path $Root "AutoFlow.exe"; & $service stop
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"; $current = Join-Path $Root "app"; $previous = Join-Path $Root ("app-previous-" + $stamp)
Move-Item -LiteralPath $current -Destination $previous
New-Item -ItemType Directory -Path $current | Out-Null
Expand-Archive -LiteralPath $packagePath -DestinationPath $current -Force
Push-Location $current; npm ci; npm run build; Pop-Location
try { & $service start; Start-Sleep -Seconds 3; Invoke-RestMethod -Uri "http://127.0.0.1:8787/ready" | Out-Null }
catch { & $service stop; Remove-Item -LiteralPath $current -Recurse -Force; Move-Item -LiteralPath $previous -Destination $current; & $service start; throw "Upgrade failed and previous version was restored" }
