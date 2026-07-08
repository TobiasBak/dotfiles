param(
    [ValidateSet("Get", "Test", "Set")]
    [string]$Mode = "Set",
    [string]$DistroName = "NixOS",
    [ValidatePattern('^[a-z_][a-z0-9_-]*[$]?$')]
    [string]$LinuxUser = "tobias",
    [string]$InstallerUrl = "https://github.com/nix-community/NixOS-WSL/releases/latest/download/nixos.wsl",
    [string]$RepoRoot = [System.IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath)
)

$ErrorActionPreference = "Stop"
# This script checks native exit codes explicitly. DSC hosts can otherwise
# promote expected non-zero wsl/git exits before the script handles them.
$PSNativeCommandUseErrorActionPreference = $false

function Get-WslDistroNames {
    $output = (& wsl --list --quiet 2>$null) -replace "`0", ""
    if ($LASTEXITCODE -ne 0) {
        return @()
    }

    return @($output | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-DefaultWslDistro {
    $output = (& wsl --list --verbose 2>$null) -replace "`0", ""
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    foreach ($line in $output) {
        if ($line -match '^\s*\*\s+(\S+)') {
            return $Matches[1]
        }
    }

    return $null
}

function Test-WslDistro {
    param([Parameter(Mandatory=$true)][string]$Name)

    return [bool](Get-WslDistroNames | Where-Object { $_ -eq $Name })
}

function Test-WslLinuxUser {
    return (Test-WslBash -User "root" -Script "getent passwd $LinuxUser >/dev/null")
}

function Test-WslBash {
    param(
        [Parameter(Mandatory=$true)][string]$User,
        [Parameter(Mandatory=$true)][string]$Script
    )

    if (-not (Test-WslDistro $DistroName)) {
        return $false
    }

    try {
        $ErrorActionPreference = "Continue"
        $PSNativeCommandUseErrorActionPreference = $false
        & wsl -d $DistroName -u $User -- bash -lc $Script *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Get-NixOsWslState {
    $installed = Test-WslDistro $DistroName
    $defaultDistro = Get-DefaultWslDistro
    $linuxUserExists = $false
    $systemConfigured = $false
    $userBootstrapped = $false

    if ($installed) {
        $linuxUserExists = Test-WslLinuxUser
        $systemConfigured = $linuxUserExists -and (Test-WslBash -User "root" -Script "test -f /etc/dotfiles-nixos-wsl-system-ok")
        if ($linuxUserExists) {
            $userBootstrapped = Test-WslBash -User $LinuxUser -Script "test -f ~/.dotfiles-nixos-wsl-shell-ok -a -f ~/.dotfiles/windows/scripts/bootstrap-nixos-wsl.sh"
        }
    }

    return @{
        distro = $DistroName
        installed = $installed
        defaultDistro = $defaultDistro
        default = ($defaultDistro -eq $DistroName)
        linuxUser = $LinuxUser
        linuxUserExists = $linuxUserExists
        systemConfigured = $systemConfigured
        userBootstrapped = $userBootstrapped
    }
}

function Invoke-CheckedNative {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [Parameter(Mandatory=$true)][string]$StepName
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$StepName failed with exit code $LASTEXITCODE"
    }
}

function Install-NixOsWslDistro {
    if (Test-WslDistro $DistroName) {
        Write-Host "$DistroName WSL distro already installed." -ForegroundColor Cyan
        return
    }

    $installerPath = Join-Path ([IO.Path]::GetTempPath()) "nixos.wsl"
    Write-Host "Downloading NixOS-WSL installer to $installerPath..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $installerPath -UseBasicParsing

    Write-Host "Installing $DistroName via wsl --install --from-file..." -ForegroundColor Yellow
    & wsl --install --from-file $installerPath --name $DistroName
    $fromFileExitCode = $LASTEXITCODE

    if ($fromFileExitCode -eq 0 -or (Test-WslDistro $DistroName)) {
        return
    }

    Write-Warning "wsl --install --from-file failed with exit code $fromFileExitCode. Falling back to wsl --import."
    $installLocation = Join-Path $env:LOCALAPPDATA "WSL\$DistroName"
    if (Test-Path -LiteralPath $installLocation) {
        $existingItems = @(Get-ChildItem -LiteralPath $installLocation -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($existingItems.Count -gt 0) {
            throw "Fallback import location already exists and is not empty: $installLocation"
        }
    }

    New-Item -ItemType Directory -Force -Path $installLocation | Out-Null
    Invoke-CheckedNative -FilePath "wsl" -Arguments @("--import", $DistroName, $installLocation, $installerPath, "--version", "2") -StepName "wsl --import $DistroName"
}

function Set-NixOsAsDefaultWslDistro {
    if ((Get-DefaultWslDistro) -eq $DistroName) {
        Write-Host "$DistroName is already the default WSL distro." -ForegroundColor Cyan
        return
    }

    Write-Host "Setting $DistroName as the default WSL distro..." -ForegroundColor Yellow
    Invoke-CheckedNative -FilePath "wsl" -Arguments @("--set-default", $DistroName) -StepName "wsl --set-default $DistroName"
}

function Get-OriginRemoteUrl {
    $remoteUrl = $null
    $git = Get-Command git.exe -ErrorAction SilentlyContinue

    if ($git) {
        $remoteUrl = (& $git.Source -C $RepoRoot remote get-url origin 2>$null | Select-Object -First 1)
    }

    if (-not $remoteUrl) {
        $gitConfig = Join-Path $RepoRoot ".git\config"
        if (Test-Path $gitConfig) {
            $inOrigin = $false
            foreach ($line in Get-Content $gitConfig) {
                if ($line -match '^\s*\[remote "origin"\]\s*$') {
                    $inOrigin = $true
                    continue
                }
                if ($line -match '^\s*\[') {
                    $inOrigin = $false
                }
                if ($inOrigin -and $line -match '^\s*url\s*=\s*(.+?)\s*$') {
                    $remoteUrl = $Matches[1]
                    break
                }
            }
        }
    }

    if ($remoteUrl -match '^git@github\.com:(.+?)(?:\.git)?$') {
        $remoteUrl = "https://github.com/$($Matches[1]).git"
    }

    if (-not $remoteUrl) {
        throw "Could not determine origin remote from $RepoRoot"
    }

    return $remoteUrl.Trim()
}

function Invoke-WslBashScript {
    param(
        [Parameter(Mandatory=$true)][string]$User,
        [Parameter(Mandatory=$true)][string]$Script,
        [hashtable]$Environment = @{},
        [string]$StepName = "WSL script"
    )

    $encodedScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
    $envArgs = @()
    foreach ($key in $Environment.Keys) {
        $envArgs += "$key=$($Environment[$key])"
    }
    $envArgs += "DOTFILES_SCRIPT_B64=$encodedScript"

    $ErrorActionPreference = "Continue"
    $PSNativeCommandUseErrorActionPreference = $false
    & wsl -d $DistroName -u $User -- env @envArgs bash -lc 'printf "%s" "$DOTFILES_SCRIPT_B64" | base64 -d | bash'
    if ($LASTEXITCODE -ne 0) {
        throw "$StepName failed with exit code $LASTEXITCODE"
    }
}

function Install-NixOsSystemConfig {
    $remoteUrl = Get-OriginRemoteUrl
    $systemScript = @'
set -euo pipefail

export NIX_CONFIG="${NIX_CONFIG:-}
experimental-features = nix-command flakes"

repo="/root/dotfiles"
nixpkgs_ref="github:NixOS/nixpkgs/nixos-25.11"
rm -f /etc/dotfiles-nixos-wsl-system-ok

run_git() {
  if command -v git >/dev/null 2>&1; then
    git "$@"
  else
    nix --extra-experimental-features "nix-command flakes" shell "$nixpkgs_ref#git" "$nixpkgs_ref#cacert" -c git "$@"
  fi
}

rm -rf "$repo"
run_git clone "$DOTFILES_REMOTE" "$repo"
test -f "$repo/nixos/flake.nix"
test -f "$repo/nixos/hosts/wsl/configuration.nix"

nix --extra-experimental-features "nix-command flakes" build "$repo/nixos#nixosConfigurations.wsl.config.system.build.toplevel"
nixos-rebuild switch --flake "$repo/nixos#wsl"
getent passwd "$DOTFILES_LINUX_USER" >/dev/null
touch /etc/dotfiles-nixos-wsl-system-ok
'@

    Write-Host "Applying NixOS WSL system config from $remoteUrl..." -ForegroundColor Yellow
    Invoke-WslBashScript -User "root" -Script $systemScript -Environment @{
        DOTFILES_REMOTE = $remoteUrl
        DOTFILES_LINUX_USER = $LinuxUser
    } -StepName "NixOS WSL system configuration"
}

function Install-NixOsUserBootstrap {
    $remoteUrl = Get-OriginRemoteUrl
    $userScript = @'
set -euo pipefail

target="$HOME/code/dotfiles"
stable="$HOME/.dotfiles"
nixpkgs_ref="github:NixOS/nixpkgs/nixos-25.11"

run_git() {
  if command -v git >/dev/null 2>&1; then
    git "$@"
  else
    nix --extra-experimental-features "nix-command flakes" shell "$nixpkgs_ref#git" "$nixpkgs_ref#cacert" -c git "$@"
  fi
}

if [ -d "$target/.git" ]; then
  run_git -C "$target" pull --ff-only || echo "Could not fast-forward $target; continuing with the existing checkout." >&2
elif [ ! -e "$target" ]; then
  mkdir -p "$(dirname "$target")"
  run_git clone "$DOTFILES_REMOTE" "$target"
else
  echo "$target exists but is not a git repository." >&2
  exit 1
fi

if [ -L "$stable" ] || [ ! -e "$stable" ]; then
  ln -sfn "$target" "$stable"
elif [ "$(readlink -f "$stable")" != "$(readlink -f "$target")" ]; then
  echo "$stable exists and is not the dotfiles link. Move it aside and rerun setup." >&2
  exit 1
fi

bootstrap="$stable/windows/scripts/bootstrap-nixos-wsl.sh"
test -f "$bootstrap"
chmod +x "$bootstrap"
"$bootstrap"
touch "$HOME/.dotfiles-nixos-wsl-shell-ok"
'@

    Write-Host "Bootstrapping $LinuxUser home in $DistroName..." -ForegroundColor Yellow
    Invoke-WslBashScript -User $LinuxUser -Script $userScript -Environment @{ DOTFILES_REMOTE = $remoteUrl } -StepName "NixOS WSL user bootstrap"
}

function Set-NixOsWslInstall {
    Install-NixOsWslDistro
    Set-NixOsAsDefaultWslDistro

    $state = Get-NixOsWslState
    if (-not $state.systemConfigured) {
        Install-NixOsSystemConfig
    }

    $state = Get-NixOsWslState
    if (-not $state.systemConfigured) {
        throw "NixOS WSL system configuration did not create Linux user '$LinuxUser' and marker /etc/dotfiles-nixos-wsl-system-ok."
    }

    if (-not $state.userBootstrapped) {
        Install-NixOsUserBootstrap
    }
}

switch ($Mode) {
    "Get" {
        Get-NixOsWslState
    }
    "Test" {
        $state = Get-NixOsWslState
        return ($state.installed -and $state.default -and $state.linuxUserExists -and $state.systemConfigured -and $state.userBootstrapped)
    }
    "Set" {
        Set-NixOsWslInstall
    }
}
