$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Update-HostStorageCache
$partition = Get-Partition -DriveLetter C
$disk = Get-Disk -Number $partition.DiskNumber
$blocking = @(Get-Partition -DiskNumber $partition.DiskNumber | Where-Object { $_.Offset -gt $partition.Offset })
$removed = $null
if ($blocking.Count) {
    $configuration = & reagentc.exe /info 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect registered WinRE: exit=$LASTEXITCODE" }
    $registered = [regex]::Match(($configuration -join "`n"), 'harddisk(\d+)\\partition(\d+)\\Recovery\\WindowsRE', 'IgnoreCase')
    if ($blocking.Count -ne 1 -or -not $registered.Success -or
        [int]$registered.Groups[1].Value -ne $partition.DiskNumber -or
        [int]$registered.Groups[2].Value -ne $blocking[0].PartitionNumber) {
        throw "Unsupported build-disk layout: disk=$($partition.DiskNumber), C: partition=$($partition.PartitionNumber), blocking partitions=$($blocking.PartitionNumber -join ','). Only one trailing registered Windows Recovery partition may be removed."
    }
    $recovery = $blocking[0]
    & reagentc.exe /disable | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot disable WinRE before removing its partition: exit=$LASTEXITCODE" }
    $commands = Join-Path $env:ProgramData ('OipVmDisk-' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        @("select disk $($partition.DiskNumber)", "select partition $($recovery.PartitionNumber)", 'delete partition override') | Set-Content -LiteralPath $commands -Encoding ascii
        & diskpart.exe /s $commands | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Recovery partition removal failed: diskpart exit=$LASTEXITCODE" }
    } finally {
        Remove-Item -LiteralPath $commands -Force
    }
    Update-HostStorageCache
    $remaining = @(Get-Partition -DiskNumber $partition.DiskNumber | Where-Object { $_.Offset -gt $partition.Offset })
    if ($remaining.Count) { throw "Recovery partition remains after removal: disk=$($partition.DiskNumber), partitions=$($remaining.PartitionNumber -join ',')" }
    $removed = [ordered]@{ diskNumber = $recovery.DiskNumber; partitionNumber = $recovery.PartitionNumber; bytes = $recovery.Size }
}
$before = $partition.Size
$supported = Get-PartitionSupportedSize -DriveLetter C
if ($partition.Size -lt $supported.SizeMax) { Resize-Partition -DriveLetter C -Size $supported.SizeMax }
$partition = Get-Partition -DriveLetter C
$unallocatedTail = $disk.Size - $partition.Offset - $partition.Size
if ($partition.Size -ne $supported.SizeMax -or $unallocatedTail -gt 1MB) {
    throw "C: capacity did not reach the enlarged disk: diskBytes=$($disk.Size), partitionBytes=$($partition.Size), supportedMaxBytes=$($supported.SizeMax), unusedTailBytes=$unallocatedTail. Windows partition alignment permits at most 1 MiB at the disk end."
}
[ordered]@{
    diskBytes = $disk.Size
    partitionBeforeBytes = $before
    partitionBytes = $partition.Size
    removedRecovery = $removed
    unusedTailBytes = $unallocatedTail
    tailBudgetBasis = 'Windows partition alignment: at most one MiB at the disk end'
} | ConvertTo-Json -Depth 4 -Compress
