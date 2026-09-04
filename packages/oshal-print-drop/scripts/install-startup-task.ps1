# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - registers a logon scheduled task so the printer starts automatically after a reboot: cmd.exe wrapper appends the JSON logs to logs\print-drop.log next to the package (scheduled tasks discard stdout otherwise). Registration is VERIFIED after creation (Get-ScheduledTask) instead of trusting the cmdlet's silence, and everything stays ASCII. Run from an elevated PowerShell; -Remove unregisters.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | -AtStartup: register a MACHINE-level task that runs as SYSTEM at boot, whether or not anyone signs in. The logon task is right for a personal print-to-file printer and wrong for a print SERVER on a node: a machine nobody has logged into yet was simply not printing, and the failure looks like the printer is broken rather than not started. -AtStartup demands an explicit -DropDir, because SYSTEM's profile is not a person's folder and defaulting there would silently file documents somewhere nobody looks. It also refuses to register a swarm-target printer with no credential in the machine environment - a print server that cannot deliver is the exact silent failure this package keeps trying to avoid.
#
# Usage (elevated PowerShell):
#   .\install-startup-task.ps1                      # per-user, starts at logon
#   .\install-startup-task.ps1 -AtStartup -DropDir C:\ProgramData\oshal-print-drop
#                                                   # machine-level, starts at boot as SYSTEM
#   .\install-startup-task.ps1 -Remove
param(
    [switch] $Remove,
    [switch] $AtStartup,
    [string] $DropDir,
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

# A machine-level task runs as SYSTEM, so two defaults that are fine for a person
# become traps: the drop folder would land in SYSTEM's profile where nobody looks,
# and a swarm-target printer would start with no credential and quietly fail every
# delivery. Refuse both rather than register something that looks installed.
$extraArgs = ''
if ($AtStartup) {
    if (-not $DropDir) {
        throw '-AtStartup needs -DropDir: running as SYSTEM, the default drop folder would be SYSTEM''s profile, where nobody would look for a printed document.'
    }
    if (-not (Test-Path $DropDir)) { New-Item -ItemType Directory -Path $DropDir -Force | Out-Null }
    $extraArgs = ' --dir "' + $DropDir + '"'

    $configPath = Join-Path $packageDir 'print-drop.config.json'
    $wantsSwarm = $env:OSHAL_PRINT_TARGET -eq 'swarm'
    if (-not $wantsSwarm -and (Test-Path $configPath)) {
        try { $wantsSwarm = ((Get-Content $configPath -Raw | ConvertFrom-Json).target -eq 'swarm') } catch { }
    }
    if ($wantsSwarm) {
        $machineToken = [Environment]::GetEnvironmentVariable('OSHAL_PRINT_INTAKE_TOKEN', 'Machine')
        if (-not $machineToken) {
            throw 'This is a swarm-target printer, but OSHAL_PRINT_INTAKE_TOKEN is not set in the MACHINE environment. A task running as SYSTEM cannot see your user environment, so it would start and fail every delivery. Set it with: setx OSHAL_PRINT_INTAKE_TOKEN "<token>" /M'
        }
    }
}

$cmdArg = '/c ""' + $nodeExe + '" "' + $entry + '"' + $extraArgs + ' >> "' + $logFile + '" 2>&1"'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmdArg -WorkingDirectory $packageDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}

if ($AtStartup) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
}

# schtasks-style registration can fail silently - verify the task really exists.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$who = if ($AtStartup) { 'SYSTEM at boot (no sign-in required)' } else { "$env:USERNAME at logon" }
Write-Host "Task '$TaskName' registered (state: $($task.State))."
Write-Host "Runs as: $who"
Write-Host "Logs append to $logFile"
if ($AtStartup) { Write-Host "Drop folder: $DropDir" }
Write-Host 'Note: a manually started npm-start instance and the task instance fight over the port - the loser logs EADDRINUSE and exits. Use one or the other.'
