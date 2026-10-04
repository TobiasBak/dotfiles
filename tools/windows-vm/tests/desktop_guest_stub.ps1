param([string]$GuestScript, [string]$Scratch)
if ($Scratch -notmatch 'windows-vm-guest-scratch-') { throw 'Guest doubles require an isolated scratch directory.' }
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition @'
public struct FakeConsoleInfo {
    public int SessionState, SessionFlags;
    public string UserName, DomainName;
}
public static class OipConsoleSession {
    public static int Flags = 1;
    public static uint WTSGetActiveConsoleSessionId() { return 1; }
    public static FakeConsoleInfo Get(uint id) {
        return new FakeConsoleInfo { SessionState = 0, SessionFlags = Flags, UserName = "Administrator", DomainName = "SCRATCHVM" };
    }
}
'@
$global:Registry = @{}
$global:PartitionSize = 1048576
$global:ResizeCount = 0
$global:RestartCount = 0
$global:BootstrapPresent = $true
$env:ProgramData = $Scratch
$env:COMPUTERNAME = 'SCRATCHVM'
function Add-Type { param($TypeDefinition) }
function Get-Process { param($Name, $ErrorAction) [pscustomobject]@{SessionId=1} }
function Get-CimInstance { param($ClassName) [pscustomobject]@{LastBootUpTime=[datetime]'2026-10-05T00:00:00Z'} }
function Test-Path { param($LiteralPath) $global:BootstrapPresent }
function Get-Content { param($LiteralPath, [switch]$Raw) '{"state":"ready"}' }
function Get-Item {
    param($LiteralPath)
    $result = [pscustomobject]@{}
    $result | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { @($global:Registry.Keys) }
    $result
}
function Get-Partition { param($DriveLetter) [pscustomobject]@{Size=$global:PartitionSize} }
function Get-PartitionSupportedSize { param($DriveLetter) [pscustomobject]@{SizeMax=2097152} }
function Update-HostStorageCache { }
function Resize-Partition { param($DriveLetter, $Size) $global:PartitionSize=$Size; $global:ResizeCount++ }
function Set-ItemProperty { param($Path, $Name, $Value, $Type) $global:Registry[$Name]=$Value }
function Remove-ItemProperty { param($Path, $Name, $ErrorAction) $global:Registry.Remove($Name) }
function shutdown.exe { param($r, $t, $seconds, $f) $global:RestartCount++; $global:LASTEXITCODE=0 }
$script = $GuestScript
$prepared = (& $script -Mode Prepare) | ConvertFrom-Json
if ($prepared.state -ne 'restart-scheduled' -or $global:ResizeCount -ne 1 -or $global:RestartCount -ne 1) { throw 'Preparation did not grow and restart exactly once.' }
if ($global:Registry.DefaultPassword -ne 'scratch-ONLY-secret!' -or $global:Registry.AutoAdminLogon -ne '1') { throw 'Preparation did not set autologon from stdin.' }
$cleaned = (& $script -Mode Cleanup) | ConvertFrom-Json
if (-not $cleaned.credentialsCleared -or $global:Registry.Count -ne 0 -or $cleaned.state -ne 'ready') { throw 'Cleanup did not prove readiness and remove all credential/default-logon keys.' }
[OipConsoleSession]::Flags = 0
$locked = (& $script -Mode Inspect) | ConvertFrom-Json
if ($locked.state -ne 'waiting' -or -not $locked.explorerRunning -or $locked.consoleUnlocked) { throw 'Explorer incorrectly proved unlock.' }
[OipConsoleSession]::Flags = 1
$global:BootstrapPresent = $false
$missing = (& $script -Mode Inspect) | ConvertFrom-Json
if ($missing.state -ne 'ready' -or $missing.provisionReady) { throw 'Missing bootstrap status was blocking or fabricated.' }
'PASS: real guest PowerShell flow against storage, registry, restart and native-session doubles.'
