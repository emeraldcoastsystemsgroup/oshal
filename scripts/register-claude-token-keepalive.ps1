# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - registers (or re-registers, idempotent) the "OSHAL Claude token keepalive" scheduled task: every 2 hours run scripts\claude-token-keepalive.ps1 as the current user. Uses the ScheduledTasks module (no schtasks quoting pitfalls in PS 5.1). Remove with: Unregister-ScheduledTask -TaskName 'OSHAL Claude token keepalive' -Confirm:$false
# =============================================================================
# Pure ASCII on purpose (repo convention for .ps1). Windows PowerShell 5.1 safe.

$ErrorActionPreference = 'Stop'

$taskName = 'OSHAL Claude token keepalive'
$scriptPath = Join-Path $PSScriptRoot 'claude-token-keepalive.ps1'
if (-not (Test-Path $scriptPath)) { throw "keepalive script not found: $scriptPath" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $scriptPath)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Hours 2)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Output ('Registered "{0}": every 2 hours -> {1}' -f $taskName, $scriptPath)
Write-Output 'Log: %USERPROFILE%\.claude\keepalive.log'
Write-Output "Remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
