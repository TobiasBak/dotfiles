param(
    [Parameter(Mandatory=$true)][ValidatePattern('^win-vm-[a-f0-9]{32}$')][string]$TaskName,
    [Parameter(Mandatory=$true)][string]$Directory,
    [switch]$KeepDirectory
)
$ErrorActionPreference = 'Stop'
$expected = Join-Path $PSScriptRoot ('jobs\' + $TaskName.Substring(7))
if ([IO.Path]::GetFullPath($Directory) -ne [IO.Path]::GetFullPath($expected)) { throw 'Job directory does not match task identity' }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -in @('Queued', 'Running')) { Stop-ScheduledTask -TaskName $TaskName }
$watch = [Diagnostics.Stopwatch]::StartNew()
do {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $active = $task -and $task.State -in @('Queued', 'Running')
    $locked = $false
    foreach ($name in @('stdout.txt', 'stderr.txt')) {
        $path = Join-Path $Directory $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        try {
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $stream.Dispose()
        } catch [IO.IOException] { $locked = $true }
    }
    if (-not $active -and -not $locked) {
        try {
            if (-not $KeepDirectory -and (Test-Path -LiteralPath $Directory)) { Remove-Item -LiteralPath $Directory -Recurse -Force }
            break
        } catch [IO.IOException] { $locked = $true }
    }
    if ($watch.Elapsed.TotalSeconds -ge 15) { throw 'Owned task or job handles still active; retained task and job directory' }
    Start-Sleep -Milliseconds 100
} while ($true)
if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
