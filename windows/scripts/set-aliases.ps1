# Script to link aliases to the PowerShell profiles (Windows PowerShell and PowerShell 7)

$AliasScriptPath = Join-Path $PSScriptRoot "aliases.ps1"
$SourceLine = ". `"$AliasScriptPath`""

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
        if ($Content -notcontains $SourceLine) {
            Add-Content -Path $Path -Value "`n$SourceLine"
            Write-Host "Added aliases.ps1 to $Path" -ForegroundColor Green
        } else {
            Write-Host "aliases.ps1 is already sourced in $Path" -ForegroundColor Cyan
        }
    }
}

Write-Host "`nPlease restart your shell(s) for changes to take effect." -ForegroundColor Cyan
