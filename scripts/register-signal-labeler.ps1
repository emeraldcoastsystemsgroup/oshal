# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - registers (or re-registers, idempotent) the "OSHAL Signal Labeler" scheduled task through the self-locating windowless launcher. The task was hand-made on the box in June 2026 with the pre-cutover archive checkout typed into its action, so it has run a frozen tree since ADR-115 and no registrar existed to repoint it. Trigger, instance policy and execution-time limit are copied verbatim from the live task; only the checkout the action names changes.
# =============================================================================
# Pure ASCII on purpose (PS 5.1 reads BOM-less .ps1 as ANSI; UTF-8 em-dash bytes decode to a
# CP-1252 curly quote that can terminate strings early). Windows PowerShell 5.1 safe.
#
# WHAT IT RUNS: scripts\oshal-signal-daily-hidden.vbs -> scripts\oshal-signal-daily.cmd, which
# cd's to its own checkout and drives oshal-signal-label.js + oshal-signal-mine.js against the
# TSDB. cwd decides which .env dotenv reads, which is why the launcher must be self-locating.
#
# 16:30 daily is the live trigger and sits after the US close, so the eod/1d/3d/5d horizons for
# prior days are settled. ExecutionTimeLimit PT72H and MultipleInstances IgnoreNew are inherited
# from the hand-made task and deliberately left alone here - this registrar exists to move the
# checkout, not to re-tune the schedule.
#
# Usage:   powershell -ExecutionPolicy Bypass -File scripts/register-signal-labeler.ps1
# Test:    Start-ScheduledTask -TaskName 'OSHAL Signal Labeler'
# Remove:  Unregister-ScheduledTask -TaskName 'OSHAL Signal Labeler' -Confirm:$false

$ErrorActionPreference = 'Stop'

$taskName = 'OSHAL Signal Labeler'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'scripts\oshal-signal-daily-hidden.vbs'
$daily = Join-Path $repo 'scripts\oshal-signal-daily.cmd'
if (-not (Test-Path $launcher)) { Write-Error "launcher not found: $launcher"; exit 1 }
if (-not (Test-Path $daily)) { Write-Error "daily command not found: $daily"; exit 1 }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('//B //Nologo "{0}"' -f $launcher) `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 4:30PM
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 72) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Daily signal-dataset maintenance: label matured forward returns from world_metrics into trading_signal_labels, then print the mining read. Runs from the checkout this registrar was invoked from.' `
  -Force | Out-Null

Write-Output ('Registered "{0}": daily 16:30 -> {1}' -f $taskName, $launcher)
Write-Output ('Runs:   {0}   (windowless, self-locating)' -f $daily)
Write-Output ('Log:    {0}\data\_extracted\signal-daily.log' -f $repo)
Write-Output "Remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
