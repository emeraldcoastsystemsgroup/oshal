<#
  oshal-stack-watchdog.ps1 - INDEPENDENT host-side auto-recovery for a WEDGED Docker engine.

  Born from the recurring 2026-07-21 failure: Docker Desktop's Linux engine wedges (backend
  pegged at ~28k CPU-sec; every engine API route returns HTTP 500; docker CLI hangs; the api is
  dead on localhost AND 127.0.0.1). With the engine down, the jarvis + trading/finance/comms
  bot-nodes stop heartbeating, so the ADR-083 call-out has no owner to route to - which surfaces
  as "Jarvis can't answer / trading tickets don't reach the concierge". It was a manual fix every
  time (kill wedged procs -> wsl --shutdown -> restart Docker -> scripts/oshal-up.sh). This runs
  that recovery automatically, from a Windows scheduled task, OUTSIDE the containers so it survives
  the very wedge it heals. It mirrors trading-watchdog.ps1's conventions (state dir, log, event
  log, cooldown). ASCII-only on purpose (PS 5.1 mangles non-ASCII).

  Each run:
    1. Probe the docker engine with a HARD timeout. Outcomes: healthy | wedged (500/hung) | off.
    2. If healthy: probe the api (/api/health, 3 tries) and the routing-critical heartbeats.
       - all good            -> exit 0 (the common case; cheap).
       - api/heartbeats down  -> LIGHT recovery: scripts/oshal-up.sh only (no Docker restart).
    3. If wedged: FULL recovery - kill Docker Desktop + com.docker.backend/build, wsl --shutdown,
       restart Docker Desktop, wait for the engine, then scripts/oshal-up.sh.
    4. If off (cleanly stopped, not wedged): start Docker Desktop, wait, then scripts/oshal-up.sh
       (this box runs the stack 24/7; a pause file opts out - see below).

  Guard rails so it never thrashes or fights the operator:
    - Cooldown: at most one recovery per -CooldownMin (default 20). -Force bypasses it.
    - Lock file: a recovery in flight blocks a concurrent run (stale after 15 min).
    - Backoff: after 3 consecutive FAILED recoveries, the cooldown extends to 120 min.
    - Pause file: %LOCALAPPDATA%\oshal\stack-watchdog.pause present -> do nothing (operator opt-out).

  2026-07-21 16:26 revision: judge recovery success by the ACTUAL end state (Wait-Healthy) instead
  of intermediate return codes - the first live wedges (15:38 + 15:57) recovered fine but were
  logged as FAILED (Docker cold-start + oshal-up.sh both take minutes). Also: reset the failure
  counter on any healthy cycle so isolated slow recoveries can't accumulate to the 120m backoff,
  and raise the oshal-up.sh timeout 8m -> 15m (it now runs the routability guard too).

  2026-07-23 20:05 revision: self-locating (ADR-115 trunk cutover) - $Repo defaults to the repo
  this script lives in instead of a hardcoded checkout path, so the same file works from any
  checkout and the scheduled task follows wherever the trunk is.

  Register (every 5 min, windowless - launch through oshal-stack-watchdog-hidden.vbs so a bare
  powershell action doesn't flash a console every run):
    schtasks /create /tn "OSHAL Stack Watchdog" /sc minute /mo 5 /f ^
      /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\oshal-stack-watchdog-hidden.vbs"
#>
[CmdletBinding()]
param(
  # Default: the repo this script lives in (scripts/ -> repo root). Override for a nonstandard layout.
  [string]$Repo = '',
  [int]$EngineTimeoutSec = 25,
  [int]$CooldownMin = 20,
  [switch]$Force
)
$ErrorActionPreference = 'Continue'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }

$stateDir = Join-Path $env:LOCALAPPDATA 'oshal'
$logFile = Join-Path $stateDir 'oshal-stack-watchdog.log'
$stateFile = Join-Path $stateDir 'oshal-stack-watchdog-state.json'
$lockFile = Join-Path $stateDir 'oshal-stack-watchdog.lock'
$pauseFile = Join-Path $stateDir 'stack-watchdog.pause'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir | Out-Null }
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Add-Content $logFile; Write-Host $m }

if (Test-Path $pauseFile) { Log "paused (stack-watchdog.pause present) - skipping"; exit 0 }

# ---- state (last recovery time + consecutive-failure count) ----
$state = @{ lastRecovery = ''; consecutiveFailures = 0 }
if (Test-Path $stateFile) {
  try { (Get-Content $stateFile -Raw | ConvertFrom-Json).psobject.properties | ForEach-Object { $state[$_.Name] = $_.Value } } catch {}
}
function Save-State { ($state | ConvertTo-Json) | Set-Content $stateFile -Encoding ascii }

