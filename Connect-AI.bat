@echo off
REM ============================================================================
REM  CHANGE LOG
REM  ---------------------------------------------------------------------------
REM  SEQ                 | AUTHOR                      | DESCRIPTION
REM  ---------------------------------------------------------------------------
REM  1 | maintainer@emeraldcoastsystemsgroup.com   | The AI login button. Double-click to sign in to Claude / ChatGPT (Codex) / Gemini.
REM ============================================================================
REM
REM  Double-click this to connect your AI account. A browser opens; you approve;
REM  the swarm then runs on YOUR Claude/ChatGPT subscription instead of the
REM  keyless echo demo.
REM
REM  This runs the vendor's OWN login (claude auth login / codex login) in this
REM  window -- we never handle your password or broker your token; the login is
REM  the same one the Claude Code / Codex CLIs use, and the credential it writes
REM  (~/.claude, ~/.codex) is what the bots read. It must run here on your PC,
REM  not inside a container, because the browser sign-in returns to this machine.

setlocal
cd /d "%~dp0"

if not exist "installer\lib\install-swarm.ps1" (
    echo.
    echo   [x] installer\lib\install-swarm.ps1 is missing.
    echo       Run this from inside the folder you downloaded.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "installer\lib\install-swarm.ps1" -ConnectOnly

echo.
pause
endlocal
