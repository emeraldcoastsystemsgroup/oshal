# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - Claude OAuth token keepalive (BACKLOG 2026-07-09). The host is the token OWNER: ~/.claude is bind-mounted READ-ONLY into every container, so containers cannot self-refresh; the ~8h access token only refreshed while a host Claude Code session happened to be active, and idle/overnight gaps 401-escalated every claude-code bot (17 task + 43 build tickets). This script runs as a scheduled task every 2h: if the token has under 5h left, it runs one minimal `claude -p ok` on the host, which refreshes the token in place; the ro-mounted file propagates to all containers instantly. Register with: scripts\register-claude-token-keepalive.ps1
# =============================================================================
#
# Pure ASCII on purpose (repo convention for .ps1). Windows PowerShell 5.1 safe.

$ErrorActionPreference = 'Stop'

$credPath = Join-Path $env:USERPROFILE '.claude\.credentials.json'
$logPath  = Join-Path $env:USERPROFILE '.claude\keepalive.log'

function Write-Log([string]$msg) {
  $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $logPath -Value $line -Encoding utf8
}

# Keep the log from growing unbounded (trim to last 200 lines).
if (Test-Path $logPath) {
  $lines = Get-Content $logPath
  if ($lines.Count -gt 400) { $lines | Select-Object -Last 200 | Set-Content $logPath -Encoding utf8 }
}

if (-not (Test-Path $credPath)) { Write-Log 'SKIP: no credentials file'; exit 0 }

function Get-ExpiresAtMs {
  $cred = Get-Content $credPath -Raw | ConvertFrom-Json
  return [long]$cred.claudeAiOauth.expiresAt
}

$nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
$expMs = Get-ExpiresAtMs
$hoursLeft = [math]::Round((($expMs - $nowMs) / 3600000.0), 2)

if ($hoursLeft -gt 5) { Write-Log ('OK: token has {0}h left - nothing to do' -f $hoursLeft); exit 0 }

Write-Log ('REFRESH: token has {0}h left - running the refresh grant' -f $hoursLeft)

# Direct refresh_token grant (scripts/claude-token-refresh.js — same endpoint + client
# id the platform's claude-code-auth-service uses). NOT `claude -p`: the CLI only
# refreshes a token it finds EXPIRED, so a minimal turn on a still-valid token is a
# no-op and idle gaps would still 401 the containers for up to one task interval.
$node = $null
try { $node = (Get-Command node -ErrorAction Stop).Source } catch {}
if (-not $node) {
  foreach ($candidate in @('C:\Program Files\nodejs\node.exe', (Join-Path $env:APPDATA 'nvm\current\node.exe'))) {
    if (Test-Path $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { Write-Log 'FAIL: node not found on PATH or known locations'; exit 1 }

$refreshScript = Join-Path $PSScriptRoot 'claude-token-refresh.js'
$out = cmd /c "`"$node`" `"$refreshScript`" 2>&1"
if ($LASTEXITCODE -ne 0) {
  Write-Log ('FAIL: refresh grant exited {0}: {1}' -f $LASTEXITCODE, ($out -join ' '))
  exit 1
}

$expAfterMs = Get-ExpiresAtMs
if ($expAfterMs -gt $expMs) {
  $newHours = [math]::Round((($expAfterMs - $nowMs) / 3600000.0), 2)
  Write-Log ('REFRESHED: token now has {0}h left' -f $newHours)
} else {
  Write-Log 'WARN: claude turn ran but expiresAt did not advance - investigate'
}
exit 0