# ---- run a native exe with a hard timeout (docker version can HANG on a wedged engine) ----
function Invoke-Timed([string]$file, [string]$fileArgs, [int]$timeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $fileArgs
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  if (-not $p.WaitForExit($timeoutMs)) {
    try { $p.Kill() } catch {}
    return @{ Exited = $false; ExitCode = -1; Out = ''; Err = 'timed out' }
  }
  return @{ Exited = $true; ExitCode = $p.ExitCode; Out = $p.StandardOutput.ReadToEnd(); Err = $p.StandardError.ReadToEnd() }
}

# ---- classify the docker engine: healthy | wedged | off ----
function Get-EngineState {
  $r = Invoke-Timed 'docker' "version --format `"{{.Server.Version}}`"" ($EngineTimeoutSec * 1000)
  if (-not $r.Exited) { return 'wedged' }                       # hung on the pipe = the classic wedge
  if ($r.ExitCode -eq 0 -and $r.Out.Trim()) { return 'healthy' }
  $err = ($r.Err + ' ' + $r.Out)
  if ($err -match '500 Internal Server Error|API version|Internal Server Error') { return 'wedged' }
  if ($err -match 'cannot find the file|cannot connect|the docker daemon|open //./pipe|denied|refused|No such') { return 'off' }
  return 'off'                                                  # unknown -> treat as off (start it), never as healthy
}

function Test-ApiUp {
  foreach ($try in 1..3) {
    try { if ((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 8 -UseBasicParsing).StatusCode -eq 200) { return $true } } catch {}
    if ($try -lt 3) { Start-Sleep -Seconds 3 }
  }
  return $false
}

# The routing-critical heartbeats, via the guard's own script (single source of truth). Returns
# $true when all critical bots are live. Best-effort: any docker/redis error -> treat as NOT ok.
function Test-Routable {
  $bash = Get-BashExe
  if (-not $bash) { return $true }   # can't check without bash; don't trigger recovery on that alone
  $repoFwd = $Repo.Replace('\', '/')
  $r = Invoke-Timed $bash "-lc `"cd '$repoFwd' && bash scripts/swarm-routability-check.sh`"" 60000
  return ($r.Exited -and $r.ExitCode -eq 0)
}

function Get-BashExe {
  foreach ($c in @('C:\Program Files\Git\bin\bash.exe', 'C:\Program Files (x86)\Git\bin\bash.exe')) { if (Test-Path $c) { return $c } }
  $g = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}

# Judge the TRUE end state after a recovery attempt: engine healthy AND api up AND all routing-
# critical bots heartbeating. Polls up to $maxSec so a slow Docker cold-start / bring-up (both
# legitimately take minutes) is given time to settle before we ever call the recovery a failure.
# This replaces trusting Restart-DockerEngine/Invoke-OshalUp return codes, which false-reported
# FAILED even when the stack actually came back (observed 2026-07-21 15:38 + 15:57).
function Wait-Healthy([int]$maxSec) {
  $deadline = (Get-Date).AddSeconds($maxSec)
  while ($true) {
    if ((Get-EngineState) -eq 'healthy' -and (Test-ApiUp) -and (Test-Routable)) { return $true }
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Seconds 15
  }
}

# ---- cooldown + lock ----
function In-Cooldown {
  if ($Force) { return $false }
  if (-not $state.lastRecovery) { return $false }
  $mins = 0
  try { $mins = ((Get-Date) - [datetime]$state.lastRecovery).TotalMinutes } catch { return $false }
  $window = if ([int]$state.consecutiveFailures -ge 3) { 120 } else { $CooldownMin }
  return ($mins -lt $window)
}
function Acquire-Lock {
  if (Test-Path $lockFile) {
    try { $age = ((Get-Date) - (Get-Item $lockFile).LastWriteTime).TotalMinutes } catch { $age = 999 }
    if ($age -lt 15) { return $false }   # a recovery is genuinely in flight
  }
  "$PID $(Get-Date -Format o)" | Set-Content $lockFile -Encoding ascii
  return $true
}
function Release-Lock { try { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } catch {} }

