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

# 2. Set PowerShell 7 as the default profile in Windows Terminal-compatible hosts
$wtSettingsPaths = @(
    "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json",
    "$env:LOCALAPPDATA\Microsoft\WindowsTerminal\settings.json",
    "$env:LOCALAPPDATA\Packages\Microsoft.IntelligentTerminal_8wekyb3d8bbwe\LocalState\settings.json"
) | Select-Object -Unique | Where-Object { Test-Path $_ }

if ($wtSettingsPaths.Count -gt 0) {
    foreach ($wtSettingsPath in $wtSettingsPaths) {
        Write-Host "Configuring terminal settings at $wtSettingsPath..." -ForegroundColor Yellow
        try {
            $settings = Get-Content $wtSettingsPath -Raw | ConvertFrom-Json

            if (-not ($settings.PSObject.Properties.Name -contains "profiles") -or $null -eq $settings.profiles) {
                $settings | Add-Member -NotePropertyName "profiles" -NotePropertyValue ([ordered]@{})
            }
            if (-not ($settings.profiles.PSObject.Properties.Name -contains "defaults") -or $null -eq $settings.profiles.defaults) {
                $settings.profiles | Add-Member -NotePropertyName "defaults" -NotePropertyValue ([ordered]@{})
            }
            if (-not ($settings.profiles.defaults.PSObject.Properties.Name -contains "font") -or $null -eq $settings.profiles.defaults.font) {
                $settings.profiles.defaults | Add-Member -NotePropertyName "font" -NotePropertyValue ([ordered]@{})
            }
            if ($settings.profiles.defaults.font.PSObject.Properties.Name -contains "face") {
                $settings.profiles.defaults.font.face = "JetBrainsMono Nerd Font"
            } else {
                $settings.profiles.defaults.font | Add-Member -NotePropertyName "face" -NotePropertyValue "JetBrainsMono Nerd Font"
            }
            Write-Host "Configured Windows Terminal to use JetBrainsMono Nerd Font by default." -ForegroundColor Green

            # Find the PowerShell 7 profile GUID or Name
            $pwshProfile = $null
            if ($settings.profiles.PSObject.Properties.Name -contains "list" -and $null -ne $settings.profiles.list) {
                $pwshProfile = @($settings.profiles.list | Where-Object { $_.name -eq "PowerShell" -or $_.commandline -like "*pwsh.exe*" }) | Select-Object -First 1
            }

            if ($pwshProfile -and $pwshProfile.guid) {
                if ($settings.PSObject.Properties.Name -contains "defaultProfile") {
                    $settings.defaultProfile = $pwshProfile.guid
                } else {
                    $settings | Add-Member -NotePropertyName "defaultProfile" -NotePropertyValue $pwshProfile.guid
                }
                Write-Host "Successfully set PowerShell 7 as the default profile in Windows Terminal." -ForegroundColor Green
            } else {
                Write-Warning "Could not find a PowerShell 7 profile in Windows Terminal settings."
            }

            $shiftEnterInput = [string]([char]27) + "[13;2u"
            $legacyActionIds = @()

            if ($settings.PSObject.Properties.Name -contains "actions" -and $null -ne $settings.actions) {
                $legacyActions = @($settings.actions | Where-Object {
                    $null -ne $_.command -and $_.command.action -eq "sendInput" -and $_.command.input -eq $shiftEnterInput
                })
                $legacyActionIds = @($legacyActions | ForEach-Object { $_.id } | Where-Object { $_ })
                $settings.actions = @($settings.actions | Where-Object {
                    -not ($null -ne $_.command -and $_.command.action -eq "sendInput" -and $_.command.input -eq $shiftEnterInput)
                })
            }

            if ($settings.PSObject.Properties.Name -contains "keybindings" -and $null -ne $settings.keybindings) {
                $settings.keybindings = @($settings.keybindings | Where-Object {
                    $keys = [string]$_.keys
                    $isShiftEnter = $keys.Equals("shift+enter", [System.StringComparison]::OrdinalIgnoreCase)
                    $isLegacyCommand = $null -ne $_.command -and $_.command.action -eq "sendInput" -and $_.command.input -eq $shiftEnterInput
                    $isLegacyActionId = $_.id -and $legacyActionIds -contains $_.id
                    -not ($isShiftEnter -and ($isLegacyCommand -or $isLegacyActionId))
                })
            }

            Write-Host "Removed legacy Shift+Enter raw input binding; PSReadLine and app keymaps handle new lines." -ForegroundColor Green

            $settings | ConvertTo-Json -Depth 10 | Set-Content $wtSettingsPath
        } catch {
            Write-Warning "Failed to update Windows Terminal settings: $_"
        }
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

# 4. Install agent skills from private skills repo
$skillsRepo = "https://github.com/TobiasBak/skills.git"
$skillsDir = Join-Path (Split-Path $RepoRoot -Parent) "skills"
$skillsInstaller = Join-Path $skillsDir "scripts\install-links.ps1"

function Install-AgentSkillLinks {
    param(
        [Parameter(Mandatory=$true)][string]$TargetDir,
        [Parameter(Mandatory=$true)][string]$DisplayName
    )

    if (-not (Test-Path -LiteralPath $skillsInstaller)) {
        Write-Warning "Skills installer not found: $skillsInstaller"
        return
    }

    Write-Host "Installing $DisplayName skills into $TargetDir..." -ForegroundColor Yellow
    $previousTarget = $env:PI_SKILLS_DIR
    try {
        $env:PI_SKILLS_DIR = $TargetDir
        & $skillsInstaller -Fix
    } finally {
        if ($null -ne $previousTarget) {
            $env:PI_SKILLS_DIR = $previousTarget
        } else {
            Remove-Item Env:PI_SKILLS_DIR -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "Installing agent skills from $skillsRepo..." -ForegroundColor Yellow
if (Test-Path $skillsDir) {
    git -C $skillsDir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not update skills repo at $skillsDir. Continuing with the existing checkout."
    }
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $skillsDir -Parent) | Out-Null
    git clone $skillsRepo $skillsDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not clone skills repo into $skillsDir. Skipping agent skill links."
    }
}

if (Test-Path -LiteralPath $skillsInstaller) {
    Install-AgentSkillLinks (Join-Path $HOME ".pi\agent\skills") "Pi"
    Install-AgentSkillLinks (Join-Path $HOME ".agents\skills") "Codex CLI"
}

Write-Host "`nPost-setup complete." -ForegroundColor Green
