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
    - Lock file: a recovery in flight blocks a concurrent run. A lock is eligible for stale-owner
      recovery after 35 min, but it is never stolen while its recorded PID is still alive.
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

  2026-08-03 revision: drain child output asynchronously, kill the full native process tree on
  timeout, hold an atomic recovery lock through final health verification, and confirm a missing
  routing heartbeat three times before running oshal-up.sh. Parent-only kills left orphaned
  oshal-up.sh children recreating the healthy api for hours; redirected pipes could deadlock a
  verbose healthy child; releasing the lock before Wait-Healthy admitted overlapping recoveries.
  Alert delivery now uses the same timed native runner after releasing the recovery lock, so a
  fresh Docker CLI stall cannot pin recovery ownership or hide Task Scheduler's real exit state.
  The lock age is 35 minutes because the worst legitimate engine restart + bring-up + settle path
  is about 24 minutes; the live-owner PID check remains authoritative beyond that age.

  CHANGE LOG (started 2026-08-05; earlier revisions remain described above and in Git)
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Bound native execution and alerting, drain redirected output, verify full process-tree termination, make recovery locking atomic and live-owner-aware, retain the lock through final health verification, confirm heartbeat failures before recovery, and expose the final watchdog result to Task Scheduler.
  2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve Git Bash through the shared bounded validator, reject System32/WSL launchers, and fail closed when no validated Bash can perform routing checks or recovery.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Stabilize the fallback process-tree snapshot across consecutive CIM reads and kill captured descendants before the root, preventing a failed taskkill from orphaning a child that was reparented before verification.
  4 | maintainer@emeraldcoastsystemsgroup.com   | Extend the bounded CIM union to three observations on each pre-kill pass so a newly visible descendant cannot escape the failed-taskkill fallback under host contention.

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
function Format-ErrorText($errorRecord) {
  if ($null -ne $errorRecord.Exception) { return $errorRecord.Exception.ToString() }
  return [string]$errorRecord
}

if (Test-Path $pauseFile) { Log "paused (stack-watchdog.pause present) - skipping"; exit 0 }

# A missing or unvalidated shell makes both the routability probe and recovery impossible. Resolve
# it once per watchdog run so a PATH-order change can never turn System32's WSL launcher into a
# false routability pass or a broken recovery command.
$bashResolver = Join-Path $PSScriptRoot 'lib\windows-git-bash.ps1'
if (-not (Test-Path -LiteralPath $bashResolver -PathType Leaf)) {
  Log "Git Bash resolver missing at $bashResolver - watchdog cannot verify or recover routing"
  exit 2
}
try { . $bashResolver }
catch { Log "Git Bash resolver failed to load: $(Format-ErrorText $_)"; exit 2 }
if ($null -eq (Get-Command Resolve-OshalGitBash -CommandType Function -ErrorAction SilentlyContinue)) {
  Log "Git Bash resolver did not define Resolve-OshalGitBash - watchdog cannot continue"
  exit 2
}
$script:gitBash = Resolve-OshalGitBash
if (-not $script:gitBash) {
  Log "no validated Git Bash found - refusing to treat routing as healthy or attempt recovery"
  exit 2
}

# ---- state (last recovery time + consecutive-failure count) ----
$state = @{ lastRecovery = ''; consecutiveFailures = 0 }
if (Test-Path $stateFile) {
  try { (Get-Content $stateFile -Raw | ConvertFrom-Json).psobject.properties | ForEach-Object { $state[$_.Name] = $_.Value } }
  catch { Log "state file is unreadable; using safe defaults: $(Format-ErrorText $_)" }
}
function Save-State { ($state | ConvertTo-Json) | Set-Content $stateFile -Encoding ascii }

