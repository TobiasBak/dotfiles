param(
    [switch]$InstallTask
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BootstrapDirectory = Join-Path $env:ProgramData "OipVmBootstrap"
$ProvisionScript = Join-Path $BootstrapDirectory "provision.ps1"
$PublicKeyPath = Join-Path $BootstrapDirectory "oip_windows_vm.pub"
$StatusPath = Join-Path $BootstrapDirectory "status.json"
$LogPath = Join-Path $BootstrapDirectory "provision.log"
$TaskName = "OipVmBootstrap"

function Write-ProvisionStatus {
    param(
        [Parameter(Mandatory)]
        [string]$State,
        [Parameter(Mandatory)]
        [string]$Message
    )

    $status = [ordered]@{
        state = $State
        message = $Message
        updatedAt = (Get-Date).ToString("o")
    }
    $status |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath $StatusPath -Encoding ascii
}

function Install-ProvisionTask {
    if (-not (Test-Path -LiteralPath $PublicKeyPath)) {
        throw "The bootstrap public key is missing: $PublicKeyPath"
    }

    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ProvisionScript`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal `
        -UserId "SYSTEM" `
        -LogonType ServiceAccount `
        -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
    Write-ProvisionStatus -State "scheduled" -Message "Provisioning task registered."
    Start-ScheduledTask -TaskName $TaskName
}

function Set-MachineConfiguration {
    Set-TimeZone -Id "Romance Standard Time"

    $serverManagerPath = "HKLM:\SOFTWARE\Microsoft\ServerManager"
    if (-not (Test-Path -LiteralPath $serverManagerPath)) {
        New-Item -Path $serverManagerPath | Out-Null
    }
    Set-ItemProperty `
        -Path $serverManagerPath `
        -Name "DoNotOpenServerManagerAtLogon" `
        -Type DWord `
        -Value 1

    & powercfg.exe /change monitor-timeout-ac 0
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to disable the display timeout."
    }

    Set-ItemProperty `
        -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server" `
        -Name "fDenyTSConnections" `
        -Value 1
    Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue |
        Disable-NetFirewallRule
}

function Install-AndConfigureOpenSsh {
    $capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
    if ($capability.State -ne "Installed") {
        Add-WindowsCapability `
            -Online `
            -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
    }

    $sshDirectory = Join-Path $env:ProgramData "ssh"
    $authorizedKeys = Join-Path $sshDirectory "administrators_authorized_keys"
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    Copy-Item -LiteralPath $PublicKeyPath -Destination $authorizedKeys -Force

    & icacls.exe $authorizedKeys /inheritance:r | Out-Null
    & icacls.exe $authorizedKeys /grant "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to secure administrators_authorized_keys."
    }

    Set-Service -Name sshd -StartupType Automatic
    Start-Service -Name sshd

    $sshdConfigPath = Join-Path $sshDirectory "sshd_config"
    $sshdConfig = Get-Content -LiteralPath $sshdConfigPath -Raw
    $sshdConfig = [regex]::Replace(
        $sshdConfig,
        "(?im)^\s*#?\s*(PubkeyAuthentication|PasswordAuthentication)\s+.*\r?\n?",
        ""
    )
    $authenticationSettings = @"
PubkeyAuthentication yes
PasswordAuthentication no

"@
    $matchPosition = $sshdConfig.IndexOf(
        "Match ",
        [StringComparison]::OrdinalIgnoreCase
    )
    if ($matchPosition -ge 0) {
        $sshdConfig = $sshdConfig.Insert($matchPosition, $authenticationSettings)
    } else {
        $sshdConfig = $sshdConfig.TrimEnd() + "`r`n`r`n" + $authenticationSettings
    }
    Set-Content -LiteralPath $sshdConfigPath -Value $sshdConfig -Encoding ascii

    $sshdExecutable = Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe"
    & $sshdExecutable -t
    if ($LASTEXITCODE -ne 0) {
        throw "The generated OpenSSH configuration is invalid."
    }
    Restart-Service -Name sshd

    $openSshFirewallRule = Get-NetFirewallRule `
        -Name "OpenSSH-Server-In-TCP" `
        -ErrorAction SilentlyContinue
    if (-not $openSshFirewallRule) {
        New-NetFirewallRule `
            -Name "OpenSSH-Server-In-TCP" `
            -DisplayName "OpenSSH Server (sshd)" `
            -Enabled True `
            -Direction Inbound `
            -Protocol TCP `
            -Action Allow `
            -LocalPort 22 | Out-Null
    } else {
        $openSshFirewallRule |
            Set-NetFirewallRule -Enabled True -Profile Any -Action Allow
    }
}

