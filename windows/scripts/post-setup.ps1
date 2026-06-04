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

function Set-RegistryDword {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][int]$Value
    )

    if (-not (Test-Path $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }

    New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}

# 1. Disable web and cloud content in Windows Search
Write-Host "Disabling web and cloud content in Windows Search..." -ForegroundColor Yellow
Set-RegistryDword -Path "HKCU:\Software\Policies\Microsoft\Windows\Explorer" -Name "DisableSearchBoxSuggestions" -Value 1
Set-RegistryDword -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\SearchSettings" -Name "IsMSACloudSearchEnabled" -Value 0
Set-RegistryDword -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\SearchSettings" -Name "IsAADCloudSearchEnabled" -Value 0
Set-RegistryDword -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\SearchSettings" -Name "IsDynamicSearchBoxEnabled" -Value 0
Write-Host "Windows Search web results, cloud content search, and search highlights are disabled for the current user." -ForegroundColor Green

# 2. Set PowerShell 7 as the default profile in Windows Terminal (if installed)
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
            Write-Host "Successfully set PowerShell 7 as the default profile in Windows Terminal." -ForegroundColor Green
        } else {
            Write-Warning "Could not find a PowerShell 7 profile in Windows Terminal settings."
        }

        $shiftEnterInput = [string]([char]27) + "[13;2u"
        $shiftEnterBinding = [ordered]@{
            command = [ordered]@{
                action = "sendInput"
                input = $shiftEnterInput
            }
            keys = "shift+enter"
        }

        if (-not ($settings.PSObject.Properties.Name -contains "keybindings") -or $null -eq $settings.keybindings) {
            $settings | Add-Member -NotePropertyName "keybindings" -NotePropertyValue @()
        }

        $settings.keybindings = @($shiftEnterBinding) + @($settings.keybindings | Where-Object { $_.keys -ne "shift+enter" })
        Write-Host "Configured Shift+Enter to send Kitty CSI-u newline sequence for Pi." -ForegroundColor Green

        $settings | ConvertTo-Json -Depth 10 | Set-Content $wtSettingsPath
    } catch {
        Write-Warning "Failed to update Windows Terminal settings: $_"
    }
} else {
    Write-Host "Windows Terminal settings not found. Skipping default profile configuration." -ForegroundColor Gray
}

# 3. Link shared program configs
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

$piKeybindingsSource = Join-Path $ConfigsDir "pi\keybindings.json"
$piKeybindingsTarget = Join-Path $HOME ".pi\agent\keybindings.json"
if (Test-Path $piKeybindingsSource) {
    Link-DotfileConfig $piKeybindingsSource $piKeybindingsTarget
}

$codexConfigSource = Join-Path $ConfigsDir "codex\config.toml"
$codexConfigTarget = Join-Path $HOME ".codex\config.toml"
if (Test-Path $codexConfigSource) {
    Link-DotfileConfig $codexConfigSource $codexConfigTarget
}

$codexPromptsSource = Join-Path $ConfigsDir "codex\prompts"
$codexPromptsTarget = Join-Path $HOME ".codex\prompts"
if (Test-Path $codexPromptsSource) {
    Link-DotfileConfig $codexPromptsSource $codexPromptsTarget
}

# 4. Install Pi skills from private skills repo
$piSkillsRepo = "https://github.com/TobiasBak/skills.git"
$piSkillsDir = Join-Path (Split-Path $RepoRoot -Parent) "skills"
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
