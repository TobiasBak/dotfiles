@echo off
setlocal

set "BOOTSTRAP_DIR=%ProgramData%\OipVmBootstrap"
if not exist "%BOOTSTRAP_DIR%" mkdir "%BOOTSTRAP_DIR%"

copy /y "%~dp0provision.ps1" "%BOOTSTRAP_DIR%\provision.ps1" >nul
if errorlevel 1 exit /b 1
copy /y "%~dp0oip_windows_vm.pub" "%BOOTSTRAP_DIR%\oip_windows_vm.pub" >nul
if errorlevel 1 exit /b 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP_DIR%\provision.ps1" -InstallTask
exit /b %errorlevel%