# ---- run a native exe with a hard timeout (docker version can HANG on a wedged engine) ----
function Get-ProcessTreeIds([int]$rootProcessId) {
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($rootProcessId)
  if ($env:OS -ne 'Windows_NT') { return @($rootProcessId) }
  # WMI is a fallback inside an already-expired native call; cap it so cleanup cannot become the
  # next unbounded wait while Windows management instrumentation is degraded. A just-started child
  # can be absent from one provider snapshot, so union three bounded reads before closing the tree.
  $rowsById = @{}
  for ($snapshot = 0; $snapshot -lt 3; $snapshot++) {
    $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)
    foreach ($row in $rows) { $rowsById[[int]$row.ProcessId] = $row }
    if ($snapshot -lt 2) { Start-Sleep -Milliseconds 100 }
  }
  $frontier = @($rootProcessId)
  while ($frontier.Count -gt 0) {
    $next = @()
    foreach ($row in $rowsById.Values) {
      if ($frontier -notcontains [int]$row.ParentProcessId) { continue }
      $childId = [int]$row.ProcessId
      if ($ids.Add($childId)) { $next += $childId }
    }
    $frontier = $next
  }
  return @($ids | ForEach-Object { [int]$_ })
}
function Get-LiveProcessIds([int[]]$processIds) {
  $live = @()
  foreach ($processId in $processIds) {
    if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { $live += $processId }
  }
  return $live
}
function Wait-ProcessTreeStopped([int[]]$processIds, [int]$timeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  do {
    $live = @(Get-LiveProcessIds $processIds)
    if ($live.Count -eq 0) { return @() }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  return @(Get-LiveProcessIds $processIds)
}
function Invoke-TaskkillTree([int]$rootProcessId) {
  $taskkill = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'taskkill.exe'; $psi.Arguments = "/PID $rootProcessId /T /F"
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $taskkill = [System.Diagnostics.Process]::Start($psi)
    if (-not $taskkill.WaitForExit(5000)) {
      $taskkill.Kill(); [void]$taskkill.WaitForExit(2000)
      return @{ Ok = $false; Error = 'taskkill timed out' }
    }
    if ($taskkill.ExitCode -eq 0) { return @{ Ok = $true; Error = '' } }
    return @{ Ok = $false; Error = "taskkill exit $($taskkill.ExitCode)" }
  } catch { return @{ Ok = $false; Error = "taskkill failed: $(Format-ErrorText $_)" } }
  finally {
    if ($null -ne $taskkill) {
      try { $taskkill.Dispose() } catch { Log "taskkill process dispose failed: $(Format-ErrorText $_)" }
    }
  }
}
function Stop-TimedProcessTree($process) {
  $errors = @()
  $treeKnown = $true
  try { $treeIds = @(Get-ProcessTreeIds $process.Id) }
  catch { $treeKnown = $false; $treeIds = @($process.Id); $errors += "tree enumeration failed: $(Format-ErrorText $_)" }
  $taskkill = Invoke-TaskkillTree $process.Id
  $taskkillOk = $taskkill.Ok
  if (-not $taskkillOk) { $errors += $taskkill.Error }
  if (-not $taskkillOk) {
    try { $treeIds = @($treeIds + @(Get-ProcessTreeIds $process.Id) | Select-Object -Unique); $treeKnown = $true }
    catch { $errors += "fallback tree enumeration failed: $(Format-ErrorText $_)" }
  }
  # Kill captured descendants first. Killing the root first reparents them and makes a missed/stale
  # CIM relationship impossible to recover after taskkill has already failed.
  $killOrder = @($treeIds | Where-Object { $_ -ne $process.Id }) + @($process.Id)
  foreach ($processId in @(Get-LiveProcessIds $killOrder)) {
    try { Stop-Process -Id $processId -Force -ErrorAction Stop }
    catch {
      if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        $errors += "fallback kill $processId failed: $(Format-ErrorText $_)"
      }
    }
  }
  $survivors = @(Wait-ProcessTreeStopped $treeIds 5000)
  if ($survivors.Count -gt 0) { $errors += "process tree cleanup incomplete; live PIDs: $($survivors -join ',')" }
  if (-not $taskkillOk -and -not $treeKnown) { $errors += 'process tree cleanup could not be verified' }
  return @{ Stopped = ($survivors.Count -eq 0 -and ($taskkillOk -or $treeKnown)); Errors = $errors }
}
function Invoke-Timed([string]$file, [string]$fileArgs, [int]$timeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $fileArgs
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  # Begin BOTH reads before waiting. Waiting first can deadlock once either redirected pipe fills,
  # which made a verbose but healthy oshal-up.sh look hung and triggered an unnecessary tree kill.
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutMs)) {
    # Snapshot descendants before taskkill; if /T fails or races parent exit, kill the snapshot
    # directly and verify every PID is gone before claiming cleanup completed.
    $cleanup = Stop-TimedProcessTree $p
    $rootExited = $p.WaitForExit(5000)
    if (-not $rootExited) { $cleanup.Stopped = $false; $cleanup.Errors += 'root process handle did not signal exit' }
    $timedOutOut = if ($outTask.IsCompleted) { $outTask.GetAwaiter().GetResult() } else { '' }
    $timedOutErr = if ($errTask.IsCompleted) { $errTask.GetAwaiter().GetResult() } else { '' }
    try { $p.Dispose() } catch { $cleanup.Errors += "process dispose failed: $(Format-ErrorText $_)" }
    $details = @($timedOutErr, 'timed out') + $cleanup.Errors
    return @{ Exited = $false; ExitCode = -1; TreeStopped = $cleanup.Stopped; Out = $timedOutOut; Err = (($details | Where-Object { $_ }) -join '; ').Trim() }
  }
  # The parameterless wait flushes async output events after the timed wait has observed exit.
  $p.WaitForExit()
  $exitCode = $p.ExitCode
  $stdout = $outTask.GetAwaiter().GetResult()
  $stderr = $errTask.GetAwaiter().GetResult()
  $p.Dispose()
  return @{ Exited = $true; ExitCode = $exitCode; TreeStopped = $true; Out = $stdout; Err = $stderr }
}

