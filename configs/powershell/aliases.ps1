# Custom PowerShell aliases/functions

function cy {
    codex --dangerously-bypass-approvals-and-sandbox --search @args
}

Write-Host "Custom aliases loaded." -ForegroundColor Gray
