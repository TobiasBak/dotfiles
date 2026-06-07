# Enable and verify winget configure support.

[CmdletBinding()]
param(
    [switch]$SkipVCRedist
)

$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    throw 'This script MUST be run as Administrator.'
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget not found. Install/update App Installer from Microsoft Store, then rerun setup.'
}

Write-Host 'Enabling winget configure...' -ForegroundColor Yellow
& winget configure --enable
if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget configure --enable exited $LASTEXITCODE. Continuing; it may already be enabled."
}

if (-not $SkipVCRedist) {
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { 'arm64' } else { 'x64' }
    $vcRedistId = "Microsoft.VCRedist.2015+.$arch"

    Write-Host "Ensuring $vcRedistId is installed..." -ForegroundColor Yellow
    & winget install --source winget --id $vcRedistId --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$vcRedistId install exited $LASTEXITCODE. Continuing; it may already be installed."
    }
}

Write-Host 'Verifying winget configure...' -ForegroundColor Yellow
$help = & winget configure --help 2>&1
if ($LASTEXITCODE -ne 0 -or (($help -join "`n") -notmatch '(?i)configuration|configure')) {
    throw "winget configure unavailable after enable. Output:`n$($help -join [Environment]::NewLine)"
}

Write-Host 'winget configure ready.' -ForegroundColor Green
