param(
    [ValidateSet("Get", "Test", "Set")]
    [string]$Mode = "Set",
    [string]$DistroName = "NixOS",
    [ValidatePattern('^[a-z_][a-z0-9_-]*[$]?$')]
    [string]$LinuxUser = "tobias",
    [string]$InstallerUrl = "https://github.com/nix-community/NixOS-WSL/releases/latest/download/nixos.wsl",
    [string]$NixpkgsRef = "github:NixOS/nixpkgs/nixos-26.05",
    [string]$RepoRoot = [System.IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "..\..")).ProviderPath)
)

$ErrorActionPreference = "Stop"
# This script checks native exit codes explicitly. DSC hosts can otherwise
# promote expected non-zero wsl/git exits before the script handles them.
$PSNativeCommandUseErrorActionPreference = $false

function Get-RepoRevision {
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) {
        throw "git.exe is required to determine the dotfiles revision."
    }

    $revision = (& $git.Source -C $RepoRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-fA-F]{40,64}$') {
        throw "Could not determine the Git revision for $RepoRoot."
    }

    return $revision.Trim().ToLowerInvariant()
}

function Test-WslReady {
    try {
        $ErrorActionPreference = "Continue"
        $PSNativeCommandUseErrorActionPreference = $false
        & wsl --list --quiet *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

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
    $desiredRevision = Get-RepoRevision
    $wslReady = Test-WslReady
    $installed = $wslReady -and (Test-WslDistro $DistroName)
    $defaultDistro = if ($wslReady) { Get-DefaultWslDistro } else { $null }
    $linuxUserExists = $false
    $systemConfigured = $false
    $userBootstrapped = $false

    if ($installed) {
        $linuxUserExists = Test-WslLinuxUser
        $systemStateTest = 'test "$(cat /etc/dotfiles-nixos-wsl-system-ok 2>/dev/null)" = ''{0}''' -f $desiredRevision
        $systemConfigured = $linuxUserExists -and (Test-WslBash -User "root" -Script $systemStateTest)
        if ($linuxUserExists) {
            $userStateTest = 'test "$(cat ~/.dotfiles-nixos-wsl-shell-ok 2>/dev/null)" = ''{0}'' && test "$(git -C ~/code/dotfiles rev-parse HEAD 2>/dev/null)" = ''{0}'' && test -f ~/code/dotfiles/windows/scripts/bootstrap-nixos-wsl.sh && test "$(readlink -f ~/.dotfiles 2>/dev/null)" = "$(readlink -f ~/code/dotfiles 2>/dev/null)"' -f $desiredRevision
            $userBootstrapped = Test-WslBash -User $LinuxUser -Script $userStateTest
        }
    }

    return @{
        wslReady = $wslReady
        revision = $desiredRevision
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

function ConvertTo-WslPath {
    param([Parameter(Mandatory=$true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ($root -notmatch '^([A-Za-z]):\\$') {
        throw "Cannot convert non-drive path to WSL path: $Path"
    }

    $drive = $Matches[1].ToLowerInvariant()
    $relativePath = $fullPath.Substring($root.Length).Replace('\', '/')
    return "/mnt/$drive/$relativePath"
}

function ConvertTo-ShellSingleQuotedString {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return "''"
    }

    return "'" + $Value.Replace("'", "'\''") + "'"
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

function Wait-NixOsWslDistroReady {
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        if (Test-WslBash -User "root" -Script "test -r /etc/os-release && command -v bash >/dev/null") {
            return
        }
        Start-Sleep -Seconds 2
    }

    throw "$DistroName was installed but did not become ready within 60 seconds. Run 'wsl --shutdown', verify 'wsl -d $DistroName -u root', and rerun setup."
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

    $exports = @()
    foreach ($key in $Environment.Keys) {
        if ($key -notmatch '^[A-Z_][A-Z0-9_]*$') {
            throw "Invalid WSL script environment variable name: $key"
        }

        $exports += "export $key=$(ConvertTo-ShellSingleQuotedString ([string]$Environment[$key]))"
    }

    $normalizedScript = $Script -replace "`r`n", "`n"
    $normalizedScript = $normalizedScript -replace "`r", "`n"
    $scriptText = (@("#!/usr/bin/env bash") + $exports + "" + $normalizedScript) -join "`n"
    $tempScript = Join-Path ([IO.Path]::GetTempPath()) ("dotfiles-wsl-script-" + [Guid]::NewGuid() + ".sh")

    $ErrorActionPreference = "Continue"
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        [IO.File]::WriteAllText($tempScript, $scriptText, [Text.UTF8Encoding]::new($false))
        $wslScript = ConvertTo-WslPath $tempScript
        & wsl -d $DistroName -u $User -- bash $wslScript
        if ($LASTEXITCODE -ne 0) {
            throw "$StepName failed with exit code $LASTEXITCODE"
        }
    } finally {
        Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
    }
}

function Install-NixOsSystemConfig {
    $remoteUrl = Get-OriginRemoteUrl
    $revision = Get-RepoRevision
    $systemScript = @'
set -euo pipefail

nix_config="${NIX_CONFIG:-}"
if [ -n "$nix_config" ]; then
  nix_config+=$'\n'
fi
nix_config+='experimental-features = nix-command flakes'
export NIX_CONFIG="$nix_config"

repo="/root/dotfiles"
nixpkgs_ref="$DOTFILES_NIXPKGS_REF"
rm -f /etc/dotfiles-nixos-wsl-system-ok

run_git() {
  if command -v git >/dev/null 2>&1; then
    git "$@"
  else
    nix --extra-experimental-features "nix-command flakes" shell "$nixpkgs_ref#git" "$nixpkgs_ref#cacert" -c git "$@"
  fi
}

run_with_git() {
  if command -v git >/dev/null 2>&1; then
    "$@"
  else
    nix --extra-experimental-features "nix-command flakes" shell "$nixpkgs_ref#git" "$nixpkgs_ref#cacert" -c "$@"
  fi
}

rm -rf "$repo"
run_git clone --no-checkout "$DOTFILES_REMOTE" "$repo"
run_git -C "$repo" checkout --detach "$DOTFILES_REVISION"
test "$(run_git -C "$repo" rev-parse HEAD)" = "$DOTFILES_REVISION"
test -f "$repo/nixos/flake.nix"
test -f "$repo/nixos/hosts/wsl/configuration.nix"

built_system="$(run_with_git nix build --no-link --print-out-paths "$repo/nixos#nixosConfigurations.wsl.config.system.build.toplevel")"
run_with_git nixos-rebuild switch --flake "$repo/nixos#wsl"
current_system="$(readlink -f /run/current-system)"

test "$current_system" = "$built_system"
getent passwd "$DOTFILES_LINUX_USER" >/dev/null
printf '%s\n' "$DOTFILES_REVISION" >/etc/dotfiles-nixos-wsl-system-ok
'@

    Write-Host "Applying NixOS WSL system config from $remoteUrl at $revision..." -ForegroundColor Yellow
    Invoke-WslBashScript -User "root" -Script $systemScript -Environment @{
        DOTFILES_REMOTE = $remoteUrl
        DOTFILES_REVISION = $revision
        DOTFILES_LINUX_USER = $LinuxUser
        DOTFILES_NIXPKGS_REF = $NixpkgsRef
    } -StepName "NixOS WSL system configuration"
}

function Install-NixOsUserBootstrap {
    $remoteUrl = Get-OriginRemoteUrl
    $revision = Get-RepoRevision
    $userScript = @'
set -euo pipefail

target="$HOME/code/dotfiles"
stable="$HOME/.dotfiles"
nixpkgs_ref="$DOTFILES_NIXPKGS_REF"

run_git() {
  if command -v git >/dev/null 2>&1; then
    git "$@"
  else
    nix --extra-experimental-features "nix-command flakes" shell "$nixpkgs_ref#git" "$nixpkgs_ref#cacert" -c git "$@"
  fi
}

resolve_path() {
  readlink -f "$1" 2>/dev/null || true
}

if [ -d "$target/.git" ]; then
  current_revision="$(run_git -C "$target" rev-parse HEAD)"
  if [ "$current_revision" != "$DOTFILES_REVISION" ]; then
    run_git -C "$target" fetch origin "$DOTFILES_REVISION"
    run_git -C "$target" merge --ff-only "$DOTFILES_REVISION"
  fi
elif [ ! -e "$target" ]; then
  mkdir -p "$(dirname "$target")"
  run_git clone "$DOTFILES_REMOTE" "$target"
else
  echo "$target exists but is not a git repository." >&2
  exit 1
fi

test "$(run_git -C "$target" rev-parse HEAD)" = "$DOTFILES_REVISION"
target_resolved="$(resolve_path "$target")"
stable_resolved="$(resolve_path "$stable")"

if [ -z "$target_resolved" ]; then
  echo "Could not resolve dotfiles checkout: $target" >&2
  exit 1
fi

if [ -L "$stable" ]; then
  if [ "$stable_resolved" != "$target_resolved" ]; then
    rm -f "$stable"
    ln -s "$target_resolved" "$stable"
  fi
elif [ ! -e "$stable" ]; then
  ln -s "$target_resolved" "$stable"
elif [ "$stable_resolved" != "$target_resolved" ]; then
  echo "$stable exists and is not the dotfiles link. Move it aside and rerun setup." >&2
  exit 1
fi

stable_resolved="$(resolve_path "$stable")"
if [ "$stable_resolved" != "$target_resolved" ]; then
  echo "$stable did not resolve to $target_resolved after link repair." >&2
  exit 1
fi

bootstrap="$target_resolved/windows/scripts/bootstrap-nixos-wsl.sh"
test -f "$bootstrap"
chmod +x "$bootstrap"
"$bootstrap"
printf '%s\n' "$DOTFILES_REVISION" >"$HOME/.dotfiles-nixos-wsl-shell-ok"
'@

    Write-Host "Bootstrapping $LinuxUser home in $DistroName at $revision..." -ForegroundColor Yellow
    Invoke-WslBashScript -User $LinuxUser -Script $userScript -Environment @{
        DOTFILES_REMOTE = $remoteUrl
        DOTFILES_REVISION = $revision
        DOTFILES_NIXPKGS_REF = $NixpkgsRef
    } -StepName "NixOS WSL user bootstrap"
}

function Set-NixOsWslInstall {
    if (-not (Test-WslReady)) {
        throw "WSL is not ready. Restart Windows, verify that 'wsl --list --quiet' succeeds, and rerun setup."
    }

    Install-NixOsWslDistro
    Wait-NixOsWslDistroReady
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
