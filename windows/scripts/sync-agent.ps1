$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$SkillsRoot = Join-Path (Split-Path $RepoRoot -Parent) "skills"
$SkillsInstaller = Join-Path $SkillsRoot "scripts\install-links.ps1"
if (!(Test-Path -LiteralPath $SkillsInstaller)) {
    throw "Missing skills installer: $SkillsInstaller"
}

function Install-SkillLinks {
    param(
        [Parameter(Mandatory=$true)][string]$TargetDir,
        [Parameter(Mandatory=$true)][string]$DisplayName
    )

    Write-Host "Installing/fixing $DisplayName skill links..."
    $previousTarget = $env:PI_SKILLS_DIR
    try {
        $env:PI_SKILLS_DIR = $TargetDir
        & powershell -NoProfile -ExecutionPolicy Bypass -File $SkillsInstaller -Fix
    } finally {
        if ($null -ne $previousTarget) {
            $env:PI_SKILLS_DIR = $previousTarget
        } else {
            Remove-Item Env:PI_SKILLS_DIR -ErrorAction SilentlyContinue
        }
    }
}

Install-SkillLinks (Join-Path $HOME ".pi\agent\skills") "Pi"
Install-SkillLinks (Join-Path $HOME ".agents\skills") "Codex CLI"

Write-Host "Verifying agent config + skills..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot "windows/scripts/verify-links.ps1")

Write-Host "Agent env synced. Restart Pi/Codex if running."
