@echo off
rem =============================================================================
rem Install-OSHAL.bat - the double-click Windows installer for the OSHAL swarm.
rem
rem Works two ways:
rem   1) Downloaded ALONE (from oshal.ai or GitHub): fetches the PowerShell
rem      installer from the public repo and runs it.
rem   2) Inside a checkout: runs the scripts\oshal-install.ps1 sitting beside it.
rem
rem Docker Desktop is the only prerequisite (the installer offers a winget
rem install when it is missing). ASCII-only on purpose (cmd.exe mangles UTF-8).
rem
rem CHANGE LOG
rem -----------------------------------------------------------------------------
rem 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - double-click entry over scripts/oshal-install.ps1; standalone mode fetches the ps1 from raw.githubusercontent.com so the ONE downloaded file is enough.
rem =============================================================================
setlocal
set "PS1=%~dp0scripts\oshal-install.ps1"
if exist "%PS1%" goto :run

set "PS1=%TEMP%\oshal-install.ps1"
echo Downloading the OSHAL installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal/main/scripts/oshal-install.ps1' -OutFile '%PS1%'"
if errorlevel 1 (
  echo Download failed. Check your internet connection and try again.
  pause
  exit /b 1
)

:run
rem Offline swarm snapshot: when oshal-images.tar sits beside this .bat (the
rem downloaded bundle layout), install from it — zero registry, zero internet.
set "ARCHIVE="
if exist "%~dp0oshal-images.tar" set "ARCHIVE=-FromArchive ""%~dp0oshal-images.tar"""

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %ARCHIVE% %*
echo.
pause
