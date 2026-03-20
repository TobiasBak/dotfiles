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
    "Google.Chrome",
    "Docker.DockerDesktop",
    "Microsoft.VisualStudioCode",
    "Microsoft.PowerShell",
    "Microsoft.PowerToys",
    "Discord.Discord",
    "OpenJS.NodeJS.LTS"
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

Write-Host "Application installation complete." -ForegroundColor Green
