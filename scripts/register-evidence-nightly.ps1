<#
  Register the nightly competitive-evidence refresh as a Windows Scheduled Task
  (market-remediation runbook, "Routine" section). Runs scripts/run-evidence-nightly.ps1 at 03:30
  daily, which sets COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS=26 and drives
  `npm run evidence:nightly` (headless prove-*-live.ts generators + score regeneration),
  logging to logs/evidence-nightly/<date>.log.

  03:30 was chosen to sit clear of the other OSHAL tasks (TestLab nightly 04:30,
  Daily Trade Recap 17:00). WakeToRun + StartWhenAvailable are set so a sleeping PC
  still runs it (or catches up on wake) -- same rationale as register-test-lab-nightly.ps1.

  NOTE: keep this file pure ASCII (PS 5.1 reads BOM-less .ps1 as ANSI; UTF-8 em-dash
  bytes decode to a CP-1252 curly quote that can terminate strings early).

  Usage:   powershell -ExecutionPolicy Bypass -File scripts/register-evidence-nightly.ps1
  Remove:  Unregister-ScheduledTask -TaskName 'OSHAL-Evidence-Nightly' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $repo 'scripts\run-evidence-nightly.ps1'
if (-not (Test-Path $wrapper)) { Write-Error "wrapper not found: $wrapper"; exit 1 }

$action = New-ScheduledTaskAction -Execute 'powershell' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30AM
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'OSHAL-Evidence-Nightly' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Nightly competitive-evidence refresh: re-run headless prove-*-live.ts generators and regenerate the 15-category score + procurement artifacts so the scoreboard does not decay to the 75-floor (48h freshness window; nightly keeps proofs <26h old).' `
  -Force | Out-Null

Write-Host "Registered scheduled task 'OSHAL-Evidence-Nightly' (daily 03:30, wakes the PC)."
Write-Host "Run now to test:  Start-ScheduledTask -TaskName 'OSHAL-Evidence-Nightly'"
Write-Host "Or directly:      powershell -ExecutionPolicy Bypass -File scripts/run-evidence-nightly.ps1"
Write-Host "Logs:             logs/evidence-nightly/<date>.log"
