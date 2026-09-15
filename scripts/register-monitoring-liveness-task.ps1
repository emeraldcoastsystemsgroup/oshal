<#
  register-monitoring-liveness-task.ps1 - register the unattended monitoring-liveness watch.

  The BUG-21 tail is not that the assertion is missing - monitoring-liveness-check.sh --strict
  has existed since 2026-08-14 - it is that nothing RAN it unless a human ran oshal-up.sh. This
  registers the Windows scheduled task that does, pointing at the launcher sitting NEXT TO this
  script. That is the whole point of deriving the path instead of typing one: the ADR-115 trunk
  cutover left several nightly tasks pointing at the private archive, and a task that judges a
  checkout nobody commits to is worse than no task.

  Register (from the checkout you want watched):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-monitoring-liveness-task.ps1

  Inspect what it WOULD register, touching nothing:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-monitoring-liveness-task.ps1 -DryRun

  Remove it:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-monitoring-liveness-task.ps1 -Remove

  The task is observation only. monitoring-liveness-watch.sh never starts the Docker engine and
  never starts a container; it runs the strict check and routes a confirmed failure to the alert
  rail. ASCII-only on purpose (PS 5.1 mangles non-ASCII).

  CHANGE LOG
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - self-locating registration/removal of the OSHAL Monitoring Liveness task, with a -DryRun that prints the exact action without touching Task Scheduler.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'OSHAL Monitoring Liveness',
  [ValidateRange(1, 1439)]
  [int]$EveryMinutes = 5,
  [switch]$DryRun,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$launcher = Join-Path $PSScriptRoot 'monitoring-liveness-watch-hidden.vbs'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  Write-Error "launcher missing at $launcher - run this from the scripts/ directory of a real checkout"
  exit 2
}

# wscript (not cscript) so nothing is attached to a console; //B suppresses script errors and
# prompts, which a task with no interactive session can never answer.
$action = 'wscript.exe //B //Nologo "' + $launcher + '"'

if ($Remove) {
  schtasks /delete /tn $TaskName /f
  exit $LASTEXITCODE
}

if ($DryRun) {
  Write-Output "task: $TaskName"
  Write-Output "every: $EveryMinutes minute(s)"
  Write-Output "action: $action"
  exit 0
}

schtasks /create /tn $TaskName /sc minute /mo $EveryMinutes /f /tr $action
if ($LASTEXITCODE -ne 0) {
  Write-Error "schtasks /create failed with exit $LASTEXITCODE"
  exit $LASTEXITCODE
}
Write-Output "registered '$TaskName' every $EveryMinutes minute(s) against $launcher"
Write-Output "log: $env:LOCALAPPDATA\oshal\monitoring-liveness-watch.log"
exit 0
