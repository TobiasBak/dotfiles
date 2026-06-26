$ErrorActionPreference = "Stop"

$fontName = "Hack Nerd Font"
$fontRegistryPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
)

$installed = $fontRegistryPaths | Where-Object { Test-Path $_ } | ForEach-Object {
    $key = Get-Item $_
    $key.GetValueNames() | Where-Object { $_ -like "$fontName*" }
}

if ($installed) {
    Write-Host "$fontName is already installed."
    return
}

$downloadUrl = "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/Hack.zip"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("hack-nerd-font-" + [System.Guid]::NewGuid())
$zipPath = Join-Path $tempDir "Hack.zip"
$extractDir = Join-Path $tempDir "extract"
$fontsDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$registryPath = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"

New-Item -ItemType Directory -Force -Path $tempDir, $extractDir, $fontsDir | Out-Null

try {
    Write-Host "Downloading $fontName..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath

    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $fontFiles = Get-ChildItem -Path $extractDir -Recurse -File -Include "*.ttf" |
        Where-Object { $_.Name -like "HackNerdFont-*.ttf" -and $_.Name -notlike "*Mono*" -and $_.Name -notlike "*Propo*" }

    if (-not $fontFiles) {
        throw "No Hack Nerd Font TTF files found in the downloaded archive."
    }

    New-Item -Path $registryPath -Force | Out-Null

    foreach ($fontFile in $fontFiles) {
        $targetPath = Join-Path $fontsDir $fontFile.Name
        Copy-Item -LiteralPath $fontFile.FullName -Destination $targetPath -Force

        $registryName = switch -Wildcard ($fontFile.BaseName) {
            "HackNerdFont-Regular" { "Hack Nerd Font Regular (TrueType)" }
            "HackNerdFont-Bold" { "Hack Nerd Font Bold (TrueType)" }
            "HackNerdFont-Italic" { "Hack Nerd Font Italic (TrueType)" }
            "HackNerdFont-BoldItalic" { "Hack Nerd Font Bold Italic (TrueType)" }
            default { "$($fontFile.BaseName) (TrueType)" }
        }

        New-ItemProperty -Path $registryPath -Name $registryName -Value $fontFile.Name -PropertyType String -Force | Out-Null
        Write-Host "Installed $registryName"
    }

    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);'
    $result = [IntPtr]::Zero
    [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001D, [IntPtr]::Zero, "Fonts", 0x0002, 5000, [ref]$result) | Out-Null
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "$fontName installed. Restart WezTerm if it was already running."
