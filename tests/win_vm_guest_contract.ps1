$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $PSScriptRoot

function Wait-Condition([scriptblock]$Condition) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (& $Condition)) {
        if ($watch.Elapsed.TotalSeconds -ge 30) { throw 'Guest contract condition timed out' }
        Start-Sleep -Milliseconds 100
    }
}

function Start-Contract([string]$Script, [bool]$Detached) {
    $id = [Guid]::NewGuid().ToString('N')
    $directory = Join-Path $root "jobs\$id"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $directory 'job.ps1'), $Script, [Text.UTF8Encoding]::new($true))
    $task = 'win-vm-' + $id
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $root 'run-job.ps1') + '" -Id ' + $id
    if ($Detached) { $arguments += ' -Detached' }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 60)
    Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $task
    return @{ Task = $task; Directory = $directory }
}

function Same-Process($Identity) {
    $process = Get-Process -Id $Identity.pid -ErrorAction SilentlyContinue
    return $process -and $process.StartTime.ToUniversalTime().Ticks -eq $Identity.ticks
}

$leafScript = @'
$p = Get-Process -Id $PID
@{ pid = $PID; ticks = $p.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path (Get-Location) 'leaf.json')
while ($true) { [Console]::Error.WriteLine('owned synthetic descendant'); Start-Sleep -Milliseconds 100 }
'@
$encodedLeaf = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($leafScript))
$middleScript = @'
$p = Get-Process -Id $PID
@{ pid = $PID; ticks = $p.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path (Get-Location) 'middle.json')
$child = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -EncodedCommand LEAF' -PassThru -NoNewWindow
$child.WaitForExit()
'@
$encodedMiddle = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($middleScript.Replace('LEAF', $encodedLeaf)))
$containedScript = '$child = Start-Process powershell.exe -ArgumentList ''-NoProfile -NonInteractive -EncodedCommand ' + $encodedMiddle + ''' -PassThru -NoNewWindow; $child.WaitForExit()'
$contained = Start-Contract $containedScript $false
try {
    $leafPath = Join-Path $contained.Directory 'leaf.json'
    Wait-Condition { (Test-Path -LiteralPath $leafPath) -or (Test-Path -LiteralPath (Join-Path $contained.Directory 'exit.txt')) }
    if (-not (Test-Path -LiteralPath $leafPath)) { throw (Get-Content -LiteralPath (Join-Path $contained.Directory 'stderr.txt') -Raw) }
    $leaf = Get-Content -LiteralPath $leafPath -Raw | ConvertFrom-Json
    $middle = Get-Content -LiteralPath (Join-Path $contained.Directory 'middle.json') -Raw | ConvertFrom-Json
    if (-not (Same-Process $leaf) -or -not (Same-Process $middle)) { throw 'Contained descendants did not start' }
    & (Join-Path $root 'cleanup-job.ps1') -TaskName $contained.Task -Directory $contained.Directory
    if ((Same-Process $leaf) -or (Same-Process $middle)) { throw 'Owned descendant survived task cancellation' }
    if (Test-Path -LiteralPath $contained.Directory) { throw 'Cancelled job output directory survived cleanup' }
    if (Get-ScheduledTask -TaskName $contained.Task -ErrorAction SilentlyContinue) { throw 'Cancelled scheduled task survived cleanup' }
    Write-Output 'PASS contained descendant cancellation and output handle release'
} finally {
    if (Get-ScheduledTask -TaskName $contained.Task -ErrorAction SilentlyContinue) {
        & (Join-Path $root 'cleanup-job.ps1') -TaskName $contained.Task -Directory $contained.Directory
    }
}

$detachedScript = @'
$p = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -WorkingDirectory $env:TEMP -PassThru
@{ pid = $p.Id; ticks = $p.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'detached.json')
'@
$detached = Start-Contract $detachedScript $true
$identity = $null
try {
    Wait-Condition { Test-Path -LiteralPath (Join-Path $detached.Directory 'exit.txt') }
    if ((Get-Content -LiteralPath (Join-Path $detached.Directory 'exit.txt') -Raw).Trim() -ne '0') { throw (Get-Content -LiteralPath (Join-Path $detached.Directory 'stderr.txt') -Raw) }
    $identity = Get-Content -LiteralPath (Join-Path $detached.Directory 'detached.json') -Raw | ConvertFrom-Json
    Wait-Condition { (Get-ScheduledTask -TaskName $detached.Task).State -notin @('Queued', 'Running') }
    & (Join-Path $root 'cleanup-job.ps1') -TaskName $detached.Task -Directory $detached.Directory
    if (-not (Same-Process $identity)) { throw 'Detached application did not survive dispatch cleanup' }
} finally {
    if ($identity -and (Same-Process $identity)) {
        & taskkill.exe /T /F /PID $identity.pid | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Synthetic detached process cleanup failed' }
    }
    if (Get-ScheduledTask -TaskName $detached.Task -ErrorAction SilentlyContinue) {
        & (Join-Path $root 'cleanup-job.ps1') -TaskName $detached.Task -Directory $detached.Directory
    }
}
@{ passed = $true; contracts = @('owned-descendant-cancellation', 'output-handle-release', 'detached-dispatch-survival') } | ConvertTo-Json -Compress
