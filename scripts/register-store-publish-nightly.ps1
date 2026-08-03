<#
  Register the public app-store refresh as a Windows Scheduled Task ('OSHAL-Store-Publish').

  Runs scripts/publish-store-nightly.ps1 daily at 01:00 through the SELF-LOCATING hidden launcher,
  so the task can never drift onto another checkout. That matters here specifically: the sibling
  OSHAL-Evidence-Nightly task executes from the frozen ADR-115 archive, and its trunk .vbs
  hardcodes that same archive path -- which is how a nightly step can look wired and never run.
  Registering through the .vbs next to the .ps1 makes the checkout self-evident from the action.

  01:00 sits clear of the other OSHAL tasks (Evidence-Nightly 03:30, TestLab 04:30, Signal
  Labeler 16:30, Daily Trade Recap 17:00) and ahead of Evidence-Nightly, so a morning look at the
  board and a morning look at the store agree. WakeToRun + StartWhenAvailable so a sleeping PC
  still runs it or catches up on wake -- same rationale as register-evidence-nightly.ps1.

  The publish needs THIS box: the gitleaks gate runs in Docker and the push uses the operator's
  git credential helper. Neither exists on a GitHub runner, which is why this is not an Action --
  and Actions minutes are billed on the private store repo besides.

  NOTE: keep this file pure ASCII (PS 5.1 reads BOM-less .ps1 as ANSI; UTF-8 em-dash bytes decode
  to a CP-1252 curly quote that can terminate strings early).

  Usage:   powershell -ExecutionPolicy Bypass -File scripts/register-store-publish-nightly.ps1
  Test:    Start-ScheduledTask -TaskName 'OSHAL-Store-Publish'
  Remove:  Unregister-ScheduledTask -TaskName 'OSHAL-Store-Publish' -Confirm:$false
#>

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'scripts\publish-store-nightly-hidden.vbs'
$wrapper = Join-Path $repo 'scripts\publish-store-nightly.ps1'
if (-not (Test-Path $launcher)) { Write-Error "launcher not found: $launcher"; exit 1 }
if (-not (Test-Path $wrapper)) { Write-Error "wrapper not found: $wrapper"; exit 1 }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument "//B //Nologo `"$launcher`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 1:00AM
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'OSHAL-Store-Publish' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Nightly refresh of the PUBLIC app store (oshal-apps) from the oshal-applications trunk. The public store is a derived, gated, single-commit-per-refresh snapshot; the installer downloads it, so a stale store means every fresh install gets stale packages. Commits only when the cut differs from what is live.' `
  -Force | Out-Null

Write-Host "Registered scheduled task 'OSHAL-Store-Publish' (daily 01:00, wakes the PC)."
Write-Host "Action:    wscript.exe //B //Nologo $launcher   (self-locating)"
Write-Host "Test now:  Start-ScheduledTask -TaskName 'OSHAL-Store-Publish'"
Write-Host "Dry run:   powershell -ExecutionPolicy Bypass -File scripts/publish-store-nightly.ps1 -DryRun"
Write-Host "Logs:      logs/store-publish/<date>.log"
