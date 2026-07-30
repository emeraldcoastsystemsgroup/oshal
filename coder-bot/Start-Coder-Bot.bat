@echo off
REM ============================================================================
REM  CHANGE LOG
REM  ---------------------------------------------------------------------------
REM  SEQ                 | AUTHOR                      | DESCRIPTION
REM  ---------------------------------------------------------------------------
REM  1 | maintainer@emeraldcoastsystemsgroup.com   | Double-click start button for Coder Bot. It cd's to its own directory first because a shortcut can be invoked from anywhere and the relative require paths would otherwise fail, and it pauses on a non-zero exit so the reason (no Node, no Codex CLI) stays readable instead of the console vanishing.
REM ============================================================================
setlocal
cd /d "%~dp0"
node bin\coder-bot.js
if errorlevel 1 (
  echo.
  echo Coder Bot could not start. Make sure Node.js and the Codex CLI are installed.
  pause
)
