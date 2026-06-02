# Windows Application Installation Script
# This script installs essential tools using winget.

Write-Host "Starting application installation via winget..." -ForegroundColor Cyan

# Ensure script is running as Administrator
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script MUST be run as Administrator. Please restart your PowerShell session as Administrator."
    exit 1
}

$apps = @(
    "Git.Git",
    "GitHub.GitHubDesktop",
    "Microsoft.VisualStudioCode",
    "Microsoft.PowerShell"
)

foreach ($app in $apps) {
    Write-Host "Installing $app..." -ForegroundColor Yellow
    winget install --id $app --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Successfully installed $app." -ForegroundColor Green
    } else {
        Write-Warning "Failed to install $app or it is already installed."
    }
}

if (Get-Command pi -ErrorAction SilentlyContinue) {
    Write-Host "Pi coding agent already installed. Skipping npm install." -ForegroundColor Cyan
} else {
    Write-Host "Installing Pi coding agent via npm..." -ForegroundColor Yellow
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        npm install -g @earendil-works/pi-coding-agent
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Successfully installed Pi coding agent." -ForegroundColor Green
        } else {
            Write-Warning "Failed to install Pi coding agent via npm."
        }
    } else {
        Write-Warning "npm not found. Install Node.js/npm before running this setup if Pi should be installed automatically."
    }
}

Write-Host "Application installation complete." -ForegroundColor Green
