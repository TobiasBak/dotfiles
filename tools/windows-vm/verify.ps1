$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sshd = Get-Service -Name "sshd"
$qemuGuestAgent = Get-Service -Name "qemu-ga"
$openSshFirewallRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP"
$enabledRdpFirewallRules = @(
    Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue |
        Where-Object Enabled -eq "True"
)
$terminalServer = Get-ItemProperty `
    -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server"
$winlogon = Get-ItemProperty `
    -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$sshdConfig = Get-Content `
    -LiteralPath (Join-Path $env:ProgramData "ssh\sshd_config") `
    -Raw
$provisionStatus = Get-Content `
    -LiteralPath (Join-Path $env:ProgramData "OipVmBootstrap\status.json") `
    -Raw |
    ConvertFrom-Json
$provisionTask = Get-ScheduledTask `
    -TaskName "OipVmBootstrap" `
    -ErrorAction SilentlyContinue
$currentVersion = Get-ItemProperty `
    -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
$license = Get-CimInstance SoftwareLicensingProduct |
    Where-Object {
        $_.ApplicationID -eq "55c92734-d682-4d71-983e-d6ec3f16059f" -and
        $_.PartialProductKey
    } |
    Select-Object -First 1

$checks = [ordered]@{
    provisionReady = $provisionStatus.state -eq "ready"
    sshdRunning = $sshd.Status -eq "Running"
    sshdAutomatic = $sshd.StartType -eq "Automatic"
    qemuGuestAgentRunning = $qemuGuestAgent.Status -eq "Running"
    qemuGuestAgentAutomatic = $qemuGuestAgent.StartType -eq "Automatic"
    sshFirewallEnabled = $openSshFirewallRule.Enabled -eq "True"
    sshFirewallAllProfiles = $openSshFirewallRule.Profile -eq "Any"
    publicKeyAuthenticationEnabled = $sshdConfig -match "(?m)^PubkeyAuthentication yes\r?$"
    passwordAuthenticationDisabled = $sshdConfig -match "(?m)^PasswordAuthentication no\r?$"
    rdpDenied = $terminalServer.fDenyTSConnections -eq 1
    rdpFirewallDisabled = $enabledRdpFirewallRules.Count -eq 0
    automaticLogonDisabled = $winlogon.AutoAdminLogon -ne "1"
    provisionTaskRemoved = $null -eq $provisionTask
    copenhagenTimeZone = (Get-TimeZone).Id -eq "Romance Standard Time"
}

$failedChecks = @(
    $checks.GetEnumerator() |
        Where-Object Value -ne $true |
        ForEach-Object Key
)
$result = [ordered]@{
    passed = $failedChecks.Count -eq 0
    failedChecks = $failedChecks
    checks = $checks
    machine = [ordered]@{
        computerName = $env:COMPUTERNAME
        productName = $currentVersion.ProductName
        displayVersion = $currentVersion.DisplayVersion
        build = "$($currentVersion.CurrentBuildNumber).$($currentVersion.UBR)"
        licenseStatus = if ($license) { $license.LicenseStatus } else { $null }
    }
}

$result | ConvertTo-Json -Depth 4
if ($failedChecks.Count -ne 0) {
    throw "VM verification failed: $($failedChecks -join ', ')"
}
