@echo off
REM ============================================================================
REM  CHANGE LOG
REM  ---------------------------------------------------------------------------
REM  SEQ                 | AUTHOR                      | DESCRIPTION
REM  ---------------------------------------------------------------------------
REM  1 | maintainer@emeraldcoastsystemsgroup.com   | The install button. Double-click entry point that opens the graphical installer.
REM ============================================================================
REM
REM  Double-click this file. It opens a window that asks one question:
REM  should this computer RUN the swarm, or JOIN one?
REM
REM  There is nothing to type. Everything else -- Docker, Node.js, the build,
REM  the firewall rule, the join code -- is handled behind that choice.
REM
REM  Right-click -> "Run as administrator" if you want other computers on your
REM  network to be able to join this swarm (that needs a firewall rule).

setlocal
cd /d "%~dp0"

if not exist "installer\install.ps1" (
    echo.
    echo   [x] installer\install.ps1 is missing.
    echo       Run this from inside the folder you downloaded, not from a shortcut.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "installer\install.ps1"
if errorlevel 1 (
    echo.
    echo   The installer window closed with an error. Scroll up for details.
    pause
)

endlocal
