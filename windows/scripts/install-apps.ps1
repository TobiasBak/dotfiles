# Windows Application/Configuration Installation Script
# Applies the repo-owned winget configure DSC file.

$ErrorActionPreference = "Stop"

Write-Host "Applying Windows configuration via winget configure..." -ForegroundColor Cyan

# Ensure script is running as Administrator.
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script MUST be run as Administrator. Please restart your PowerShell session as Administrator."
    exit 1
}

$configPath = (Resolve-Path (Join-Path $PSScriptRoot "..\configuration.winget")).Path

winget configure -f $configPath `
    --accept-configuration-agreements `
    --disable-interactivity

if ($LASTEXITCODE -eq 0) {
    Write-Host "Windows configuration applied successfully." -ForegroundColor Green
} else {
    throw "winget configure exited with code $LASTEXITCODE. If WSL triggered a reboot, setup should resume after next login."
}

Write-Host "Winget configuration complete." -ForegroundColor Green
