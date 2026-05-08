# Post-setup script for final configurations

Write-Host "Running post-setup configurations..." -ForegroundColor Cyan

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ConfigsDir = Join-Path $RepoRoot "configs"
$BackupDir = Join-Path $HOME ("dotfiles_backup_" + (Get-Date -Format "yyyyMMdd_HHmmss"))

function Link-DotfileConfig {
    param(
        [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][string]$Target
    )

    $Source = (Resolve-Path $Source).Path
    $TargetParent = Split-Path $Target -Parent
    New-Item -ItemType Directory -Force -Path $TargetParent | Out-Null

    if (Test-Path $Target) {
        $item = Get-Item $Target -Force
        if ($item.LinkType -and $item.Target -eq $Source) {
            Write-Host "Already linked: $Target" -ForegroundColor Cyan
            return
        }

        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        Move-Item -Path $Target -Destination $BackupDir -Force
        Write-Warning "Backed up existing $Target to $BackupDir"
    }

    New-Item -ItemType SymbolicLink -Path $Target -Target $Source | Out-Null
    Write-Host "Linked $Source -> $Target" -ForegroundColor Green
}

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

# 2. Link shared program configs
Write-Host "Linking shared program configs..." -ForegroundColor Yellow

$vsCodeSettingsSource = Join-Path $ConfigsDir "Code\User\settings.json"
$vsCodeSettingsTarget = Join-Path $env:APPDATA "Code\User\settings.json"
if (Test-Path $vsCodeSettingsSource) {
    Link-DotfileConfig $vsCodeSettingsSource $vsCodeSettingsTarget
}

$discordSettingsSource = Join-Path $ConfigsDir "discord\settings.json"
$discordSettingsTarget = Join-Path $env:APPDATA "discord\settings.json"
if (Test-Path $discordSettingsSource) {
    Link-DotfileConfig $discordSettingsSource $discordSettingsTarget
}

$piSettingsSource = Join-Path $ConfigsDir "pi\settings.json"
$piSettingsTarget = Join-Path $HOME ".pi\agent\settings.json"
if (Test-Path $piSettingsSource) {
    Link-DotfileConfig $piSettingsSource $piSettingsTarget
}

$piAppendSystemSource = Join-Path $ConfigsDir "pi\APPEND_SYSTEM.md"
$piAppendSystemTarget = Join-Path $HOME ".pi\agent\APPEND_SYSTEM.md"
if (Test-Path $piAppendSystemSource) {
    Link-DotfileConfig $piAppendSystemSource $piAppendSystemTarget
}

$piExtensionsSource = Join-Path $ConfigsDir "pi\extensions"
$piExtensionsTarget = Join-Path $HOME ".pi\agent\extensions"
if (Test-Path $piExtensionsSource) {
    Link-DotfileConfig $piExtensionsSource $piExtensionsTarget
}

$piPromptsSource = Join-Path $ConfigsDir "pi\prompts"
$piPromptsTarget = Join-Path $HOME ".pi\agent\prompts"
if (Test-Path $piPromptsSource) {
    Link-DotfileConfig $piPromptsSource $piPromptsTarget
}

# 3. Install Pi skills from private skills repo
$piSkillsRepo = "https://github.com/TobiasBak/skills.git"
$piSkillsDir = "C:\apps\skills"
$piSkillsTarget = Join-Path $HOME ".pi\agent\skills"

Write-Host "Installing Pi skills from $piSkillsRepo..." -ForegroundColor Yellow
if (Test-Path $piSkillsDir) {
    git -C $piSkillsDir pull --ff-only
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $piSkillsDir -Parent) | Out-Null
    git clone $piSkillsRepo $piSkillsDir
}

if (Test-Path $piSkillsTarget) {
    Remove-Item -Recurse -Force $piSkillsTarget
}
$env:PI_SKILLS_DIR = $piSkillsTarget
& (Join-Path $piSkillsDir "scripts\install-links.ps1")

Write-Host "`nPost-setup complete." -ForegroundColor Green
