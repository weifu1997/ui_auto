param([string]$Root = "D:\AutoFlow", [int]$ArtifactDays = 30, [int]$MinimumFreeGB = 10)
$ErrorActionPreference = "Stop"
$artifactRoot = (Resolve-Path -LiteralPath (Join-Path $Root "artifacts")).Path
$cutoff = (Get-Date).AddDays(-$ArtifactDays)
Get-ChildItem -LiteralPath $artifactRoot -File -Recurse | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($Root).TrimEnd("\").TrimEnd(":"))
if (($drive.Free / 1GB) -lt $MinimumFreeGB) { throw "AUTOFLOW_DISK_LOW" }
