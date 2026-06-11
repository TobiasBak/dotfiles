# Installs/repairs agent CLIs that are not managed by winget configure.
# Safe to run directly after winget configure:
#   powershell -ExecutionPolicy Bypass -File .\windows\scripts\install-agent-clis.ps1

$ErrorActionPreference = "Stop"

function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$userPath;$machinePath"
}

function Get-CommandPath {
    param([Parameter(Mandatory=$true)]$Command)

    if ($Command.Source) {
        return $Command.Source
    }
    return $Command.Definition
}

function Test-IsSubPath {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Root
    )

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
        $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\")
        return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith("$fullRoot\", [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Set-UserPathEntriesFirst {
    param([Parameter(Mandatory=$true)][string[]]$PathEntries)

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $paths = @($userPath -split ";" | Where-Object { $_ })

    $first = @()
    foreach ($pathEntry in $PathEntries) {
        if (-not $pathEntry) {
            continue
        }
        if (-not ($first | Where-Object { $_.Equals($pathEntry, [System.StringComparison]::OrdinalIgnoreCase) })) {
            $first += $pathEntry
        }
    }

    $remaining = @($paths | Where-Object {
        $candidate = $_
        -not ($first | Where-Object { $_.Equals($candidate, [System.StringComparison]::OrdinalIgnoreCase) })
    })

    [Environment]::SetEnvironmentVariable("Path", (($first + $remaining) -join ";"), "User")
    Update-SessionPath
}

function Ensure-AgentPathOrder {
    param([string]$NpmPrefix)

    $codexBin = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"
    $entries = @($codexBin)
    if ($NpmPrefix) {
        $entries += $NpmPrefix
    }

    Set-UserPathEntriesFirst $entries
}

function Get-PwshPath {
    Update-SessionPath

    $pwsh = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwsh) {
        return (Get-CommandPath $pwsh)
    }

    $programFilesPwsh = Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $programFilesPwsh) {
        return $programFilesPwsh
    }

    return $null
}

function Ensure-PwshForInstaller {
    $pwshPath = Get-PwshPath
    if ($pwshPath) {
        return $pwshPath
    }

    $winget = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
        throw "winget was not found, and PowerShell 7 is required to install Codex CLI."
    }

    Write-Host "PowerShell 7 not found. Installing Microsoft.PowerShell via winget..." -ForegroundColor Yellow
    & (Get-CommandPath $winget) install --id Microsoft.PowerShell --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install Microsoft.PowerShell via winget; Codex CLI installer requires PowerShell 7."
    }

    $pwshPath = Get-PwshPath
    if (-not $pwshPath) {
        throw "Microsoft.PowerShell installed but pwsh.exe was not found after PATH refresh."
    }

    return $pwshPath
}

function Ensure-CodexStandalone {
    $codexBin = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"
    $codexExe = Join-Path $codexBin "codex.exe"

    Write-Host "Installing/updating Codex CLI via official standalone installer..." -ForegroundColor Yellow
    $pwshPath = Ensure-PwshForInstaller

    $previousNonInteractive = $env:CODEX_NON_INTERACTIVE
    $previousManagedByNpm = $env:CODEX_MANAGED_BY_NPM
    $previousManagedPackageRoot = $env:CODEX_MANAGED_PACKAGE_ROOT
    try {
        $env:CODEX_NON_INTERACTIVE = "1"
        Remove-Item Env:CODEX_MANAGED_BY_NPM,Env:CODEX_MANAGED_PACKAGE_ROOT -ErrorAction SilentlyContinue
        $installerCommand = '$env:CODEX_NON_INTERACTIVE="1"; Remove-Item Env:CODEX_MANAGED_BY_NPM,Env:CODEX_MANAGED_PACKAGE_ROOT -ErrorAction SilentlyContinue; irm https://chatgpt.com/codex/install.ps1 | iex'
        & $pwshPath -NoProfile -ExecutionPolicy Bypass -Command $installerCommand
    } finally {
        if ($null -ne $previousNonInteractive) {
            $env:CODEX_NON_INTERACTIVE = $previousNonInteractive
        } else {
            Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue
        }
        if ($null -ne $previousManagedByNpm) {
            $env:CODEX_MANAGED_BY_NPM = $previousManagedByNpm
        }
        if ($null -ne $previousManagedPackageRoot) {
            $env:CODEX_MANAGED_PACKAGE_ROOT = $previousManagedPackageRoot
        }
    }

    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $codexExe)) {
        throw "Failed to install/update Codex CLI via standalone installer."
    }

    & $codexExe --version | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Codex CLI installed but failed to run: $codexExe"
    }

    Ensure-AgentPathOrder
    Write-Host "Codex CLI standalone installed at $codexExe" -ForegroundColor Green
}

