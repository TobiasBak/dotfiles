param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Id,
    [switch]$Detached
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = Join-Path $PSScriptRoot "jobs\$Id"
$code = 1
$process = $null
try {
    if (-not $Detached) {
        Add-Type @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WinVmJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Contain() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        Limits limits = new Limits();
        limits.Basic.Flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        return job;
    }
}
'@
        $jobHandle = [WinVmJob]::Contain()
    }
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
    if ($null -ne $process) { $process.Dispose() }
    foreach ($name in @('stdout.txt', 'stderr.txt')) {
        if (!(Test-Path "$dir\$name")) { [IO.File]::WriteAllText("$dir\$name", '') }
    }
    [IO.File]::WriteAllText("$dir\exit.tmp", [string]$code, [Text.Encoding]::ASCII)
    [IO.File]::Move("$dir\exit.tmp", "$dir\exit.txt")
}
