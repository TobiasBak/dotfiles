param([string]$GuestScript, [string]$Scratch)
if ($Scratch -notmatch 'windows-vm-disk-scratch-') { throw 'Disk doubles require an isolated scratch directory.' }
$ErrorActionPreference = 'Stop'
$env:ProgramData = $Scratch
$global:PartitionBytes = 80MB
$global:RecoveryPresent = $true
$global:RecoveryNumber = 4
$global:DisableCount = 0
$global:DeleteCount = 0
$global:ResizeCount = 0
function Update-HostStorageCache { }
function Get-Partition {
    param($DriveLetter, $DiskNumber)
    $system = [pscustomobject]@{DiskNumber=0; PartitionNumber=2; Offset=1MB; Size=$global:PartitionBytes}
    if ($DriveLetter) { return $system }
    $system
    if ($global:RecoveryPresent) { [pscustomobject]@{DiskNumber=0; PartitionNumber=$global:RecoveryNumber; Offset=81MB; Size=1MB} }
}
function Get-Disk { param($Number) [pscustomobject]@{Size=129MB} }
function Get-PartitionSupportedSize { param($DriveLetter) [pscustomobject]@{SizeMax=$(if ($global:RecoveryPresent) {80MB} else {128MB})} }
function Resize-Partition { param($DriveLetter, $Size) $global:PartitionBytes=$Size; $global:ResizeCount++ }
function reagentc.exe {
    param($mode)
    $global:LASTEXITCODE=0
    if ($mode -eq '/info') { '\\?\GLOBALROOT\device\harddisk0\partition3\Recovery\WindowsRE' }
    elseif ($mode -eq '/disable') { $global:DisableCount++ }
    else { throw 'Unexpected reagentc command' }
}
function diskpart.exe {
    param($s, $path)
    $commands = Get-Content -LiteralPath $path
    if (($commands -join ';') -ne 'select disk 0;select partition 3;delete partition override') { throw 'Unexpected destructive diskpart selection' }
    $global:RecoveryPresent=$false
    $global:DeleteCount++
    $global:LASTEXITCODE=0
}
$rejected = $false
try { & $GuestScript | Out-Null } catch {
    $rejected = $_.Exception.Message -match 'Unsupported build-disk layout'
}
if (-not $rejected -or $global:DisableCount -or $global:DeleteCount -or $global:ResizeCount) { throw 'Unknown trailing partition was not rejected before mutation' }
$global:RecoveryNumber=3
$prepared = (& $GuestScript) | ConvertFrom-Json
if ($prepared.partitionBytes -ne 128MB -or $prepared.removedRecovery.partitionNumber -ne 3) { throw 'C: did not consume the enlarged disk after registered recovery removal' }
if ($global:DisableCount -ne 1 -or $global:DeleteCount -ne 1 -or $global:ResizeCount -ne 1) { throw 'Recovery must be disabled, deleted and volume extended exactly once' }
$inherited = (& $GuestScript) | ConvertFrom-Json
if ($inherited.removedRecovery -or $global:DisableCount -ne 1 -or $global:DeleteCount -ne 1 -or $global:ResizeCount -ne 1) { throw 'Prepared inherited layout was mutated again' }
'PASS: unknown layout refused; only registered recovery removed; inherited prepared volume unchanged.'