# ---- classify the docker engine: healthy | wedged | off ----
function Get-EngineState {
  $r = Invoke-Timed 'docker' "version --format `"{{.Server.Version}}`"" ($EngineTimeoutSec * 1000)
  if (-not $r.Exited) { Log "docker engine probe timed out: $($r.Err)"; return 'wedged' }
  if ($r.ExitCode -eq 0 -and $r.Out.Trim()) { return 'healthy' }
  $err = ($r.Err + ' ' + $r.Out)
  if ($err -match '500 Internal Server Error|API version|Internal Server Error') { return 'wedged' }
  if ($err -match 'cannot find the file|cannot connect|the docker daemon|open //./pipe|denied|refused|No such') { return 'off' }
  return 'off'                                                  # unknown -> treat as off (start it), never as healthy
}

function Test-ApiUp {
  foreach ($try in 1..3) {
    try { if ((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 8 -UseBasicParsing).StatusCode -eq 200) { return $true } }
    catch { Log "api health probe $try/3 failed: $(Format-ErrorText $_)" }
    if ($try -lt 3) { Start-Sleep -Seconds 3 }
  }
  return $false
}

function ConvertTo-BashSingleQuoted([string]$value) {
  # A literal apostrophe ends a Bash single-quoted string; close, emit it in double quotes, reopen.
  return "'" + $value.Replace("'", "'`"'`"'") + "'"
}

