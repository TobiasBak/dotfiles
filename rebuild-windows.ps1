$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$ConfigPath = Join-Path $RepoRoot "windows\configuration.winget"

function Test-IsWindows {
    return ($env:OS -eq "Windows_NT")
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsWindows)) {
    throw "rebuild-windows.ps1 must be run from Windows PowerShell."
}

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing winget configuration: $ConfigPath"
}

if (-not (Test-IsAdministrator)) {
    Write-Host "Restarting Windows rebuild as Administrator..." -ForegroundColor Yellow
    $process = Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath) `
        -Verb RunAs `
        -Wait `
        -PassThru
    exit $process.ExitCode
}

Write-Host "Rebuilding Windows dotfiles from $RepoRoot..." -ForegroundColor Cyan

Write-Host "Setting PowerShell execution policy to Bypass for current user..." -ForegroundColor Yellow
Set-ExecutionPolicy Bypass -Scope CurrentUser -Force

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget not found. Install/update App Installer from Microsoft Store, then rerun setup."
}

Write-Host "Enabling winget configure..." -ForegroundColor Yellow
& winget configure --enable
if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget configure --enable exited $LASTEXITCODE. Continuing; it may already be enabled."
}

$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "x64" }
$vcRedistId = "Microsoft.VCRedist.2015+.$arch"

Write-Host "Ensuring $vcRedistId is installed..." -ForegroundColor Yellow
& winget install --source winget --id $vcRedistId --accept-package-agreements --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) {
    Write-Warning "$vcRedistId install exited $LASTEXITCODE. Continuing; it may already be installed."
}

Write-Host "Verifying winget configure..." -ForegroundColor Yellow
$help = & winget configure --help 2>&1
if ($LASTEXITCODE -ne 0 -or (($help -join "`n") -notmatch "(?i)configuration|configure")) {
    throw "winget configure unavailable after enable. Output:`n$($help -join [Environment]::NewLine)"
}

Write-Host "Applying Windows configuration via winget configure..." -ForegroundColor Cyan
winget configure -f $ConfigPath `
    --accept-configuration-agreements `
    --disable-interactivity

if ($LASTEXITCODE -ne 0) {
    throw "winget configure exited with code $LASTEXITCODE. If WSL triggered a reboot, setup should resume after next login."
}

Write-Host "`nWindows dotfiles rebuild complete." -ForegroundColor Green
