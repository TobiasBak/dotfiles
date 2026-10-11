@echo off
setlocal
if /i "%~1"=="elevated" goto run
set "WIN_VM_BOOTSTRAP=%~f0"
powershell.exe -NoProfile -NonInteractive -Command "try { $q=[char]34; $args='/c '+$q+$q+$env:WIN_VM_BOOTSTRAP+$q+' elevated'+$q; Start-Process -FilePath $env:ComSpec -ArgumentList $args -Verb RunAs -ErrorAction Stop } catch { Write-Error $_; exit 1 }"
if errorlevel 1 pause
exit /b
:run
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1"
set "RESULT=%ERRORLEVEL%"
echo Bootstrap exit code: %RESULT%
if not "%RESULT%"=="0" pause
exit /b %RESULT%
