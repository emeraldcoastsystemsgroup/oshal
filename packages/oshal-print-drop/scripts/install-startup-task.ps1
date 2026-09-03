# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - registers a logon scheduled task so the printer starts automatically after a reboot: cmd.exe wrapper appends the JSON logs to logs\print-drop.log next to the package (scheduled tasks discard stdout otherwise). Registration is VERIFIED after creation (Get-ScheduledTask) instead of trusting the cmdlet's silence, and everything stays ASCII. Run from an elevated PowerShell; -Remove unregisters.
#
# Usage:
#   .\install-startup-task.ps1            # register + verify
#   .\install-startup-task.ps1 -Remove    # unregister
param(
    [switch] $Remove,
    [string] $TaskName = 'oshal-print-drop'
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' removed."
    exit 0
}

$packageDir = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $packageDir 'bin\print-drop.js'
if (-not (Test-Path $entry)) { throw "cannot find $entry - run this from the package's scripts folder" }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$logDir = Join-Path $packageDir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir 'print-drop.log'

$cmdArg = '/c ""' + $nodeExe + '" "' + $entry + '" >> "' + $logFile + '" 2>&1"'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArg -WorkingDirectory $packageDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null

# schtasks-style registration can fail silently - verify the task really exists.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host "Task '$TaskName' registered (state: $($task.State))."
Write-Host "The printer will start at every logon of $env:USERNAME; logs append to $logFile"
Write-Host 'Note: a manually started npm-start instance and the task instance fight over port 631 - the loser logs EADDRINUSE and exits. Use one or the other.'
