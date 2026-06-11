# Script to link aliases to the PowerShell profiles (Windows PowerShell and PowerShell 7)

$AliasScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\configs\powershell\aliases.ps1")).Path
$SourceLine = ". `"$AliasScriptPath`""
$StaleAliasSourcePattern = '^\s*\.\s+"[^"]*(?:configs\\powershell\\aliases\.ps1|windows\\scripts\\aliases\.ps1)"\s*$'

# List of potential profile paths
$ProfilePaths = @(
    "$HOME\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1",
    "$HOME\Documents\PowerShell\Microsoft.PowerShell_profile.ps1"
)

foreach ($Path in $ProfilePaths) {
    $Dir = Split-Path $Path -Parent
    
    # Check if the directory exists (or create it if it's the expected location for the current shell)
    if (Test-Path $Dir) {
        if (!(Test-Path $Path)) {
            New-Item -Path $Path -ItemType File -Force
            Write-Host "Created profile: $Path" -ForegroundColor Gray
        }

        $Content = Get-Content $Path
        $ContentWithoutSourceLine = @($Content | Where-Object { $_ -ne $SourceLine -and $_ -notmatch $StaleAliasSourcePattern })
        Set-Content -Path $Path -Value ($ContentWithoutSourceLine + "" + $SourceLine) -Encoding UTF8
        Write-Host "Ensured aliases.ps1 is sourced last in $Path" -ForegroundColor Green
    }
}

Write-Host "`nPlease restart your shell(s) for changes to take effect." -ForegroundColor Cyan
