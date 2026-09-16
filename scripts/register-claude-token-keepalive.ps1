# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - registers (or re-registers, idempotent) the "OSHAL Claude token keepalive" scheduled task: every 2 hours run scripts\claude-token-keepalive.ps1 as the current user. Uses the ScheduledTasks module (no schtasks quoting pitfalls in PS 5.1). Remove with: Unregister-ScheduledTask -TaskName 'OSHAL Claude token keepalive' -Confirm:$false
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Register the WINDOWLESS launcher, not powershell.exe directly, and pin -WorkingDirectory to this checkout (register-store-publish-nightly.ps1 pattern). SEQ 1 registered a bare powershell action, which flashes a console host on the operator's desktop every 2 hours; the live task was therefore hand-edited to run claude-token-keepalive-hidden.vbs, and that hand-edit hardcoded the frozen ADR-115 archive path. Re-running SEQ 1 would have repointed the task at the trunk but reintroduced the popup. Registering the .vbs gives both, and makes the checkout self-evident from the action string.
# =============================================================================
# Pure ASCII on purpose (repo convention for .ps1). Windows PowerShell 5.1 safe.
#
# Usage:   powershell -ExecutionPolicy Bypass -File scripts/register-claude-token-keepalive.ps1
# Test:    Start-ScheduledTask -TaskName 'OSHAL Claude token keepalive'
# Remove:  Unregister-ScheduledTask -TaskName 'OSHAL Claude token keepalive' -Confirm:$false

$ErrorActionPreference = 'Stop'

$taskName = 'OSHAL Claude token keepalive'
$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $repo 'scripts\claude-token-keepalive-hidden.vbs'
$scriptPath = Join-Path $repo 'scripts\claude-token-keepalive.ps1'
if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }
if (-not (Test-Path $scriptPath)) { throw "keepalive script not found: $scriptPath" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
  -Argument ('//B //Nologo "{0}"' -f $launcher) `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Hours 2)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Output ('Registered "{0}": every 2 hours -> {1}' -f $taskName, $launcher)
Write-Output ('Runs:   {0}   (windowless, self-locating)' -f $scriptPath)
Write-Output 'Log: %USERPROFILE%\.claude\keepalive.log'
Write-Output "Remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
