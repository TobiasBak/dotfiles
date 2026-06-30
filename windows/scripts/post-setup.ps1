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

# 2. Remove the legacy Windows Terminal profile fragment created by older installs
$legacyWtFragment = Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal\Fragments\Dotfiles\arch-zsh.fragment.json"
if (Test-Path $legacyWtFragment) {
    Remove-Item -Path $legacyWtFragment -Force
    Write-Host "Removed legacy Windows Terminal Arch profile fragment." -ForegroundColor Green
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

$weztermConfigSource = Join-Path $ConfigsDir "wezterm\wezterm.lua"
$weztermConfigTarget = Join-Path $HOME ".wezterm.lua"
if (Test-Path $weztermConfigSource) {
    Link-DotfileConfig $weztermConfigSource $weztermConfigTarget
}

$hackNerdFontInstaller = Join-Path $PSScriptRoot "install-hack-nerd-font.ps1"
if (Test-Path $hackNerdFontInstaller) {
    & $hackNerdFontInstaller
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
