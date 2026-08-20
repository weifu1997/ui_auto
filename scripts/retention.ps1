param([string]$Root = "D:\AutoFlow", [int]$ArtifactDays = 30, [int]$MinimumFreeGB = 10, [int]$BackupKeep = 14)
$ErrorActionPreference = "Stop"
$artifactRoot = (Resolve-Path -LiteralPath (Join-Path $Root "data\artifacts")).Path
$cutoff = (Get-Date).AddDays(-$ArtifactDays)
Get-ChildItem -LiteralPath $artifactRoot -File -Recurse | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force
$backupRoot = Join-Path $Root "backups"
if (Test-Path -LiteralPath $backupRoot) {
  Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip $BackupKeep | Remove-Item -Recurse -Force
}
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($Root).TrimEnd("\").TrimEnd(":"))
if (($drive.Free / 1GB) -lt $MinimumFreeGB) { throw "AUTOFLOW_DISK_LOW" }
