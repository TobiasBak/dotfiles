$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $PSScriptRoot
$root = 'C:\ProgramData\win-vm'
$log = [Collections.Generic.List[string]]::new()

function Report([string]$state, [string]$message) {
    $line = "$(Get-Date -Format o) $state $message"
    $log.Add($line)
    Write-Host $line
}

function Save-Log {
    $text = ($log -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText("$root\bootstrap.log", $text, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $stage 'bootstrap.log'), $text, [Text.UTF8Encoding]::new($false))
}

function Admin-Acl([string]$path, [bool]$directory) {
    if ($directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
        $identity = [Security.Principal.SecurityIdentifier]::new($sid)
        if ($directory) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        } else {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
        }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}

function Invoke-AsSystem([string]$name, [string]$exe, [string]$arguments, [int[]]$successCodes) {
    $task = "win-vm-bootstrap-$name"
    $runner = Join-Path $root "$name.ps1"
    $result = Join-Path $root "$name.exitcode"
    Remove-Item -LiteralPath $result, "$result.tmp" -Force -ErrorAction SilentlyContinue
    $q = { param($text) "'" + $text.Replace("'", "''") + "'" }
    [IO.File]::WriteAllText($runner, @"
`$code = -1
try { `$code = (Start-Process -FilePath $(& $q $exe) -ArgumentList $(& $q $arguments) -Wait -PassThru).ExitCode }
finally { [IO.File]::WriteAllText($(& $q "$result.tmp"), "`$code"); Move-Item -LiteralPath $(& $q "$result.tmp") -Destination $(& $q $result) -Force }
"@, [Text.UTF8Encoding]::new($false))
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $task
    $deadline = (Get-Date).AddMinutes(30)
    while (!(Test-Path -LiteralPath $result)) {
        if ((Get-Date) -gt $deadline) { throw "$name did not finish within 30 minutes; task $task left registered" }
        # 267011: the task has not run yet. Any other result while Ready means the runner died before its handshake.
        $taskResult = (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult
        if ((Get-ScheduledTask -TaskName $task).State -eq 'Ready' -and $taskResult -ne 267011 -and !(Test-Path -LiteralPath $result)) {
            throw "$name task $task ended with result $taskResult and no exit code"
        }
        Start-Sleep -Seconds 2
    }
    $code = [int](Get-Content -LiteralPath $result -Raw).Trim()
    while ((Get-ScheduledTask -TaskName $task).State -in @('Queued', 'Running')) { Start-Sleep -Seconds 1 }
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Remove-Item -LiteralPath $runner, $result -Force
    if ($code -notin $successCodes) { throw "$name exited $code as SYSTEM (log: $root\$name.log)" }
    if ($code -in @(3010, 1641)) { Report 'CHANGED' "$name requests a reboot; do not reboot until setup finishes" }
}

function Set-RegistryValue([string]$path, [string]$name, $value, [string]$type='String') {
    if (!(Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    $old = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
    if ($null -eq $old -or $old -ne $value -or (Get-Item -Path $path).GetValueKind($name).ToString() -ne $type) {
        New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
        Report 'CHANGED' "$path\$name"
    } else { Report 'OK' "$path\$name" }
}

function Remove-OtherPreloadValues([string]$path) {
    $key = (Get-Item -Path $path).OpenSubKey('', $true)
    try {
        $others = @($key.GetValueNames() | Where-Object { $_ -ne '1' })
        foreach ($name in $others) {
            $key.DeleteValue($name)
            Report 'CHANGED' "removed $path\$name"
        }
        if ($others.Count -eq 0) { Report 'OK' "$path has only value 1" }
    } finally { $key.Dispose() }
}

$success = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Elevation required. Run bootstrap.bat and accept UAC.' }
    if ($identity.Name.Split('\')[-1] -ine 'tb') { throw 'Run elevated as tb, not a different administrator' }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Admin-Acl $root $true
    Report 'OK' 'elevated as tb; ProgramData\win-vm restricted to Administrators and SYSTEM'

    # Install only from local copies: \\tsclient is a Remote Desktop path, and the copies sit in the admin-only directory.
    $artifacts = Join-Path $root 'artifacts'
    New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
    $pins = Get-Content -LiteralPath (Join-Path $stage 'artifacts.json') -Raw | ConvertFrom-Json
    foreach ($pin in $pins.PSObject.Properties) {
        $local = Join-Path $artifacts $pin.Name
        if (!(Test-Path -LiteralPath $local) -or (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ine $pin.Value) {
            Copy-Item -LiteralPath (Join-Path $stage $pin.Name) -Destination $local -Force
        }
        if ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ine $pin.Value) { throw "Artifact hash mismatch: $($pin.Name)" }
    }
    Report 'OK' 'installers copied to ProgramData\win-vm\artifacts; local SHA256 checks'
    if (!(Get-Service sshd -ErrorAction SilentlyContinue)) {
        Invoke-AsSystem 'openssh' 'msiexec.exe' "/i `"$artifacts\OpenSSH-Win64-v10.0.0.0.msi`" /qn /norestart ADDLOCAL=Server /l*v `"$root\openssh.log`"" @(0, 1638, 3010, 1641)
        if (!(Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'OpenSSH MSI did not install sshd (Server feature)' }
        Report 'CHANGED' 'OpenSSH Server installed'
    } else { Report 'OK' 'sshd service already installed' }

    $sshDir = 'C:\ProgramData\ssh'
    New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
    $config = Join-Path $sshDir 'sshd_config'
    $servicePath = (Get-CimInstance Win32_Service -Filter "Name='sshd'").PathName
    if ($servicePath -match '^"([^"]+\.exe)"') { $sshd = $Matches[1] }
    elseif ($servicePath -match '^(.+?\.exe)(?:\s|$)') { $sshd = $Matches[1] }
    else { throw 'Cannot resolve installed sshd executable' }
    if (!(Test-Path $config)) {
        Copy-Item -LiteralPath (Join-Path (Split-Path $sshd -Parent) 'sshd_config_default') -Destination $config
    }
    $original = [IO.File]::ReadAllText($config)
    $lines = [Collections.Generic.List[string]]::new()
    $inMatch = $false
    foreach ($line in ($original.TrimEnd("`r", "`n") -split '\r?\n')) {
        if ($line -match '^\s*Match\s') { $inMatch = $true }
        if (!$inMatch -and $line -match '^\s*#?\s*(PubkeyAuthentication|PasswordAuthentication|Subsystem\s+sftp)\s') { continue }
        $lines.Add($line)
    }
    # Stock 'sftp-server.exe' is relative, and the MSI doesn't put its directory on sshd's PATH.
    $sftp = "Subsystem`tsftp`t`"$(Join-Path (Split-Path $sshd -Parent) 'sftp-server.exe')`""
    $updated = "PubkeyAuthentication yes`r`nPasswordAuthentication no`r`n$sftp`r`n" + ($lines -join "`r`n") + "`r`n"
    if ($updated -notmatch '(?im)^\s*Match Group administrators\s*$' -or
        $updated -notmatch '(?im)^\s*AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys\s*$') {
        throw 'Stock administrators Match block missing; refusing to invent a different SSH policy'
    }
    if ($updated -match '(?im)^\s*PasswordAuthentication\s+(?!no\s*$)') { throw 'A Match block enables password authentication; inspect sshd_config' }
    $configChanged = $updated -ne $original
    if ($configChanged) {
        [IO.File]::WriteAllText($config, $updated, [Text.UTF8Encoding]::new($false))
        Report 'CHANGED' 'sshd_config: public key only; stock administrators Match preserved'
    } else { Report 'OK' 'sshd_config public key only' }
    & (Join-Path (Split-Path $sshd -Parent) 'ssh-keygen.exe') -A
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSH host key generation failed' }
    # sshd (SYSTEM) rejects private host keys owned by tb.
    foreach ($hostKey in @(Get-ChildItem -LiteralPath $sshDir | Where-Object Name -match '^ssh_host_\w+_key$')) { Admin-Acl $hostKey.FullName $false }
    Report 'OK' 'OpenSSH host keys present; private keys Administrators and SYSTEM only'
    & $sshd -t -f $config
    if ($LASTEXITCODE -ne 0) { throw 'sshd_config validation failed' }

    $key = [IO.File]::ReadAllText((Join-Path $stage 'windows-vm-agent.pub')).Trim()
    if ($key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?:\s[^\r\n]*)?$') { throw 'Invalid staged ed25519 public key' }
    $authorized = Join-Path $sshDir 'administrators_authorized_keys'
    $keys = if (Test-Path $authorized) { @(Get-Content -LiteralPath $authorized) } else { @() }
    if ($key -notin $keys) {
        [IO.File]::WriteAllLines($authorized, @($keys) + $key, [Text.UTF8Encoding]::new($false))
        Report 'CHANGED' 'agent key authorized'
    } else { Report 'OK' 'agent key already authorized' }
    Admin-Acl $authorized $false
    Report 'OK' 'administrators_authorized_keys ACL: Administrators and SYSTEM only'
    Set-Service sshd -StartupType Automatic
    if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd; Report 'CHANGED' 'sshd started (Automatic)' }
    elseif ($configChanged) { Restart-Service sshd; Report 'CHANGED' 'sshd restarted for config changes (Automatic)' }
    else { Report 'OK' 'sshd Running (Automatic)' }

    $rule = Get-NetFirewallRule -Name 'win-vm-ssh' -ErrorAction SilentlyContinue
    $validRule = $false
    if ($rule) {
        $port = $rule | Get-NetFirewallPortFilter
        $address = $rule | Get-NetFirewallAddressFilter
        $app = $rule | Get-NetFirewallApplicationFilter
        $validRule = ($rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and
            $port.Protocol -eq 'TCP' -and @($port.LocalPort).Count -eq 1 -and $port.LocalPort -eq '22' -and
            $address.RemoteAddress -eq 'Any' -and $app.Program -eq 'Any')
    }
    if (!$validRule) {
        if ($rule) { $rule | Remove-NetFirewallRule }
        New-NetFirewallRule -Name 'win-vm-ssh' -DisplayName 'win-vm SSH (TCP 22)' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 22 -Profile Any | Out-Null
        Report 'CHANGED' 'firewall win-vm-ssh TCP 22 only'
    } else { Report 'OK' 'firewall win-vm-ssh TCP 22 only' }
    foreach ($other in @(Get-NetFirewallRule -Direction Inbound -Action Allow | Where-Object { $_.Name -ne 'win-vm-ssh' -and ($_.Name -match '(?i)openssh|sshd' -or $_.DisplayName -match '(?i)openssh|sshd') })) {
        $port = $other | Get-NetFirewallPortFilter
        if ($port.Protocol -eq 'Any' -or ($port.Protocol -eq 'TCP' -and (@($port.LocalPort).Count -ne 1 -or $port.LocalPort -ne '22'))) {
            $other | Disable-NetFirewallRule
            Report 'CHANGED' "disabled broader SSH firewall rule $($other.Name)"
        }
    }

    $runtime = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    if (!$runtime -or $runtime.Installed -ne 1) {
        Invoke-AsSystem 'vc_redist' "$artifacts\vc_redist.x64.exe" "/install /quiet /norestart /log `"$root\vc_redist.log`"" @(0, 1638, 3010, 1641)
        $runtime = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
        if ($runtime.Installed -ne 1) { throw 'VC++ x64 runtime install did not register Installed=1' }
        Report 'CHANGED' 'VC++ x64 runtime installed'
    } else { Report 'OK' "VC++ x64 runtime installed ($($runtime.Version))" }

    $winappDir = 'C:\Program Files\winapp'
    $stamp = Join-Path $winappDir '.win-vm-sha256'
    $zipHash = $pins.'winappcli-x64.zip'
    if (!(Test-Path "$winappDir\winapp.exe") -or !(Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $zipHash) {
        Expand-Archive -LiteralPath "$artifacts\winappcli-x64.zip" -DestinationPath $winappDir -Force
        [IO.File]::WriteAllText($stamp, $zipHash)
        Report 'CHANGED' 'WinApp CLI v0.7.1 extracted'
    } else { Report 'OK' 'WinApp CLI v0.7.1 already extracted' }
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if ($winappDir -notin @($machinePath.Split(';') | ForEach-Object { $_.TrimEnd('\') })) {
        [Environment]::SetEnvironmentVariable('Path', ($machinePath.TrimEnd(';') + ';' + $winappDir), 'Machine')
        Report 'CHANGED' 'WinApp CLI machine PATH'
    } else { Report 'OK' 'WinApp CLI machine PATH' }
    if ([Environment]::GetEnvironmentVariable('WINAPP_CLI_TELEMETRY_OPTOUT', 'Machine') -ne '1') {
        [Environment]::SetEnvironmentVariable('WINAPP_CLI_TELEMETRY_OPTOUT', '1', 'Machine')
        Report 'CHANGED' 'WinApp CLI machine telemetry opt-out'
    } else { Report 'OK' 'WinApp CLI machine telemetry opt-out' }
    $env:WINAPP_CLI_TELEMETRY_OPTOUT = '1'
    $version = & "$winappDir\winapp.exe" --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "winapp --version failed: $version" }
    Report 'OK' "winapp --version: $version"

    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    $login = Get-ItemProperty $winlogon -Name AutoAdminLogon,DefaultUserName,AutoLogonCount -ErrorAction SilentlyContinue
    if ($login.AutoAdminLogon -ne '1' -or $login.DefaultUserName -ine 'tb') { throw 'Autologon is not configured for tb (AutoAdminLogon=1, DefaultUserName=tb). Configure it manually; this bootstrap never stores a password.' }
    if ($null -ne $login.AutoLogonCount) {
        Remove-ItemProperty $winlogon -Name AutoLogonCount
        Report 'CHANGED' 'removed AutoLogonCount limit'
    } else { Report 'OK' 'tb autologon configured without count limit' }

    if ((Get-TimeZone).Id -ne 'UTC') {
        Set-TimeZone -Id 'UTC'
        Report 'CHANGED' 'system time zone UTC'
    } else { Report 'OK' 'system time zone UTC' }

    Set-RegistryValue 'HKCU:\Control Panel\Keyboard' 'InitialKeyboardIndicators' '0' 'String'
    Set-RegistryValue 'Registry::HKEY_USERS\.DEFAULT\Control Panel\Keyboard' 'InitialKeyboardIndicators' '0' 'String'

    $uiLanguage = Get-WinUILanguageOverride
    if (!$uiLanguage) { $uiLanguage = Get-UICulture }
    if ($uiLanguage.Name -ne 'da-DK' -and $uiLanguage.Name -notlike 'en-*') { throw "Unsupported display language $($uiLanguage.Name); refusing to change it for the Danish keyboard pin" }
    $languages = New-WinUserLanguageList -Language $uiLanguage.Name
    if ($uiLanguage.Name -ne 'da-DK') { $languages.Add('da-DK') }
    foreach ($language in $languages) {
        $language.InputMethodTips.Clear()
        if ($language.LanguageTag -eq 'da-DK') { $language.InputMethodTips.Add('0406:00000406') }
    }
    $currentLanguages = Get-WinUserLanguageList
    $languagesMatch = $currentLanguages.Count -eq $languages.Count
    for ($i = 0; $languagesMatch -and $i -lt $languages.Count; $i++) {
        $languagesMatch = $currentLanguages[$i].LanguageTag -eq $languages[$i].LanguageTag -and
            ($currentLanguages[$i].InputMethodTips -join ',') -eq ($languages[$i].InputMethodTips -join ',')
    }
    if (!$languagesMatch) {
        Set-WinUserLanguageList -LanguageList $languages -Force
        Report 'CHANGED' "tb language list: $($languages.LanguageTag -join ', '); only input 0406:00000406; display language $($uiLanguage.Name) preserved"
    } else { Report 'OK' "tb language list: only input 0406:00000406; display language $($uiLanguage.Name) preserved" }
    if ((Get-WinDefaultInputMethodOverride).InputMethodTip -ne '0406:00000406') {
        Set-WinDefaultInputMethodOverride -InputTip '0406:00000406'
        Report 'CHANGED' 'tb default input method 0406:00000406'
    } else { Report 'OK' 'tb default input method 0406:00000406' }

    foreach ($keyboard in @('HKCU:\Keyboard Layout', 'Registry::HKEY_USERS\.DEFAULT\Keyboard Layout')) {
        Set-RegistryValue "$keyboard\Preload" '1' '00000406' 'String'
        Remove-OtherPreloadValues "$keyboard\Preload"
        foreach ($setting in @('Substitutes', 'Toggle')) {
            $path = "$keyboard\$setting"
            if (!(Test-Path $path)) { Report 'OK' "$path absent; left alone"; continue }
            $key = Get-Item -Path $path
            $names = @($key.GetValueNames())
            if ($names.Count -eq 0) { Report 'OK' "$path empty; left alone" }
            foreach ($name in $names) {
                $value = $key.GetValue($name)
                if ($setting -eq 'Substitutes' -and $name -eq '00000406' -and $value -ne '00000406') {
                    Remove-ItemProperty -Path $path -Name $name
                    Report 'CHANGED' "removed $path\$name = $value; redirected Danish to another layout"
                } else { Report 'OK' "$path\$name = $value preserved; only Danish is preloaded" }
            }
        }
    }

    foreach ($setting in @('monitor-timeout-ac', 'standby-timeout-ac', 'hibernate-timeout-ac')) {
        & powercfg.exe /change $setting 0
        if ($LASTEXITCODE -ne 0) { throw "powercfg $setting failed" }
    }
    & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
    if ($LASTEXITCODE -ne 0) { throw 'powercfg console lock failed' }
    & powercfg.exe /setactive SCHEME_CURRENT
    if ($LASTEXITCODE -ne 0) { throw 'powercfg activation failed' }
    Report 'OK' 'AC display, standby and hibernate timeouts disabled; no lock on resume'
    $userDesktop = 'HKCU:\Control Panel\Desktop'
    Set-RegistryValue $userDesktop 'ScreenSaveActive' '0'
    Set-RegistryValue $userDesktop 'ScreenSaverIsSecure' '0'
    Set-RegistryValue 'HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop' 'ScreenSaveActive' '0'
    Set-RegistryValue 'HKCU:\Software\Policies\Microsoft\Windows\Control Panel\Desktop' 'ScreenSaverIsSecure' '0'
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($sessionId -eq 0) { throw 'Bootstrap must run in tb interactive session, not over SSH' }
    Report 'OK' "bootstrap complete; transferring tb session $sessionId to unlocked console (RDP will close)"
    Save-Log
    $success = $true
} catch {
    Report 'FAIL' ($_ | Out-String).Trim()
    try { Save-Log } catch { Write-Host "FAIL could not save bootstrap log: $_" }
}
if (!$success) { exit 1 }
try {
    Invoke-AsSystem 'console-handoff' 'tscon.exe' "$sessionId /dest:console" @(0)
} catch {
    Report 'FAIL' ($_ | Out-String).Trim()
    Save-Log
    exit 1
}
