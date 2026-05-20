$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$Failures = @()

function Test-Link($Path, $ExpectedTarget) {
    $Expected = (Resolve-Path $ExpectedTarget).Path
    if (!(Test-Path -LiteralPath $Path)) {
        $script:Failures += "Missing: $Path -> $Expected"
        return
    }
    $Item = Get-Item -LiteralPath $Path -Force
    if (!$Item.LinkType) {
        $script:Failures += "Not link: $Path (expected -> $Expected)"
        return
    }
    $Actual = ($Item.Target -join ";")
    if ([System.IO.Path]::GetFullPath($Actual) -ne [System.IO.Path]::GetFullPath($Expected)) {
        $script:Failures += "Wrong target: $Path -> $Actual (expected -> $Expected)"
        return
    }
    Write-Host "OK: $Path -> $Expected"
}

function Test-LinkOrHardLink($Path, $ExpectedTarget) {
    $Expected = (Resolve-Path $ExpectedTarget).Path
    if (!(Test-Path -LiteralPath $Path)) {
        $script:Failures += "Missing: $Path -> $Expected"
        return
    }

    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.LinkType) {
        $Actual = ($Item.Target -join ";")
        if ([System.IO.Path]::GetFullPath($Actual) -ne [System.IO.Path]::GetFullPath($Expected)) {
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

Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/settings.json") (Join-Path $RepoRoot "configs/pi/settings.json")
Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/APPEND_SYSTEM.md") (Join-Path $RepoRoot "configs/pi/APPEND_SYSTEM.md")
Test-Link (Join-Path $HOME ".pi/agent/extensions") (Join-Path $RepoRoot "configs/pi/extensions")
Test-Link (Join-Path $HOME ".pi/agent/prompts") (Join-Path $RepoRoot "configs/pi/prompts")
Test-LinkOrHardLink (Join-Path $HOME ".pi/agent/keybindings.json") (Join-Path $RepoRoot "configs/pi/keybindings.json")
Test-LinkOrHardLink (Join-Path $HOME ".codex/config.toml") (Join-Path $RepoRoot "configs/codex/config.toml")
Test-Link (Join-Path $HOME ".codex/prompts") (Join-Path $RepoRoot "configs/codex/prompts")

$SkillsVerifier = "C:\apps\skills\scripts\verify-links.ps1"
if (Test-Path -LiteralPath $SkillsVerifier) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $SkillsVerifier
    if ($LASTEXITCODE -ne 0) { $Failures += "Skill link verifier failed." }
} else {
    $Failures += "Missing skills verifier: $SkillsVerifier"
}

if ($Failures.Count -gt 0) {
    $Failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "All agent links OK."
