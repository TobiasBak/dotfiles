$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$SkillsInstaller = "C:\code\skills\scripts\install-links.ps1"
if (!(Test-Path -LiteralPath $SkillsInstaller)) {
    throw "Missing skills installer: $SkillsInstaller"
}

Write-Host "Installing/fixing skill links..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $SkillsInstaller -Fix

Write-Host "Verifying Pi config + skills..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "windows/scripts/verify-links.ps1")

Write-Host "Agent env synced. Restart Pi if running."
