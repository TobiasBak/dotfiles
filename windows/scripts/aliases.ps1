# Custom PowerShell Aliases/Functions

# Alias for Claude with dangerous permissions skip
function claude-dangerous {
    claude --dangerously-skip-permissions @args
}

Write-Host "Custom aliases loaded." -ForegroundColor Gray
