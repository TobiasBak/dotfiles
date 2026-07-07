$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "../..")).ProviderPath)
$StableRepoRoot = Join-Path $HOME ".dotfiles"
$ExpectedRepoRoot = $RepoRoot
$Failures = @()

function Get-NormalizedPath($Path) {
    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($providerPath)
}

if (Test-Path -LiteralPath $StableRepoRoot) {
    $StableItem = Get-Item -LiteralPath $StableRepoRoot -Force
    if ($StableItem.LinkType) {
        $ActualRepoTarget = Get-NormalizedPath ($StableItem.Target -join ";")
        $RepoRootPath = Get-NormalizedPath $RepoRoot
        if ($ActualRepoTarget -eq $RepoRootPath) {
            $ExpectedRepoRoot = $StableRepoRoot
            Write-Host "OK: $StableRepoRoot -> $RepoRootPath"
        } else {
            $Failures += "Wrong target: $StableRepoRoot -> $ActualRepoTarget (expected -> $RepoRootPath)"
        }
    } else {
        $Failures += "Not link: $StableRepoRoot (expected -> $RepoRoot)"
    }
} else {
    $Failures += "Missing: $StableRepoRoot -> $RepoRoot"
}

function Test-Link($Path, $ExpectedTarget) {
    if (!(Test-Path -LiteralPath $ExpectedTarget)) {
        $script:Failures += "Missing expected target: $ExpectedTarget"
        return
    }
    $Expected = Get-NormalizedPath $ExpectedTarget
    if (!(Test-Path -LiteralPath $Path)) {
        $script:Failures += "Missing: $Path -> $Expected"
        return
    }
    $Item = Get-Item -LiteralPath $Path -Force
    if (!$Item.LinkType) {
        $script:Failures += "Not link: $Path (expected -> $Expected)"
        return
    }
    $Actual = Get-NormalizedPath ($Item.Target -join ";")
    if ($Actual -ne $Expected) {
        $script:Failures += "Wrong target: $Path -> $Actual (expected -> $Expected)"
        return
    }
    Write-Host "OK: $Path -> $Expected"
}

function Test-LinkOrHardLink($Path, $ExpectedTarget) {
    if (!(Test-Path -LiteralPath $ExpectedTarget)) {
        $script:Failures += "Missing expected target: $ExpectedTarget"
        return
    }
    $Expected = Get-NormalizedPath $ExpectedTarget
    if (!(Test-Path -LiteralPath $Path)) {
        $script:Failures += "Missing: $Path -> $Expected"
        return
    }

    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.LinkType) {
        $Actual = Get-NormalizedPath ($Item.Target -join ";")
        if ($Actual -ne $Expected) {
            $script:Failures += "Wrong target: $Path -> $Actual (expected -> $Expected)"
            return
        }
        Write-Host "OK: $Path -> $Expected"
        return
    }

    $VolumeRoot = [System.IO.Path]::GetPathRoot((Resolve-Path $Path).Path)
    $HardLinks = @(fsutil hardlink list $Path 2>$null | ForEach-Object {
        Join-Path $VolumeRoot $_.TrimStart("\")
    })
    if ($HardLinks | Where-Object { [System.IO.Path]::GetFullPath($_) -eq [System.IO.Path]::GetFullPath($Expected) }) {
        Write-Host "OK: $Path => $Expected (hard link)"
        return
    }

    $script:Failures += "Not link: $Path (expected -> $Expected)"
}

Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/settings.json") (Join-Path $ExpectedRepoRoot "configs/pi/settings.json")
Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/APPEND_SYSTEM.md") (Join-Path $ExpectedRepoRoot "configs/pi/APPEND_SYSTEM.md")
Test-Link (Join-Path $HOME ".pi/agent/extensions") (Join-Path $ExpectedRepoRoot "configs/pi/extensions")
Test-Link (Join-Path $HOME ".pi/agent/prompts") (Join-Path $ExpectedRepoRoot "configs/pi/prompts")
Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/keybindings.json") (Join-Path $ExpectedRepoRoot "configs/pi/keybindings.json")
Test-LinkOrHardLink (Join-Path $HOME ".codex/config.toml") (Join-Path $ExpectedRepoRoot "configs/codex/config.toml")
Test-Link (Join-Path $HOME ".codex/prompts") (Join-Path $ExpectedRepoRoot "configs/codex/prompts")
Test-LinkOrHardLink (Join-Path $HOME ".wezterm.lua") (Join-Path $ExpectedRepoRoot "configs/wezterm/wezterm.lua")

$SkillsRoot = Join-Path (Split-Path $RepoRoot -Parent) "skills"
$SkillsVerifier = Join-Path $SkillsRoot "scripts\verify-links.ps1"
if (Test-Path -LiteralPath $SkillsVerifier) {
    $SkillTargets = @(
        [pscustomobject]@{ Name = "Pi"; TargetDir = Join-Path $HOME ".pi\agent\skills" },
        [pscustomobject]@{ Name = "Codex CLI"; TargetDir = Join-Path $HOME ".agents\skills" }
    )

    foreach ($SkillTarget in $SkillTargets) {
        Write-Host "Verifying $($SkillTarget.Name) skill links..."
        $previousTarget = $env:PI_SKILLS_DIR
        try {
            $env:PI_SKILLS_DIR = $SkillTarget.TargetDir
            & powershell -NoProfile -ExecutionPolicy Bypass -File $SkillsVerifier
            if ($LASTEXITCODE -ne 0) { $Failures += "$($SkillTarget.Name) skill link verifier failed." }
        } finally {
            if ($null -ne $previousTarget) {
                $env:PI_SKILLS_DIR = $previousTarget
            } else {
                Remove-Item Env:PI_SKILLS_DIR -ErrorAction SilentlyContinue
            }
        }
    }
} else {
    $Failures += "Missing skills verifier: $SkillsVerifier"
}

if ($Failures.Count -gt 0) {
    $Failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "All agent links OK."
