param([string]$Root = "D:\AutoFlow", [string]$Destination = "", [string]$PythonExe = "")
$ErrorActionPreference = "Stop"
$data = Join-Path $Root "data"
if (-not $Destination) { $Destination = Join-Path $Root ("backups\" + (Get-Date -Format "yyyyMMdd-HHmmss")) }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { Join-Path $Root "app\venv\Scripts\python.exe" }
$scriptRoot = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$script = Join-Path $scriptRoot "sqlite-backup.py"
& $python $script (Join-Path $data "platform.sqlite") (Join-Path $Destination "platform.sqlite")
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed: platform.sqlite" }
& $python $script (Join-Path $data "autoflow.sqlite") (Join-Path $Destination "autoflow.sqlite")
if ($LASTEXITCODE -ne 0) { throw "SQLite backup failed: autoflow.sqlite" }
$artifactSource = Join-Path $data "artifacts"
if (Test-Path -LiteralPath $artifactSource) { Copy-Item -LiteralPath $artifactSource -Destination (Join-Path $Destination "artifacts") -Recurse -Force }
Set-Content -LiteralPath (Join-Path $Destination "backup.json") -Encoding UTF8 -Value (@{ createdAt=(Get-Date).ToString("o"); source=$Root } | ConvertTo-Json)
Write-Output $Destination
