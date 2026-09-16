@echo off
REM ============================================================================
REM  make-trade-report.cmd  -- batch tool: produce TODAY's real trade-recap video
REM  Chains the two host scripts the hollow in-container workflow stages never call:
REM    1) oshal-trade-data.js  -> pulls the REAL Alpaca paper day -> out/recap-data.json
REM    2) oshal-trade-recap.js -> build-daily-report.js -> graphical .pptx + narrated MP4
REM  Output: packages/oshal-vids-operator/out/oshal-report-<date>.mp4
REM  Optional arg %1 = a date the data script understands (yesterday | YYYY-MM-DD).
REM ============================================================================
setlocal
REM Run from THIS checkout (ADR-115). The hardcoded pre-cutover archive path made this batch tool
REM build its report from a tree frozen at the cutover commit, whichever checkout it was invoked from.
cd /d "%~dp0.."

echo [make-trade-report] killing any stray ffmpeg (file-lock trap)...
powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -like 'ffmpeg*' } | Stop-Process -Force -ErrorAction SilentlyContinue"

echo [make-trade-report] STEP 1/2 pulling Alpaca paper day -^> recap-data.json
node scripts\oshal-trade-data.js %1
if errorlevel 1 ( echo [make-trade-report] DATA_FAILED & exit /b 1 )

echo [make-trade-report] STEP 2/2 building deck + video (PowerPoint CreateVideo + ffmpeg)...
node scripts\oshal-trade-recap.js
if errorlevel 1 ( echo [make-trade-report] BUILD_FAILED & exit /b 1 )

echo [make-trade-report] DONE
endlocal
