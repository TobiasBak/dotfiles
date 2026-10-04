param(
    [Parameter(Mandatory)]
    [ValidateSet('Inspect', 'Prepare', 'Cleanup')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$WinlogonPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$LogonKeys = @('DefaultPassword', 'DefaultUserName', 'DefaultDomainName', 'AutoAdminLogon', 'AutoLogonCount', 'ForceAutoLogon')

function Clear-TemporaryLogon {
    foreach ($key in $LogonKeys) {
        Remove-ItemProperty -Path $WinlogonPath -Name $key -ErrorAction SilentlyContinue
    }
}

function Get-DesktopState {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OipConsoleSession {
    // WTSINFOEX_LEVEL1W layout and SessionFlags: https://learn.microsoft.com/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct InfoLevel1 {
        public UInt32 SessionId;
        public Int32 SessionState;
        public Int32 SessionFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string WinStationName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string UserName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string DomainName;
        public Int64 LogonTime, ConnectTime, DisconnectTime, LastInputTime, CurrentTime;
        public UInt32 IncomingBytes, OutgoingBytes, IncomingFrames, OutgoingFrames;
        public UInt32 IncomingCompressedBytes, OutgoingCompressedBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct InfoEx {
        public UInt32 Level;
        public InfoLevel1 Data;
    }
    [DllImport("kernel32.dll")] public static extern UInt32 WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
    private static extern bool Query(IntPtr server, UInt32 session, Int32 infoClass, out IntPtr buffer, out UInt32 bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
    public static InfoLevel1 Get(UInt32 session) {
        IntPtr buffer;
        UInt32 bytes;
        if (!Query(IntPtr.Zero, session, 25, out buffer, out bytes))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (bytes < Marshal.SizeOf(typeof(InfoEx))) throw new InvalidOperationException("Incomplete WTSINFOEX");
            InfoEx info = (InfoEx)Marshal.PtrToStructure(buffer, typeof(InfoEx));
            if (info.Level != 1 || info.Data.SessionId != session) throw new InvalidOperationException("Unexpected WTSINFOEX");
            return info.Data;
        } finally { WTSFreeMemory(buffer); }
    }
}
'@
    $consoleId = [OipConsoleSession]::WTSGetActiveConsoleSessionId()
    $active = $false
    $unlocked = $false
    $administrator = $false
    $explorer = $false
    if ($consoleId -ne [uint32]::MaxValue) {
        $session = [OipConsoleSession]::Get($consoleId)
        $active = $session.SessionState -eq 0
        $unlocked = $session.SessionFlags -eq 1
        $administrator = $session.UserName -eq 'Administrator' -and $session.DomainName -eq $env:COMPUTERNAME
        $explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue |
            Where-Object SessionId -eq $consoleId).Count -gt 0
    }
    $bootstrapPath = Join-Path $env:ProgramData 'OipVmBootstrap\status.json'
    $provisionReady = $false
    if (Test-Path -LiteralPath $bootstrapPath) {
        try {
            $bootstrap = Get-Content -LiteralPath $bootstrapPath -Raw | ConvertFrom-Json
            $provisionReady = $bootstrap.state -eq 'ready'
        } catch {
            $provisionReady = $false
        }
    }
    $registry = Get-Item -LiteralPath $WinlogonPath
    $remainingKeys = @($LogonKeys | Where-Object { $_ -in $registry.GetValueNames() })
    $partition = Get-Partition -DriveLetter C
    $supported = Get-PartitionSupportedSize -DriveLetter C
    return [ordered]@{
        state = if ($active -and $unlocked -and $administrator -and $explorer) { 'ready' } else { 'waiting' }
        bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
        provisionReady = $provisionReady
        consoleSessionId = $consoleId
        consoleActive = $active
        consoleUnlocked = $unlocked
        consoleAdministrator = $administrator
        explorerRunning = $explorer
        credentialsCleared = $remainingKeys.Count -eq 0
        partitionBytes = $partition.Size
        supportedMaxBytes = $supported.SizeMax
    }
}

try {
    if ($Mode -eq 'Cleanup') {
        Clear-TemporaryLogon
    }
    $state = Get-DesktopState
    if ($Mode -eq 'Prepare') {
        $password = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrEmpty($password) -or $password.Contains("`n") -or $password.Contains("`r")) {
            throw 'A single-line Administrator password is required on stdin.'
        }
        Clear-TemporaryLogon
        Set-ItemProperty -Path $WinlogonPath -Name DefaultUserName -Value 'Administrator' -Type String
        Set-ItemProperty -Path $WinlogonPath -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
        Set-ItemProperty -Path $WinlogonPath -Name DefaultPassword -Value $password -Type String
        $password = $null
        Set-ItemProperty -Path $WinlogonPath -Name AutoLogonCount -Value 1 -Type DWord
        Set-ItemProperty -Path $WinlogonPath -Name AutoAdminLogon -Value '1' -Type String
        $state.state = 'restart-scheduled'
        $state.credentialsCleared = $false
        $state | ConvertTo-Json -Compress
        [Console]::Out.Flush()
        # Five seconds lets the SSH reply drain before the single login restart.
        & shutdown.exe /r /t 5 /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not schedule the console login restart.' }
    } else {
        $state | ConvertTo-Json -Compress
    }
} catch {
    if ($Mode -eq 'Prepare') { Clear-TemporaryLogon }
    [Console]::Error.WriteLine("Desktop readiness {0} failed ({1})." -f $Mode, $_.Exception.GetType().Name)
    exit 1
}
