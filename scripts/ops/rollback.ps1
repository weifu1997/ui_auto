param([string]$Root = "D:\AutoFlow")
$ErrorActionPreference = "Stop"
$previous = Get-ChildItem -LiteralPath $Root -Directory -Filter "app-previous-*" | Sort-Object Name -Descending | Select-Object -First 1
if (-not $previous) { throw "No previous AutoFlow version found" }
$service = Join-Path $Root "AutoFlow.exe"; & $service stop
$failed = Join-Path $Root ("app-failed-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
Move-Item -LiteralPath (Join-Path $Root "app") -Destination $failed
Move-Item -LiteralPath $previous.FullName -Destination (Join-Path $Root "app")
& $service start
