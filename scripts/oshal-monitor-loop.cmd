@echo off
REM ---------------------------------------------------------------------------
REM oshal-monitor-loop.cmd — run the live multi-algo monitor on an interval.
REM Loops oshal-monitor.js every MONITOR_INTERVAL_SEC (default 900s = 15 min),
REM accumulating the per-algorithm live track record in data\_extracted\predictions.json.
REM cd's to the repo root so the relative .env + data paths + require() resolve.
REM Usage:  scripts\oshal-monitor-loop.cmd  [SYM1,SYM2,...]
REM Schedule at login (every interval while the box is up):
REM   schtasks /Create /TN "OSHAL-Monitor" /TR "\"%CD%\scripts\oshal-monitor-loop.cmd\"" /SC ONLOGON /RL LIMITED
REM ---------------------------------------------------------------------------
cd /d "%~dp0\.."
if "%MONITOR_INTERVAL_SEC%"=="" set MONITOR_INTERVAL_SEC=900
echo [oshal-monitor-loop] every %MONITOR_INTERVAL_SEC%s  watch=%*  (Ctrl+C to stop)
:loop
node scripts\oshal-monitor.js %*
timeout /t %MONITOR_INTERVAL_SEC% /nobreak >nul
goto loop