function Get-NpmGlobalInfo {
    param([Parameter(Mandatory=$true)][string]$NpmCommand)

    $prefixOutput = @(& $NpmCommand prefix -g 2>$null)
    if ($LASTEXITCODE -ne 0 -or $prefixOutput.Count -eq 0 -or -not $prefixOutput[0]) {
        return $null
    }

    $rootOutput = @(& $NpmCommand root -g 2>$null)
    if ($LASTEXITCODE -ne 0 -or $rootOutput.Count -eq 0 -or -not $rootOutput[0]) {
        return $null
    }

    return [pscustomobject]@{
        Prefix = ([string]$prefixOutput[0]).Trim()
        Root = ([string]$rootOutput[0]).Trim()
    }
}

function Join-NpmPackagePath {
    param(
        [Parameter(Mandatory=$true)][string]$Root,
        [Parameter(Mandatory=$true)][string]$PackageName
    )

    $path = $Root
    foreach ($part in ($PackageName -split "/")) {
        $path = Join-Path $path $part
    }
    return $path
}

function Get-ActiveNpmCommand {
    Update-SessionPath

    $npm = @(
        Get-Command npm.exe -CommandType Application -ErrorAction SilentlyContinue
        Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
        Get-Command npm -CommandType Application -ErrorAction SilentlyContinue
    ) | Select-Object -First 1

    if (-not $npm) {
        return $null
    }

    return (Get-CommandPath $npm)
}

function Ensure-NodeLtsViaNvm {
    Update-SessionPath

    $nvm = Get-Command nvm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nvm) {
        $candidate = Join-Path $env:ProgramFiles "nvm\nvm.exe"
        if (Test-Path -LiteralPath $candidate) {
            $env:Path = "$($env:ProgramFiles)\nvm;$env:Path"
            $nvm = Get-Command nvm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        }
    }

    if (-not $nvm) {
        Write-Warning "nvm not found. Open a new terminal or rerun setup after NVM install completes."
        return $false
    }

    if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
        Write-Host "Installing Node.js LTS via NVM for Windows..." -ForegroundColor Yellow
        & (Get-CommandPath $nvm) install lts
        if ($LASTEXITCODE -ne 0) {
            throw "nvm install lts failed with code $LASTEXITCODE"
        }

        & (Get-CommandPath $nvm) use lts
        if ($LASTEXITCODE -ne 0) {
            throw "nvm use lts failed with code $LASTEXITCODE"
        }

        Update-SessionPath
    }

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        corepack enable
    }

    return [bool](Get-ActiveNpmCommand)
}

function Ensure-NpmGlobalPackage {
    param(
        [Parameter(Mandatory=$true)][string]$PackageName,
        [Parameter(Mandatory=$true)][string]$CommandName,
        [Parameter(Mandatory=$true)][string]$DisplayName,
        [Parameter(Mandatory=$true)][string]$NpmCommand,
        [bool]$RequireCommandOnPath = $true
    )

    $npm = Get-NpmGlobalInfo $NpmCommand
    if (-not $npm) {
        throw "Could not determine npm global prefix/root from $NpmCommand."
    }

    Ensure-AgentPathOrder $npm.Prefix

    Write-Host "Installing/updating $DisplayName in npm prefix: $($npm.Prefix)" -ForegroundColor Yellow
    & $NpmCommand install -g "$PackageName@latest"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install/update $DisplayName via $NpmCommand."
    }

    $packagePath = Join-NpmPackagePath $npm.Root $PackageName
    if (-not (Test-Path -LiteralPath (Join-Path $packagePath "package.json"))) {
        throw "$DisplayName install completed but package.json was not found in $packagePath."
    }

    if ($RequireCommandOnPath) {
        $command = Get-Command $CommandName -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) {
            throw "$DisplayName install completed but '$CommandName' is not on PATH."
        }

        $commandSource = Get-CommandPath $command
        if (-not (Test-IsSubPath $commandSource $npm.Prefix)) {
            throw "$DisplayName install completed, but '$CommandName' resolves to $commandSource instead of npm prefix $($npm.Prefix)."
        }
    }

    Write-Host "Successfully installed/updated $DisplayName." -ForegroundColor Green
}

