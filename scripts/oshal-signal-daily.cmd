@echo off
REM ===========================================================================
REM Daily signal-dataset maintenance - label matured forward returns, then print
REM the mining read. Runs after the US close so the eod/1d/3d/5d horizons for
REM prior days are settled. Registered as the "OSHAL Signal Labeler" scheduled
REM task (scripts\register-signal-labeler.ps1); mirrors the monitor-loop
REM pattern. Logs append for history.
REM
REM ASCII only - Windows schtasks silently fails on non-ASCII .cmd files (see
REM memory: windows-detached-process-gotchas).
REM
REM Run from THIS checkout (kalshi-forward-daily.cmd pattern, ADR-115). The
REM hardcoded pre-cutover path meant every labeler/miner change landed in the
REM trunk was silently never run: the archive's oshal-signal-label.js has since
REM diverged from the trunk's by hundreds of lines. cwd also decides which .env
REM dotenv reads, so it must be the checkout the task was registered from.
REM ===========================================================================
setlocal
cd /d %~dp0..

set LOGDIR=%~dp0..\data\_extracted
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOG=%LOGDIR%\signal-daily.log

echo ==== %DATE% %TIME% ==== >> "%LOG%"
node scripts\oshal-signal-label.js >> "%LOG%" 2>&1
node scripts\oshal-signal-mine.js fwd_ret_1d >> "%LOG%" 2>&1
node scripts\oshal-signal-mine.js fwd_ret_eod >> "%LOG%" 2>&1
node scripts\oshal-signal-mine.js fwd_ret_3d >> "%LOG%" 2>&1
endlocal
