<#
  Register the AI Test Lab nightly golden loop as a Windows Scheduled Task (ADR-063 §nightly).
  Runs `node scripts/test-lab-nightly.mjs all` at 04:30 daily, which drives the headless golden
  loop, writes docs/test-lab-reports/<date>.md, and git-commits the report + baseline.

  WakeToRun + StartWhenAvailable are set so a sleeping PC still runs it (or catches up on wake) —
  the jobhunter nightly's known "sleep skips the task" failure mode is avoided here.

  Usage:   powershell -ExecutionPolicy Bypass -File scripts/register-test-lab-nightly.ps1
  Remove:  Unregister-ScheduledTask -TaskName 'OSHAL-TestLab-Nightly' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error 'node not found on PATH'; exit 1 }

$action  = New-ScheduledTaskAction -Execute $node -Argument 'scripts/test-lab-nightly.mjs all' -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 4:30AM
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'OSHAL-TestLab-Nightly' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'AI Test Lab nightly golden loop: run golden tickets through the swarm, grade vs expected, write + commit the morning report.' `
  -Force | Out-Null

Write-Host "Registered scheduled task 'OSHAL-TestLab-Nightly' (daily 04:30, wakes the PC)."
Write-Host "Run now to test:  Start-ScheduledTask -TaskName 'OSHAL-TestLab-Nightly'"
Write-Host "Or directly:      node scripts/test-lab-nightly.mjs all"