function Remove-NpmGlobalPackage {
    param(
        [Parameter(Mandatory=$true)][string]$PackageName,
        [Parameter(Mandatory=$true)][string]$NpmCommand
    )

    $npm = Get-NpmGlobalInfo $NpmCommand
    if (-not $npm) {
        return
    }

    $packagePath = Join-NpmPackagePath $npm.Root $PackageName
    if (-not (Test-Path -LiteralPath (Join-Path $packagePath "package.json"))) {
        return
    }

    Write-Host "Removing npm-managed $PackageName from $($npm.Prefix)." -ForegroundColor Yellow
    & $NpmCommand uninstall -g $PackageName
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to remove npm-managed $PackageName from $($npm.Prefix)."
    }
}

function Remove-RoamingNpmGlobalPackage {
    param([Parameter(Mandatory=$true)][string]$PackageName)

    $activeNpm = Get-ActiveNpmCommand
    if (-not $activeNpm) {
        return
    }

    $roamingPrefix = Join-Path $env:APPDATA "npm"
    $roamingRoot = Join-Path $roamingPrefix "node_modules"
    $packagePath = Join-NpmPackagePath $roamingRoot $PackageName
    if (-not (Test-Path -LiteralPath (Join-Path $packagePath "package.json"))) {
        return
    }

    Write-Host "Removing stale npm-managed $PackageName from $roamingPrefix." -ForegroundColor Yellow
    & $activeNpm --prefix $roamingPrefix uninstall -g $PackageName
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to remove stale npm-managed $PackageName from $roamingPrefix."
    }
}

function Get-VitePlusNpmCommands {
    $nodeRuntimeRoot = Join-Path $HOME ".vite-plus\js_runtime\node"
    if (-not (Test-Path -LiteralPath $nodeRuntimeRoot)) {
        return @()
    }

    return @(
        Get-ChildItem $nodeRuntimeRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "npm.cmd") } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 |
            ForEach-Object { Join-Path $_.FullName "npm.cmd" }
    )
}

function Get-NvmNpmCommands {
    $candidates = @(
        (Join-Path $env:ProgramFiles "nvm\npm.cmd"),
        "C:\nvm4w\nodejs\npm.cmd",
        (Join-Path $env:LOCALAPPDATA "nvm\npm.cmd")
    )

    return @($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Unique)
}

function Ensure-PiCodingAgent {
    $activeNpm = Get-ActiveNpmCommand
    if (-not $activeNpm) {
        throw "npm not found. Rerun setup after NVM/Node is available."
    }

    $seenPrefixes = @()
    $targets = @(
        [pscustomobject]@{ NpmCommand = $activeNpm; RequireCommandOnPath = $true }
    )
    $targets += @(Get-VitePlusNpmCommands | ForEach-Object {
        [pscustomobject]@{ NpmCommand = $_; RequireCommandOnPath = $false }
    })
    $targets += @(Get-NvmNpmCommands | ForEach-Object {
        [pscustomobject]@{ NpmCommand = $_; RequireCommandOnPath = $false }
    })

    foreach ($target in $targets) {
        $npmInfo = Get-NpmGlobalInfo $target.NpmCommand
        if (-not $npmInfo) {
            Write-Warning "Could not determine npm prefix for $($target.NpmCommand). Skipping Pi install for this npm."
            continue
        }

        if ($seenPrefixes | Where-Object { $_.Equals($npmInfo.Prefix, [System.StringComparison]::OrdinalIgnoreCase) }) {
            continue
        }
        $seenPrefixes += $npmInfo.Prefix

        Ensure-NpmGlobalPackage "@earendil-works/pi-coding-agent" "pi" "Pi coding agent" $target.NpmCommand $target.RequireCommandOnPath
    }
}

Ensure-CodexStandalone

if (Ensure-NodeLtsViaNvm) {
    Ensure-PiCodingAgent
    $activeNpm = Get-ActiveNpmCommand
    if ($activeNpm) {
        Remove-NpmGlobalPackage "@openai/codex" $activeNpm
    }

    Remove-RoamingNpmGlobalPackage "@openai/codex"
    Remove-RoamingNpmGlobalPackage "@earendil-works/pi-coding-agent"

    $cleanupNpmCommands = @()
    $cleanupNpmCommands += @(Get-VitePlusNpmCommands)
    $cleanupNpmCommands += @(Get-NvmNpmCommands)
    foreach ($npmCommand in $cleanupNpmCommands) {
        Remove-NpmGlobalPackage "@openai/codex" $npmCommand
    }
} else {
    throw "Node/npm is not available after NVM setup; Pi coding agent could not be installed."
}

Write-Host "Agent CLI installation complete." -ForegroundColor Green
