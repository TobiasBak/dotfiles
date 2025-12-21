# Custom PowerShell Aliases/Functions

# Alias for Gemini CLI with a specific model
function gem {
    gemini --model gemini-3-flash-preview @args
}

Write-Host "Custom aliases loaded." -ForegroundColor Gray