function Install-VirtioGuestTools {
    $installMarker = Join-Path $BootstrapDirectory "virtio-installed"
    if (Test-Path -LiteralPath $installMarker) {
        if (-not (Get-Service -Name "qemu-ga" -ErrorAction SilentlyContinue)) {
            throw "VirtIO installation completed but qemu-ga is not installed."
        }
        return $false
    }

    if (Get-Service -Name "qemu-ga" -ErrorAction SilentlyContinue) {
        New-Item -ItemType File -Path $installMarker -Force | Out-Null
        return $false
    }

    $virtioInstaller = Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 5" |
        ForEach-Object {
            Join-Path $_.DeviceID "virtio-win-guest-tools.exe"
        } |
        Where-Object {
            Test-Path -LiteralPath $_
        } |
        Select-Object -First 1
    if (-not $virtioInstaller) {
        throw "virtio-win-guest-tools.exe was not found on an attached CD."
    }

    $process = Start-Process `
        -FilePath $virtioInstaller `
        -ArgumentList "/quiet", "/norestart" `
        -PassThru `
        -Wait
    if ($process.ExitCode -notin 0, 3010) {
        throw "VirtIO guest tools failed with exit code $($process.ExitCode)."
    }
    New-Item -ItemType File -Path $installMarker -Force | Out-Null
    return $process.ExitCode -eq 3010
}

function Install-WindowsUpdateBatch {
    $session = New-Object -ComObject Microsoft.Update.Session
    $session.ClientApplicationID = "Order Integration Platform Windows VM"
    $searcher = $session.CreateUpdateSearcher()
    $searchResult = $searcher.Search(
        "IsInstalled=0 and IsHidden=0 and Type='Software'"
    )

    if ($searchResult.Updates.Count -eq 0) {
        return [pscustomobject]@{
            Installed = 0
            RebootRequired = $false
        }
    }

    $updates = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($update in $searchResult.Updates) {
        if (-not $update.EulaAccepted) {
            $update.AcceptEula()
        }
        [void]$updates.Add($update)
        Write-Host "Queued update: $($update.Title)"
    }

    $downloader = $session.CreateUpdateDownloader()
    $downloader.Updates = $updates
    $downloadResult = $downloader.Download()
    if ($downloadResult.ResultCode -notin 2, 3) {
        throw "Windows Update download failed with result code $($downloadResult.ResultCode)."
    }

    $downloadedUpdates = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($update in $updates) {
        if ($update.IsDownloaded) {
            [void]$downloadedUpdates.Add($update)
        }
    }
    if ($downloadedUpdates.Count -eq 0) {
        throw "Windows Update did not download any installable updates."
    }

    $installer = $session.CreateUpdateInstaller()
    $installer.Updates = $downloadedUpdates
    $installResult = $installer.Install()
    if ($installResult.ResultCode -notin 2, 3) {
        throw "Windows Update installation failed with result code $($installResult.ResultCode)."
    }

    return [pscustomobject]@{
        Installed = $downloadedUpdates.Count
        RebootRequired = $installResult.RebootRequired
    }
}

function Disable-AutomaticLogon {
    $winlogonPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
    Set-ItemProperty -Path $winlogonPath -Name "AutoAdminLogon" -Value "0"
    Remove-ItemProperty `
        -Path $winlogonPath `
        -Name "DefaultPassword" `
        -ErrorAction SilentlyContinue
}

if ($InstallTask) {
    Install-ProvisionTask
    exit
}

$transcriptStarted = $false
try {
    Start-Transcript -LiteralPath $LogPath -Append | Out-Null
    $transcriptStarted = $true

    Write-ProvisionStatus -State "configuring" -Message "Applying machine configuration."
    Set-MachineConfiguration
    Install-AndConfigureOpenSsh

    Write-ProvisionStatus -State "configuring" -Message "Installing VirtIO guest tools."
    $virtioRebootRequired = Install-VirtioGuestTools
    if ($virtioRebootRequired) {
        Write-ProvisionStatus `
            -State "restarting" `
            -Message "Restarting after VirtIO guest tools installation."
        Restart-Computer -Force
        exit
    }

    while ($true) {
        Write-ProvisionStatus -State "updating" -Message "Applying Windows updates."
        $updateResult = Install-WindowsUpdateBatch
        if ($updateResult.Installed -eq 0) {
            break
        }
        if ($updateResult.RebootRequired) {
            Write-ProvisionStatus `
                -State "restarting" `
                -Message "Restarting after installing $($updateResult.Installed) Windows update(s)."
            Restart-Computer -Force
            exit
        }
    }

    if (-not (Get-Service -Name "qemu-ga" -ErrorAction SilentlyContinue)) {
        throw "qemu-ga is not installed after provisioning."
    }
    Disable-AutomaticLogon
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-ProvisionStatus -State "ready" -Message "Golden image provisioning completed."
} catch {
    Write-ProvisionStatus -State "failed" -Message $_.Exception.Message
    Write-Error $_
    exit 1
} finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}
