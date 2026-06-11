# Custom PowerShell aliases/functions

# Codex CLI's built-in Windows updater launches `powershell -c ...` without
# `-NoProfile`, so this file is loaded before its installer runs. Keep tiny
# compatibility shims available for child script invocations, then skip the
# interactive aliases/functions below.
function script:Get-WindowsPowerShellModulePath {
    $segments = @()
    $documents = [Environment]::GetFolderPath("MyDocuments")
    if (-not [string]::IsNullOrWhiteSpace($documents)) {
        $segments += (Join-Path $documents "WindowsPowerShell\Modules")
    }

    $machineModulePath = [Environment]::GetEnvironmentVariable("PSModulePath", "Machine")
    if (-not [string]::IsNullOrWhiteSpace($machineModulePath)) {
        $segments += $machineModulePath -split ";"
    }

    return (@($segments | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique) -join ";")
}

function script:Repair-WindowsPowerShellModulePath {
    if ($PSVersionTable.PSVersion.Major -gt 5) {
        return
    }

    $windowsPowerShellModulePath = script:Get-WindowsPowerShellModulePath
    if (-not [string]::IsNullOrWhiteSpace($windowsPowerShellModulePath)) {
        $env:PSModulePath = $windowsPowerShellModulePath
    }
}

function script:Ensure-GetFileHashCompat {
    if (Get-Command Get-FileHash -CommandType Cmdlet,Function -ErrorAction SilentlyContinue) {
        return
    }

    function global:Get-FileHash {
        [CmdletBinding(DefaultParameterSetName = "Path")]
        param(
            [Parameter(ParameterSetName = "Path", Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
            [string[]]$Path,

            [Parameter(ParameterSetName = "LiteralPath", Mandatory = $true, ValueFromPipelineByPropertyName = $true)]
            [Alias("PSPath")]
            [string[]]$LiteralPath,

            [ValidateSet("SHA1", "SHA256", "SHA384", "SHA512", "MD5")]
            [string]$Algorithm = "SHA256"
        )

        process {
            $targetPaths = @()
            if ($PSCmdlet.ParameterSetName -eq "LiteralPath") {
                $targetPaths = $LiteralPath
            } else {
                $targetPaths = $Path
            }

            foreach ($targetPath in $targetPaths) {
                if ($PSCmdlet.ParameterSetName -eq "LiteralPath") {
                    $items = @(Get-Item -LiteralPath $targetPath -Force)
                } else {
                    $items = @(Get-Item -Path $targetPath -Force)
                }

                foreach ($item in $items) {
                    if ($item.PSIsContainer) {
                        continue
                    }

                    $hashAlgorithm = [System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)
                    if (-not $hashAlgorithm) {
                        throw "Unsupported hash algorithm: $Algorithm"
                    }

                    $stream = [System.IO.File]::OpenRead($item.FullName)
                    try {
                        $hashBytes = $hashAlgorithm.ComputeHash($stream)
                    } finally {
                        $stream.Dispose()
                        $hashAlgorithm.Dispose()
                    }

                    [PSCustomObject]@{
                        Algorithm = $Algorithm.ToUpperInvariant()
                        Hash = ([BitConverter]::ToString($hashBytes) -replace "-", "")
                        Path = $item.FullName
                    }
                }
            }
        }
    }
}

function script:Test-NonInteractiveProfileLoad {
    if ($env:DOTFILES_FORCE_INTERACTIVE_ALIASES -match "^(?i:1|true|yes)$") {
        return $false
    }

    $commandLine = [Environment]::CommandLine
    if ($commandLine -match '(?i)(^|\s|")-(?:c|command|encodedcommand|enc|file|f)(\s|$)') {
        return $true
    }

    try {
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
            return $true
        }
    } catch {
        return $true
    }

    return $false
}

script:Repair-WindowsPowerShellModulePath
script:Ensure-GetFileHashCompat
if (script:Test-NonInteractiveProfileLoad) {
    return
}

function script:Get-CommandPath {
    param([Parameter(Mandatory=$true)]$Command)

    if ($Command.Source) {
        return $Command.Source
    }
    return $Command.Definition
}

function script:Get-PwshPath {
    $pwsh = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwsh) {
        return (script:Get-CommandPath $pwsh)
    }

    $programFilesPwsh = Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $programFilesPwsh) {
        return $programFilesPwsh
    }

    return $null
}

function script:Invoke-CodexStandaloneInstaller {
    $pwshPath = script:Get-PwshPath
    if (-not $pwshPath) {
        throw "PowerShell 7 (pwsh) is required to install/update Codex CLI. Run windows/setup.ps1 again or install Microsoft.PowerShell with winget."
    }

    $installCommand = '$env:CODEX_NON_INTERACTIVE="1"; Remove-Item Env:CODEX_MANAGED_BY_NPM,Env:CODEX_MANAGED_PACKAGE_ROOT -ErrorAction SilentlyContinue; irm https://chatgpt.com/codex/install.ps1 | iex'
    & $pwshPath -NoProfile -ExecutionPolicy Bypass -Command $installCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Codex CLI standalone installer failed with exit code $LASTEXITCODE."
    }
}

