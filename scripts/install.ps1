param(
  [string]$Root = "D:\AutoFlow",
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$WinSWExe,
  [string]$PythonExe = "",
  [string]$PlatformSecretKey = "",
  [string]$NotificationHostAllowlist = "",
  [string]$CorsOrigins = ""
)
$ErrorActionPreference = "Stop"
if (-not $PlatformSecretKey) {
  $secureSecret = Read-Host -AsSecureString "请输入至少 32 字符的 PLATFORM_SECRET_KEY"
  $PlatformSecretKey = [System.Net.NetworkCredential]::new("", $secureSecret).Password
}
if ($PlatformSecretKey.Length -lt 32) { throw "PlatformSecretKey must contain at least 32 characters" }
$resolvedRoot = [IO.Path]::GetFullPath($Root)
foreach ($folder in @("app","data","logs","backups","browsers","runtime")) { New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot $folder) | Out-Null }
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot "data\artifacts") | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $resolvedRoot "runtime\node.exe") -Force
Copy-Item -LiteralPath $WinSWExe -Destination (Join-Path $resolvedRoot "AutoFlow.exe") -Force
$serviceConfig = Join-Path $resolvedRoot "AutoFlow.xml"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\deployment\AutoFlow.xml") -Destination $serviceConfig -Force
$escapedSecret = [Security.SecurityElement]::Escape($PlatformSecretKey)
$escapedAllowlist = [Security.SecurityElement]::Escape($NotificationHostAllowlist)
$allowPrivate = if ($NotificationHostAllowlist) { "1" } else { "0" }
$escapedCors = [Security.SecurityElement]::Escape($CorsOrigins)
$config = (Get-Content -Raw -LiteralPath $serviceConfig).Replace("__PLATFORM_SECRET_KEY__", $escapedSecret).Replace("__AUTOFLOW_CORS_ORIGINS__", $escapedCors).Replace("__NOTIFICATION_HOST_ALLOWLIST__", $escapedAllowlist).Replace("__ALLOW_PRIVATE_NOTIFICATION_URLS__", $allowPrivate)
Set-Content -LiteralPath $serviceConfig -Value $config -Encoding UTF8
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$appRoot = Join-Path $resolvedRoot "app"
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { "python" }
& robocopy $sourceRoot $appRoot /E /XD (Join-Path $sourceRoot "node_modules") (Join-Path $sourceRoot ".git") (Join-Path $sourceRoot "server\.data") (Join-Path $sourceRoot "server\.artifacts") (Join-Path $sourceRoot "server\.platform-artifacts") (Join-Path $sourceRoot "server\.tmp-platform-debug") /XF "*.sqlite" "*.sqlite-wal" "*.sqlite-shm" "*.zip" /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Application file copy failed with robocopy exit code $LASTEXITCODE" }
$previousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $resolvedRoot "browsers"
try { Push-Location $appRoot; npm ci; npm run build; npx playwright install chromium; Pop-Location }
finally { $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserPath }
& $python -m venv (Join-Path $appRoot "venv")
& (Join-Path $appRoot "venv\Scripts\python.exe") -m pip install -r (Join-Path $appRoot "server-py\requirements.txt")
Push-Location (Join-Path $appRoot "server-py")
& (Join-Path $appRoot "venv\Scripts\python.exe") -m playwright install chromium
Pop-Location
& (Join-Path $resolvedRoot "AutoFlow.exe") install
& (Join-Path $resolvedRoot "AutoFlow.exe") start
