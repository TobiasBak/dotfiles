# Windows Application/Configuration Installation Script
# Applies the repo-owned winget configure DSC file.

Write-Host "Applying Windows configuration via winget configure..." -ForegroundColor Cyan

# Ensure script is running as Administrator
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script MUST be run as Administrator. Please restart your PowerShell session as Administrator."
    exit 1
}

$configPath = (Resolve-Path (Join-Path $PSScriptRoot "..\configuration.winget")).Path

winget configure -f $configPath `
    --accept-configuration-agreements `
    --disable-interactivity

if ($LASTEXITCODE -eq 0) {
    Write-Host "Windows configuration applied successfully." -ForegroundColor Green
} else {
    Write-Warning "winget configure exited with code $LASTEXITCODE. If WSL triggered a reboot, setup should resume after next login."
}

function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Ensure-NodeLtsViaNvm {
    Update-SessionPath

    $nvm = Get-Command nvm -ErrorAction SilentlyContinue
    if (-not $nvm) {
        $candidate = Join-Path $env:ProgramFiles "nvm\nvm.exe"
        if (Test-Path $candidate) {
            $env:Path = "$($env:ProgramFiles)\nvm;$env:Path"
            $nvm = Get-Command nvm -ErrorAction SilentlyContinue
        }
    }

    if (-not $nvm) {
        Write-Warning "nvm not found after winget configure. Open a new terminal or rerun setup after NVM install completes."
        return $false
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "Installing Node.js LTS via NVM for Windows..." -ForegroundColor Yellow
        nvm install lts
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "nvm install lts failed with code $LASTEXITCODE"
            return $false
        }

        nvm use lts
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "nvm use lts failed with code $LASTEXITCODE"
            return $false
        }

        Update-SessionPath
    }

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        corepack enable
    }

    return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

$nodeReady = Ensure-NodeLtsViaNvm

if (Get-Command pi -ErrorAction SilentlyContinue) {
    Write-Host "Pi coding agent already installed. Skipping npm install." -ForegroundColor Cyan
} elseif ($nodeReady) {
    Write-Host "Installing Pi coding agent via npm..." -ForegroundColor Yellow
    npm install -g @earendil-works/pi-coding-agent
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Successfully installed Pi coding agent." -ForegroundColor Green
    } else {
        Write-Warning "Failed to install Pi coding agent via npm."
    }
} else {
    Write-Warning "npm not found. Rerun setup after NVM/Node is available if Pi should be installed automatically."
}

Write-Host "Application/configuration installation complete." -ForegroundColor Green
