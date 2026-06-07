# Custom PowerShell aliases/functions

function cy {
    codex --dangerously-bypass-approvals-and-sandbox --search @args
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
