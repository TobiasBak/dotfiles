# Post-setup script for final configurations

Write-Host "Running post-setup configurations..." -ForegroundColor Cyan

# 1. Set PowerShell 7 as the default profile in Windows Terminal (if installed)
$wtSettingsPath = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if (-not (Test-Path $wtSettingsPath)) {
    $wtSettingsPath = "$env:LOCALAPPDATA\Microsoft\WindowsTerminal\settings.json"
}

if (Test-Path $wtSettingsPath) {
    Write-Host "Configuring Windows Terminal to use PowerShell 7 as default..." -ForegroundColor Yellow
    try {
        $settings = Get-Content $wtSettingsPath -Raw | ConvertFrom-Json
        
        # Find the PowerShell 7 profile GUID or Name
        $pwshProfile = $settings.profiles.list | Where-Object { $_.name -eq "PowerShell" -or $_.commandline -like "*pwsh.exe*" }
        
        if ($pwshProfile) {
            $settings.defaultProfile = $pwshProfile.guid
            $settings | ConvertTo-Json -Depth 10 | Set-Content $wtSettingsPath
            Write-Host "Successfully set PowerShell 7 as the default profile in Windows Terminal." -ForegroundColor Green
        } else {
            Write-Warning "Could not find a PowerShell 7 profile in Windows Terminal settings."
        }
    } catch {
        Write-Warning "Failed to update Windows Terminal settings: $_"
    }
} else {
    Write-Host "Windows Terminal settings not found. Skipping default profile configuration." -ForegroundColor Gray
}

# Add more post-setup tasks here as needed

Write-Host "Post-setup complete." -ForegroundColor Green
