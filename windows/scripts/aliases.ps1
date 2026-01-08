# Custom PowerShell Aliases/Functions

# Alias for Claude with dangerous permissions skip
function claudy {
    claude --dangerously-skip-permissions @args
}

Write-Host "Custom aliases loaded." -ForegroundColor Gray