# The routing-critical heartbeats, via the guard's own script (single source of truth). Returns
# $true when all critical bots are live. Best-effort: any docker/redis error -> treat as NOT ok.
function Test-Routable {
  if (-not $script:gitBash) {
    Log 'validated Git Bash is unavailable - routing is NOT considered healthy'
    return $false
  }
  $repoFwd = $Repo.Replace('\', '/')
  $repoArg = ConvertTo-BashSingleQuoted $repoFwd
  $r = Invoke-Timed $script:gitBash "-lc `"cd $repoArg && bash scripts/swarm-routability-check.sh`"" 60000
  return ($r.Exited -and $r.ExitCode -eq 0)
}

# A single missed heartbeat is common during a busy render/transfer and is not evidence that the
# routing plane needs a force-recreate. Confirm the miss across three probes before recovery.
function Test-RoutableStable {
  if (Test-Routable) { return $true }
  Log 'routing heartbeat miss; confirming before recovery (1/3)'
  foreach ($probe in 2..3) {
    Start-Sleep -Seconds 20
    if (Test-Routable) { Log "routing heartbeat recovered on confirmation probe $probe/3"; return $true }
  }
  return $false
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
  try { $mins = ((Get-Date) - [datetime]$state.lastRecovery).TotalMinutes }
  catch { Log "invalid lastRecovery state; cooldown disabled for this run: $(Format-ErrorText $_)"; return $false }
  $window = if ([int]$state.consecutiveFailures -ge 3) { 120 } else { $CooldownMin }
  return ($mins -lt $window)
}
function Test-LockOwnerAlive {
  try {
    $first = ((Get-Content $lockFile -Raw -ErrorAction Stop).Trim() -split '\s+')[0]
    $ownerPid = [int]$first
    return $null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
  } catch { Log "lock owner check failed; treating malformed owner as dead: $(Format-ErrorText $_)"; return $false }
}
function Acquire-Lock {
  if (Test-Path $lockFile) {
    try { $age = ((Get-Date) - (Get-Item $lockFile -ErrorAction Stop).LastWriteTime).TotalMinutes }
    catch { Log "lock age check failed; treating it as stale: $(Format-ErrorText $_)"; $age = 999 }
    if ($age -lt 35) { return $false }   # worst case is ~24m (engine + oshal-up + settle)
    if (Test-LockOwnerAlive) { return $false } # a slow live recovery owns it regardless of age
    try { Remove-Item $lockFile -Force -ErrorAction Stop }
    catch { Log "stale lock removal failed: $(Format-ErrorText $_)"; return $false }
  }
  # CreateNew is atomic: two scheduled instances cannot both pass a Test-Path/Set-Content race.
  try {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes("$PID $(Get-Date -Format o)")
    $stream = New-Object System.IO.FileStream($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    return $true
  } catch [System.IO.IOException] { Log "lock acquisition lost an atomic create race: $(Format-ErrorText $_)"; return $false }
}
function Release-Lock {
  try { Remove-Item $lockFile -Force -ErrorAction Stop }
  catch { Log "could not release recovery lock: $(Format-ErrorText $_)" }
}

# ---- recovery primitives ----
function Restart-DockerEngine([bool]$killFirst) {
  if ($killFirst) {
    Log "killing wedged Docker processes"
    Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | ForEach-Object {
      $processId = $_.Id
      try { Stop-Process -Id $processId -Force -ErrorAction Stop }
      catch { Log "could not stop Docker process $($processId): $(Format-ErrorText $_)" }
    }
    Start-Sleep -Seconds 3
    Log "wsl --shutdown (tears down the wedged docker-desktop VM)"
    $wsl = Invoke-Timed 'wsl.exe' '--shutdown' 60000
    if (-not $wsl.Exited -or $wsl.ExitCode -ne 0) { Log "wsl --shutdown did not finish cleanly: $($wsl.Err)" }
    Start-Sleep -Seconds 4
  }
  $dd = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Log "starting Docker Desktop"; Start-Process -FilePath $dd -WindowStyle Hidden }
  else { Log "Docker Desktop.exe not found at $dd"; return $false }
  for ($i = 1; $i -le 40; $i++) {
    if ((Get-EngineState) -eq 'healthy') { Log "engine healthy after ~$([int]($i*6))s"; return $true }
    Start-Sleep -Seconds 6
  }
  Log "engine did NOT come healthy within ~240s"
  return $false
}
function Invoke-OshalUp {
  if (-not $script:gitBash) { Log "validated Git Bash unavailable - cannot run oshal-up.sh"; return $false }
  $repoFwd = $Repo.Replace('\', '/')
  $repoArg = ConvertTo-BashSingleQuoted $repoFwd
  Log "running scripts/oshal-up.sh"
  $r = Invoke-Timed $script:gitBash "-lc `"cd $repoArg && bash scripts/oshal-up.sh`"" 900000
  if (-not $r.Exited) { Log "oshal-up.sh timed out (>15m): $($r.Err)"; return $false }
  Log "oshal-up.sh exit=$($r.ExitCode)"
  return ($r.ExitCode -eq 0)
}

# ---- alert (best-effort email via the api container, like trading-watchdog) + event log ----
# Alert strings are generated entirely by this script and contain no double quotes. Rejecting one
# is safer than handing ProcessStartInfo an ambiguously quoted docker command line.
function ConvertTo-NativeAlertArgument([string]$value) {
  if ($value.Contains('"')) { throw "alert argument contains an unsupported double quote" }
  return '"' + $value + '"'
}
function Invoke-AlertEmail([string]$subject, [string]$body) {
  if (-not (Test-ApiUp)) { Log 'alert email skipped because api is unavailable'; return }
  try {
    $nativeArgs = @('exec', 'oshal-local-api', 'node', '/app/scripts/oshal-send-alert.js', $subject, $body) |
      ForEach-Object { ConvertTo-NativeAlertArgument $_ }
    $result = Invoke-Timed 'docker' ($nativeArgs -join ' ') 30000
    if (-not $result.Exited) { Log "alert email timed out: $($result.Err)"; return }
    if ($result.ExitCode -ne 0) { Log "alert email exited $($result.ExitCode): $($result.Err)" }
  } catch { Log "alert email failed: $(Format-ErrorText $_)" }
}
function Send-Alert([string]$subject, [string]$body) {
  Invoke-AlertEmail $subject $body
  try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('OSHAL-Watchdog')) { New-EventLog -LogName Application -Source 'OSHAL-Watchdog' }
    Write-EventLog -LogName Application -Source 'OSHAL-Watchdog' -EntryType Warning -EventId 1101 -Message $body
  } catch { Log "Windows event-log alert failed: $(Format-ErrorText $_)" }
}

