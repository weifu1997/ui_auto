param([string]$BaseUrl = "http://127.0.0.1:8787", [int]$Hours = 168, [int]$IntervalSeconds = 60, [string]$Log = "D:\AutoFlow\logs\soak-test.csv")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
"timestamp,ready,chromiumProcesses,freeGB,error" | Set-Content -LiteralPath $Log -Encoding UTF8
$deadline = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $deadline) {
  $ready = $false; $errorText = ""
  try { $result = Invoke-RestMethod -Uri "$BaseUrl/ready" -TimeoutSec 10; $ready = $result.ok -eq $true } catch { $errorText = $_.Exception.Message.Replace(",",";") }
  $chromium = @(Get-Process -Name "chrome","chromium" -ErrorAction SilentlyContinue).Count
  $driveName = [IO.Path]::GetPathRoot($Log).TrimEnd("\").TrimEnd(":")
  $free = [math]::Round((Get-PSDrive -Name $driveName).Free / 1GB, 2)
  "$(Get-Date -Format o),$ready,$chromium,$free,$errorText" | Add-Content -LiteralPath $Log -Encoding UTF8
  Start-Sleep -Seconds $IntervalSeconds
}
