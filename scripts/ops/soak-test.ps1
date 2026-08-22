param([string]$BaseUrl = "http://127.0.0.1:8787", [int]$Hours = 168, [int]$IntervalSeconds = 60, [string]$Log = "D:\AutoFlow\logs\soak-test.csv")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
"timestamp,ready,maintenanceHealthy,status,chromiumProcesses,freeGB,error" | Set-Content -LiteralPath $Log -Encoding UTF8
$deadline = (Get-Date).AddHours($Hours)
while ((Get-Date) -lt $deadline) {
  $ready = $false; $maintenanceHealthy = $false; $status = "request_error"; $errorText = ""
  try {
    $result = Invoke-RestMethod -Uri "$BaseUrl/ready" -TimeoutSec 10
    $ready = $result.ready -eq $true
    if ($null -ne $result.maintenance) { $maintenanceHealthy = $result.maintenance.healthy -eq $true }
    if ($ready -and $maintenanceHealthy) { $status = "normal" }
    elseif ($ready) { $status = "degraded" }
    else { $status = "not_ready" }
  } catch {
    $statusCode = $null
    if ($null -ne $_.Exception.Response) {
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    }
    if ($statusCode -eq 503) { $status = "not_ready"; $errorText = "READY_NOT_READY" }
    else { $errorText = "READY_REQUEST_FAILED" }
  }
  $chromium = @(Get-Process -Name "chrome","chromium" -ErrorAction SilentlyContinue).Count
  $driveName = [IO.Path]::GetPathRoot($Log).TrimEnd("\").TrimEnd(":")
  $free = [math]::Round((Get-PSDrive -Name $driveName).Free / 1GB, 2)
  "$(Get-Date -Format o),$ready,$maintenanceHealthy,$status,$chromium,$free,$errorText" | Add-Content -LiteralPath $Log -Encoding UTF8
  Start-Sleep -Seconds $IntervalSeconds
}