function global:codex {
    if ($args.Count -gt 0 -and $args[0] -eq "update") {
        script:Invoke-CodexStandaloneInstaller
        return
    }

    $standaloneCodex = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
    if (-not (Test-Path -LiteralPath $standaloneCodex)) {
        script:Invoke-CodexStandaloneInstaller
    }

    if (Test-Path -LiteralPath $standaloneCodex) {
        # Codex's self-updater shells out to Windows PowerShell as `powershell -c`.
        # If Codex inherited pwsh's PSModulePath, Windows PowerShell may load
        # PowerShell 7 modules first and lose Get-FileHash. Give Codex a WinPS-safe
        # module path while it runs, then restore current shell state.
        $previousPSModulePath = $env:PSModulePath
        try {
            $windowsPowerShellModulePath = script:Get-WindowsPowerShellModulePath
            if (-not [string]::IsNullOrWhiteSpace($windowsPowerShellModulePath)) {
                $env:PSModulePath = $windowsPowerShellModulePath
            }

            & $standaloneCodex @args
        } finally {
            if ($null -ne $previousPSModulePath) {
                $env:PSModulePath = $previousPSModulePath
            } else {
                Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue
            }
        }
        return
    }

    throw "Codex CLI standalone executable not found after installer ran: $standaloneCodex"
}

function script:Get-NpmGlobalCommandPath {
    param([Parameter(Mandatory=$true)][string]$CommandName)

    $npm = @(
        Get-Command npm.exe -CommandType Application -ErrorAction SilentlyContinue
        Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
        Get-Command npm -CommandType Application -ErrorAction SilentlyContinue
    ) | Select-Object -First 1
    if (-not $npm) {
        return $null
    }

    $npmPath = script:Get-CommandPath $npm
    $prefixOutput = @(& $npmPath prefix -g 2>$null)
    if ($LASTEXITCODE -ne 0 -or $prefixOutput.Count -eq 0 -or -not $prefixOutput[0]) {
        return $null
    }

    foreach ($extension in ".cmd", ".ps1", ".exe", "") {
        $candidate = Join-Path ([string]$prefixOutput[0]).Trim() "$CommandName$extension"
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    return $null
}

function global:pi {
    if ($args.Count -gt 0 -and $args[0] -eq "update") {
        $npm = @(
            Get-Command npm.exe -CommandType Application -ErrorAction SilentlyContinue
            Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
            Get-Command npm -CommandType Application -ErrorAction SilentlyContinue
        ) | Select-Object -First 1
        if (-not $npm) {
            throw "npm executable not found on PATH; cannot update Pi coding agent."
        }

        $npmPath = script:Get-CommandPath $npm
        & $npmPath install -g "@earendil-works/pi-coding-agent@latest"
        if ($LASTEXITCODE -ne 0) {
            throw "Pi coding agent npm update failed with exit code $LASTEXITCODE."
        }
        return
    }

    $piCommand = script:Get-NpmGlobalCommandPath "pi"
    if ($piCommand) {
        & $piCommand @args
        return
    }

    $externalPi = Get-Command pi -CommandType Application,ExternalScript -All -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $externalPi) {
        throw "pi executable not found on PATH."
    }

    & (script:Get-CommandPath $externalPi) @args
}

function cy {
    codex --dangerously-bypass-approvals-and-sandbox --search @args
}

if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Chord Shift+Enter -Function AddLine -ErrorAction SilentlyContinue
    Set-PSReadLineKeyHandler -Chord Ctrl+Enter -Function AddLine -ErrorAction SilentlyContinue
}

Remove-Item Alias:ls -Force -ErrorAction SilentlyContinue
function global:ls {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Rest
    )

    & eza.exe --icons --grid --group-directories-first @Rest
}

# Microsoft.Coreutils injects a PSConsoleHostReadLine hook that rewrites typed `ls`
# to `C:\Program Files\coreutils\cmd\ls.cmd` before command discovery. Keep its
# hook for other tools, but rewrite only its `ls` expansion back to eza.
if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
    $script:__DOTFILES_PREV_PSConsoleHostReadLine = (Get-Command PSConsoleHostReadLine).ScriptBlock
    function global:PSConsoleHostReadLine {
        [System.Diagnostics.DebuggerHidden()]
        param()

        $line = & $script:__DOTFILES_PREV_PSConsoleHostReadLine
        $coreutilsLs = "& 'C:\Program Files\coreutils\cmd\ls.cmd' --color=auto"
        $ezaLs = 'eza.exe --icons --grid --group-directories-first'
        return $line.Replace($coreutilsLs, $ezaLs)
    }
}

if (Get-Module PSReadLine -ListAvailable) {
    Set-PSReadLineKeyHandler -Chord Shift+Enter -Function AddLine
    Set-PSReadLineKeyHandler -Chord Ctrl+Enter -Function AddLine
}

Write-Host "Custom aliases loaded." -ForegroundColor Gray
