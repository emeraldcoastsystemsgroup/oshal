@echo off
REM ============================================================================
REM  CHANGE LOG
REM  ---------------------------------------------------------------------------
REM  SEQ                 | AUTHOR                      | DESCRIPTION
REM  ---------------------------------------------------------------------------
REM  1 | maintainer@emeraldcoastsystemsgroup.com   | Launcher for the Open Swarm worker node. Target of the Desktop shortcut.
REM  2 | maintainer@emeraldcoastsystemsgroup.com   | The console title names the product as it is called today. The FILENAME keeps its form: it is the shortcut target an already-installed box points at, and CLAUDE.md grandfathers identifiers.
REM ============================================================================
REM
REM  Starts the Electron node app against its persisted config. It carries NO
REM  connection settings on purpose: install-node.ps1 seeds them on first launch,
REM  and after that the app's own settings pane is the source of truth.

title oshal Node
cd /d "%~dp0..\packages\oshal-chat"

where node >nul 2>nul
if errorlevel 1 (
    echo [x] Node.js is not on PATH. Re-run Install-OpenSwarm.bat to install it.
    pause
    exit /b 1
)

node scripts/start-electron.js .
