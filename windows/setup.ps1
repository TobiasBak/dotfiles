# Windows Setup Script
# This script orchestrates the Windows environment setup.

Write-Host "Starting Windows dotfiles setup..." -ForegroundColor Cyan

# Check for Administrative privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script MUST be run as Administrator. Please restart your PowerShell session as Administrator."
    exit 1
}

# Set execution policy to Bypass for current user (persists across sessions)
Write-Host "Setting PowerShell execution policy to Bypass for current user..." -ForegroundColor Yellow
Set-ExecutionPolicy Bypass -Scope CurrentUser -Force
Write-Host "Execution policy set." -ForegroundColor Green

# Define scripts to run in order
$scripts = @(
    "scripts\install-apps.ps1",
    "scripts\set-aliases.ps1",
    "scripts\post-setup.ps1"
)

foreach ($scriptName in $scripts) {
    $scriptPath = Join-Path $PSScriptRoot $scriptName
    if (Test-Path $scriptPath) {
        Write-Host "`n--- Executing $scriptName ---" -ForegroundColor Blue
        & $scriptPath
    } else {
        Write-Warning "Could not find $scriptPath, skipping..."
    }
}

Write-Host "`nAll automated setup tasks completed successfully!" -ForegroundColor Green

Write-Host "`nLaunching Chris Titus Tech Windows Utility for manual tweaks..." -ForegroundColor Cyan
irm "https://christitus.com/win" | iex
