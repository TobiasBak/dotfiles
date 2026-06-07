# Windows Setup Script
# This script bootstraps winget configure, applies the Windows configuration,
# and runs dotfiles post-setup. The winget config may reboot for WSL; post-setup
# is registered in RunOnce before configure starts so it still runs after login.

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

function Invoke-SetupScript {
    param([Parameter(Mandatory=$true)][string]$RelativePath)

    $scriptPath = Join-Path $PSScriptRoot $RelativePath
    if (Test-Path $scriptPath) {
        Write-Host "`n--- Executing $RelativePath ---" -ForegroundColor Blue
        & $scriptPath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "$RelativePath exited with code $LASTEXITCODE"
        }
    } else {
        Write-Warning "Could not find $scriptPath, skipping..."
    }
}

$postSetupPath = Join-Path $PSScriptRoot "scripts\post-setup.ps1"
$postSetupElevatedPath = Join-Path $PSScriptRoot "scripts\run-post-setup-elevated.ps1"
if ((Test-Path $postSetupPath) -and (Test-Path $postSetupElevatedPath)) {
    $runOncePath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce"
    New-Item -Path $runOncePath -Force | Out-Null
    $postSetupCmd = "powershell.exe -ExecutionPolicy Bypass -File `"$postSetupElevatedPath`""
    Set-ItemProperty -Path $runOncePath -Name "DotfilesPostSetup" -Value $postSetupCmd -Force
    Write-Host "Registered post-setup RunOnce for reboot-safe setup." -ForegroundColor Green
}

Invoke-SetupScript "scripts\enable-winget-configure.ps1"
Invoke-SetupScript "scripts\install-apps.ps1"
Invoke-SetupScript "scripts\set-aliases.ps1"
Invoke-SetupScript "scripts\post-setup.ps1"

# If we reached here, no reboot interrupted the setup. Remove stale RunOnce.
try {
    Remove-ItemProperty -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce" -Name "DotfilesPostSetup" -ErrorAction SilentlyContinue
} catch { }

Write-Host "`nAll automated setup tasks completed successfully!" -ForegroundColor Green
