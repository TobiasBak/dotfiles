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

# 2. Symlink Claude Code configuration (from agent_files/ to ~/.claude/)
$agentFilesPath = Join-Path $PSScriptRoot "..\..\agent_files"
$agentFilesPath = (Resolve-Path $agentFilesPath).Path
$claudeDir = "$env:USERPROFILE\.claude"

Write-Host "Setting up Claude Code symlinks..." -ForegroundColor Yellow

# Create .claude directory if it doesn't exist
if (-not (Test-Path $claudeDir)) {
    New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
}

# Helper function to create symlink
function New-ClaudeSymlink {
    param (
        [string]$SourceName,
        [string]$IsFile = $false
    )

    $source = Join-Path $agentFilesPath $SourceName
    $target = Join-Path $claudeDir $SourceName

    if (-not (Test-Path $source)) {
        Write-Warning "Source not found: $source"
        return
    }

    # Remove existing item if it exists
    if (Test-Path $target) {
        Remove-Item -Path $target -Recurse -Force
    }

    # Create symlink (requires admin)
    if ($IsFile) {
        New-Item -ItemType SymbolicLink -Path $target -Target $source -Force | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $target -Target $source -Force | Out-Null
    }
    Write-Host "Linked: $source -> $target" -ForegroundColor Green
}

# Create symlinks for skills, agents, hooks, and settings.json
New-ClaudeSymlink -SourceName "skills"
New-ClaudeSymlink -SourceName "agents"
New-ClaudeSymlink -SourceName "hooks"
New-ClaudeSymlink -SourceName "settings.json" -IsFile $true

Write-Host "Post-setup complete." -ForegroundColor Green
