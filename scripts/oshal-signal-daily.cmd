@echo off
REM Daily signal-dataset maintenance — label matured forward returns, then print the mining read.
REM Runs after the US close so eod/1d/3d/5d horizons for prior days are settled. Registered as the
REM "OSHAL Signal Labeler" scheduled task; mirrors the monitor-loop pattern. Logs append for history.
cd /d C:\Projects\open-shal-swarm-harness-agent-llm
echo ==== %DATE% %TIME% ==== >> data\_extracted\signal-daily.log
node scripts\oshal-signal-label.js >> data\_extracted\signal-daily.log 2>&1
node scripts\oshal-signal-mine.js fwd_ret_1d >> data\_extracted\signal-daily.log 2>&1
node scripts\oshal-signal-mine.js fwd_ret_eod >> data\_extracted\signal-daily.log 2>&1
node scripts\oshal-signal-mine.js fwd_ret_3d >> data\_extracted\signal-daily.log 2>&1
