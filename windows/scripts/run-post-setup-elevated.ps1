# Relaunch post-setup elevated from RunOnce after reboot.

$PostSetupPath = Join-Path $PSScriptRoot 'post-setup.ps1'
if (-not (Test-Path $PostSetupPath)) {
    throw "post-setup.ps1 not found at $PostSetupPath"
}

$argList = @('-ExecutionPolicy', 'Bypass', '-File', $PostSetupPath)
Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