# =========================== main ===========================
$engine = Get-EngineState
$needFull = $false; $needLight = $false; $reason = ''

switch ($engine) {
  'healthy' {
    if (-not (Test-ApiUp)) { $needLight = $true; $reason = 'engine healthy but api is DOWN' }
    elseif (-not (Test-RoutableStable)) { $needLight = $true; $reason = 'api up but a routing-critical bot is NOT heartbeating after 3 probes' }
    else { Log "all healthy (engine + api + routing-critical bots)"; $state.consecutiveFailures = 0; Save-State; exit 0 }
  }
  'wedged' { $needFull = $true; $reason = 'docker engine is WEDGED (500/hung)' }
  'off'    { $needFull = $true; $reason = 'docker engine is OFF' }
}

Log "DETECTED: $reason"
if (In-Cooldown) { Log "in cooldown (last recovery $($state.lastRecovery), consecutiveFailures $($state.consecutiveFailures)) - not recovering this run"; exit 0 }
if (-not (Acquire-Lock)) { Log "another recovery is in flight (lock held) - skipping"; exit 0 }

$alertSubject = ''
$alertBody = ''
try {
  if ($needFull) {
    $killFirst = ($engine -eq 'wedged')          # a cleanly-OFF engine needs no kill/wsl-shutdown
    Restart-DockerEngine $killFirst | Out-Null   # best-effort; success is judged by OUTCOME below
    if ((Get-EngineState) -eq 'healthy') { Invoke-OshalUp | Out-Null }
    else { Log "engine still not healthy after restart - skipping oshal-up.sh this run" }
  } elseif ($needLight) {
    Invoke-OshalUp | Out-Null
  }
  # Judge success by the ACTUAL end state while the recovery lock remains held. A slow-but-working
  # restart must not be reported failed, and a second scheduled run must not overlap this settle.
  $ok = Wait-Healthy 300
  $state.lastRecovery = (Get-Date).ToString('o')
  if ($ok) {
    $state.consecutiveFailures = 0
    Log "RECOVERY SUCCEEDED ($reason)"
    $alertSubject = 'OSHAL stack auto-recovered'
    $alertBody = "The OSHAL stack was unhealthy ($reason) and the watchdog recovered it on $env:COMPUTERNAME. Cockpit: http://localhost:35457/cockpit/"
    $watchdogExitCode = 0
  } else {
    $state.consecutiveFailures = [int]$state.consecutiveFailures + 1
    Log "RECOVERY FAILED ($reason) - consecutiveFailures now $($state.consecutiveFailures)"
    $alertSubject = 'OSHAL stack recovery FAILED'
    $alertBody = "The OSHAL stack was unhealthy ($reason) and the watchdog could NOT recover it on $env:COMPUTERNAME (attempt $($state.consecutiveFailures)). Manual: kill Docker, 'wsl --shutdown', start Docker, then 'bash scripts/oshal-up.sh'."
    $watchdogExitCode = 1
  }
  Save-State
} finally {
  Release-Lock
}
if ($null -eq $watchdogExitCode) { $watchdogExitCode = 1 }
if ($alertSubject) { Send-Alert $alertSubject $alertBody }
exit $watchdogExitCode
