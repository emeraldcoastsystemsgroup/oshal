@echo off
REM ===========================================================================
REM Kalshi forward test - daily loop (ASCII only; Windows schtasks silently
REM fails on non-ASCII .cmd files - see memory: windows-detached-process-gotchas)
REM
REM Order matters:
REM   1. GRADE first - settle yesterday's predictions and backfill observed
REM      highs. That is what grows the forecast-error model.
REM   2. FORWARD second - today's predictions are then priced with the sharpest
REM      error model available.
REM
REM The strategy stakes NOTHING until its sigma is measured rather than assumed.
REM ===========================================================================
setlocal
REM 2026-09-04: run from THIS checkout. The hardcoded pre-cutover path meant every grader/forward
REM change landed in the trunk was silently never run by the scheduled task.
cd /d %~dp0..

set LOGDIR=%~dp0..\output\kalshi
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f "tokens=1-3 delims=/ " %%a in ('date /t') do set TODAY=%%c-%%a-%%b
set LOG=%LOGDIR%\forward-%TODAY%.log

echo ============================================ >> "%LOG%"
echo [%date% %time%] kalshi forward-test daily run >> "%LOG%"

call npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-grade.ts >> "%LOG%" 2>&1
call npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-forward.ts >> "%LOG%" 2>&1

echo [%date% %time%] done >> "%LOG%"
endlocal