# ---- recovery primitives ----
function Restart-DockerEngine([bool]$killFirst) {
  if ($killFirst) {
    Log "killing wedged Docker processes"
    Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds 3
    Log "wsl --shutdown (tears down the wedged docker-desktop VM)"
    & wsl.exe --shutdown 2>&1 | Out-Null
    Start-Sleep -Seconds 4
  }
  $dd = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Log "starting Docker Desktop"; Start-Process -FilePath $dd } else { Log "Docker Desktop.exe not found at $dd"; return $false }
  for ($i = 1; $i -le 40; $i++) {
    if ((Get-EngineState) -eq 'healthy') { Log "engine healthy after ~$([int]($i*6))s"; return $true }
    Start-Sleep -Seconds 6
  }
  Log "engine did NOT come healthy within ~240s"
  return $false
}
function Invoke-OshalUp {
  $bash = Get-BashExe
  if (-not $bash) { Log "no bash.exe found - cannot run oshal-up.sh"; return $false }
  $repoFwd = $Repo.Replace('\', '/')
  Log "running scripts/oshal-up.sh"
  $r = Invoke-Timed $bash "-lc `"cd '$repoFwd' && bash scripts/oshal-up.sh`"" 900000
  if (-not $r.Exited) { Log "oshal-up.sh timed out (>15m)"; return $false }
  Log "oshal-up.sh exit=$($r.ExitCode)"
  return ($r.ExitCode -eq 0)
}

# ---- alert (best-effort email via the api container, like trading-watchdog) + event log ----
function Send-Alert([string]$subject, [string]$body) {
  try { if (Test-ApiUp) { docker exec oshal-local-api node /app/scripts/oshal-send-alert.js "$subject" "$body" 2>&1 | Out-Null } } catch {}
  try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('OSHAL-Watchdog')) { New-EventLog -LogName Application -Source 'OSHAL-Watchdog' }
    Write-EventLog -LogName Application -Source 'OSHAL-Watchdog' -EntryType Warning -EventId 1101 -Message $body
  } catch {}
}

# =========================== main ===========================
$engine = Get-EngineState
$needFull = $false; $needLight = $false; $reason = ''

switch ($engine) {
  'healthy' {
    if (-not (Test-ApiUp)) { $needLight = $true; $reason = 'engine healthy but api is DOWN' }
    elseif (-not (Test-Routable)) { $needLight = $true; $reason = 'api up but a routing-critical bot is NOT heartbeating' }
    else { Log "all healthy (engine + api + routing-critical bots)"; $state.consecutiveFailures = 0; Save-State; exit 0 }
  }
  'wedged' { $needFull = $true; $reason = 'docker engine is WEDGED (500/hung)' }
  'off'    { $needFull = $true; $reason = 'docker engine is OFF' }
}

Log "DETECTED: $reason"
if (In-Cooldown) { Log "in cooldown (last recovery $($state.lastRecovery), consecutiveFailures $($state.consecutiveFailures)) - not recovering this run"; exit 0 }
if (-not (Acquire-Lock)) { Log "another recovery is in flight (lock held) - skipping"; exit 0 }

try {
  if ($needFull) {
    $killFirst = ($engine -eq 'wedged')          # a cleanly-OFF engine needs no kill/wsl-shutdown
    Restart-DockerEngine $killFirst | Out-Null   # best-effort; success is judged by OUTCOME below
    if ((Get-EngineState) -eq 'healthy') { Invoke-OshalUp | Out-Null }
    else { Log "engine still not healthy after restart - skipping oshal-up.sh this run" }
  } elseif ($needLight) {
    Invoke-OshalUp | Out-Null
  }
} finally { Release-Lock }

# Judge success by the ACTUAL end state, not by intermediate return codes. A slow-but-working
# Docker restart / oshal-up.sh (both legitimately take minutes) must NOT be reported as a failure:
# a false failure emails a false alarm AND, after 3 of them, extends the cooldown to 120m and
# would suppress a REAL recovery. Give the stack up to 5 more minutes to settle, then check.
$ok = Wait-Healthy 300

$state.lastRecovery = (Get-Date).ToString('o')
if ($ok) {
  $state.consecutiveFailures = 0
  Log "RECOVERY SUCCEEDED ($reason)"
  Send-Alert 'OSHAL stack auto-recovered' ("The OSHAL stack was unhealthy ($reason) and the watchdog recovered it on $env:COMPUTERNAME. Cockpit: http://localhost:35457/cockpit/")
} else {
  $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
  Log "RECOVERY FAILED ($reason) - consecutiveFailures now $($state.consecutiveFailures)"
  Send-Alert 'OSHAL stack recovery FAILED' ("The OSHAL stack was unhealthy ($reason) and the watchdog could NOT recover it on $env:COMPUTERNAME (attempt $($state.consecutiveFailures)). Manual: kill Docker, 'wsl --shutdown', start Docker, then 'bash scripts/oshal-up.sh'.")
}
Save-State
exit 0
