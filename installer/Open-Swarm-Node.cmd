@echo off
REM ============================================================================
REM  CHANGE LOG
REM  ---------------------------------------------------------------------------
REM  SEQ                 | AUTHOR                      | DESCRIPTION
REM  ---------------------------------------------------------------------------
REM  1 | maintainer@emeraldcoastsystemsgroup.com   | Launcher for the Open Swarm worker node. Target of the Desktop shortcut.
REM ============================================================================
REM
REM  Starts the Electron node app against its persisted config. It carries NO
REM  connection settings on purpose: install-node.ps1 seeds them on first launch,
REM  and after that the app's own settings pane is the source of truth.

title Open Swarm Node
cd /d "%~dp0..\packages\oshal-chat"

where node >nul 2>nul
if errorlevel 1 (
    echo [x] Node.js is not on PATH. Re-run Install-OpenSwarm.bat to install it.
    pause
    exit /b 1
)

node scripts/start-electron.js .
