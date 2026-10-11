param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Id)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = Join-Path $PSScriptRoot "jobs\$Id"
$code = 1
try {
    $params = @{
        FilePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        ArgumentList = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\job.ps1`""
        WorkingDirectory = $dir
        WindowStyle = 'Hidden'
        RedirectStandardOutput = "$dir\stdout.txt"
        RedirectStandardError = "$dir\stderr.txt"
        PassThru = $true
    }
    $process = Start-Process @params
    $null = $process.Handle
    $process.WaitForExit()
    $code = $process.ExitCode
} catch {
    [IO.File]::AppendAllText("$dir\stderr.txt", ($_ | Out-String), [Text.UTF8Encoding]::new($false))
} finally {
    foreach ($name in @('stdout.txt', 'stderr.txt')) {
        if (!(Test-Path "$dir\$name")) { [IO.File]::WriteAllText("$dir\$name", '') }
    }
    [IO.File]::WriteAllText("$dir\exit.tmp", [string]$code, [Text.Encoding]::ASCII)
    [IO.File]::Move("$dir\exit.tmp", "$dir\exit.txt")
}
