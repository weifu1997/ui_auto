param([string]$Root = "D:\AutoFlow", [string]$Destination = "", [string]$NodeExe = "")
$ErrorActionPreference = "Stop"
$data = Join-Path $Root "data"
if (-not $Destination) { $Destination = Join-Path $Root ("backups\" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$node = if ($NodeExe) { (Resolve-Path -LiteralPath $NodeExe).Path } else { Join-Path $Root "runtime\node.exe" }
$script = Join-Path $PSScriptRoot "sqlite-backup.mjs"
& $node $script (Join-Path $data "platform.sqlite") (Join-Path $Destination "platform.sqlite")
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed: platform.sqlite" }
& $node $script (Join-Path $data "autoflow.sqlite") (Join-Path $Destination "autoflow.sqlite")
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed: autoflow.sqlite" }
if (Test-Path -LiteralPath (Join-Path $Root "artifacts")) { Copy-Item -LiteralPath (Join-Path $Root "artifacts") -Destination (Join-Path $Destination "artifacts") -Recurse -Force }
Set-Content -LiteralPath (Join-Path $Destination "backup.json") -Encoding UTF8 -Value (@{ createdAt=(Get-Date).ToString("o"); source=$Root } | ConvertTo-Json)
Write-Output $Destination
