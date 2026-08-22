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
  $secureSecret = Read-Host -AsSecureString "Enter a PLATFORM_SECRET_KEY with at least 32 characters"
  $PlatformSecretKey = [System.Net.NetworkCredential]::new("", $secureSecret).Password
}
if ($PlatformSecretKey.Length -lt 32) { throw "PlatformSecretKey must contain at least 32 characters" }
$resolvedRoot = [IO.Path]::GetFullPath($Root)
foreach ($folder in @("app","data","logs","backups","browsers","runtime")) { New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot $folder) | Out-Null }
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot "data\artifacts") | Out-Null
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $resolvedRoot "runtime\node.exe") -Force
Copy-Item -LiteralPath $WinSWExe -Destination (Join-Path $resolvedRoot "AutoFlow.exe") -Force
$serviceConfig = Join-Path $resolvedRoot "AutoFlow.xml"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\..\deployment\AutoFlow.xml") -Destination $serviceConfig -Force
$keyFile = Join-Path $resolvedRoot "runtime\platform-secret.key"
Set-Content -LiteralPath $keyFile -Value $PlatformSecretKey -Encoding UTF8 -NoNewline
$acl = Get-Acl -LiteralPath $keyFile
$acl.SetAccessRuleProtection($true, $false)
$adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule("BUILTIN\Administrators", "FullControl", "Allow")
$systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")
$acl.AddAccessRule($adminRule)
$acl.AddAccessRule($systemRule)
Set-Acl -LiteralPath $keyFile -AclObject $acl
$escapedAllowlist = [Security.SecurityElement]::Escape($NotificationHostAllowlist)
$allowPrivate = if ($NotificationHostAllowlist) { "1" } else { "0" }
$escapedCors = [Security.SecurityElement]::Escape($CorsOrigins)
$config = (Get-Content -Raw -LiteralPath $serviceConfig).Replace("__AUTOFLOW_CORS_ORIGINS__", $escapedCors).Replace("__NOTIFICATION_HOST_ALLOWLIST__", $escapedAllowlist).Replace("__ALLOW_PRIVATE_NOTIFICATION_URLS__", $allowPrivate)
Set-Content -LiteralPath $serviceConfig -Value $config -Encoding UTF8
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$appRoot = Join-Path $resolvedRoot "app"
$python = if ($PythonExe) { (Resolve-Path -LiteralPath $PythonExe).Path } else { "python" }
& robocopy $sourceRoot $appRoot /E /XD (Join-Path $sourceRoot "node_modules") (Join-Path $sourceRoot ".git") (Join-Path $sourceRoot "data") /XF "*.sqlite" "*.sqlite-wal" "*.sqlite-shm" "*.zip" /NFL /NDL /NJH /NJS | Out-Null
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
