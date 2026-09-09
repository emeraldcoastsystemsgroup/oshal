<#
  trading-watchdog.ps1 - INDEPENDENT host-side monitor for the trading autopilot.

  Born from the 2026-07-07 incident: a position slid -8.7 percent while the autopilot's own
  protective sells were locked out by stranded orders - nothing watched the watcher. This runs
  OUTSIDE the containers on a Windows scheduled task, so it survives an api hang, a container
  crash, a wedged event loop, or a bug in the trading loop itself. It ALERTS (email + log);
  it never trades.

  Checks, every run (self-skips outside 08:00-20:00 ET weekdays):
    A. api container healthy (HTTP /api/health from the host; retried 3x before alerting)
    B. autopilot heartbeat: an "autopilot run complete" OR "autopilot skipped - market closed"
       log line in the last 20 minutes (a "keys not configured" / "regular-hours-only" skip does
       NOT count - that is the dead-loop case)
    C. UNPROTECTED BLEEDER (the incident): any PAPER position down more than ALERT_PCT
       from entry with NO working sell order on the venue (RTH only; excludes TRADING_CORE_SYMBOLS)
    D. stranded sells: any open sell order older than 30 minutes (a limit the market fell
       away from - today's lockout signature)

  B/C/D/E self-skip for the first ~20 min after a container (re)start: a market-hours recreate
  wipes the docker-log stream and leaves the api briefly cold, which false-alarmed on every deploy.
  Bleeder conclusions (C/E) are RTH-only because pre/post-market the autopilot has no resting
  intraday sells by design. Core / ':0' operator-holds are excluded from bleeder checks.

  Alerts are emailed via the api container (oshal-send-alert.js). If the api itself is down
  (check A), email cannot go through that path - the alert lands in the log file and a
  Windows event log entry. Repeat alerts for the same condition are suppressed for 60 min.

  2026-07-23 20:05 revision: self-locating (ADR-115 trunk cutover) - $Repo defaults to the repo this
  script lives in, and $LiveSub resolves at runtime from the operator-local .env (OSHAL_OPERATOR_SUBS,
  first entry) instead of a committed literal: the public trunk cannot carry a personal sub, and the
  placeholder that replaced it would have made check E audit a nonexistent user forever.

  2026-09-06 revision (ADR-134 D2 #7, multi-account books): check B2(a) no longer greps a hand-known
  schedule id. Each RTH run it reads the ENABLED LIVE BOOKS for $LiveSub from oshal_trading_books
  (docker exec psql into $DbContainer - the same chokepoint trading-books-cutover.sh uses), maps each
  book to the autopilot leg actually present in the Redis schedule store ($RedisContainer,
  oshal:scheduler:schedule:trading-autopilot_*: taskData.bookId -> book, a legacy leg with no bookId
  and mode 'live' -> the 'live' book), and requires one "autopilot run complete" line carrying THAT
  leg's "scheduleId" per book -> 'live-loop-silent-<ref>' per missing book. An enabled live book with
  NO autopilot leg (an operator / pinned-lot book) is counted as watched when the trading-events tick
  ("event plans + protected lots + dated orders tick") fired in the window; that tick is PER SUB, so
  'events-leg-silent' means the leg did not run for the operator at all, not that one book was
  skipped. An enabled live book whose leg EXISTS but is PAUSED is neither case: it raises
  'live-leg-paused-<ref>' and is NEVER satisfied by that tick (2026-09-06 review finding: folding a
  paused leg into the legless bucket silenced exactly the state the old '_live' grep paged on, and
  only when another book still had an active leg - the two-live-book world this prepares for). FAIL-CLOSED: a books read failure -> 'books-unreadable' and the legacy 'live' book is
  assumed; an empty/unreadable leg map with books present -> 'legs-unreadable' and the legacy live
  leg beat is still required - never fewer required beats than the old single '_live' check. The leg
  read runs even when the books read failed (against the same assumed legacy book), so
  'legs-unreadable' never names a schedule store the run did not actually consult. Container names
  and the beat window are parameters now: -ApiContainer / -DbContainer / -DbUser / -DbName /
  -RedisContainer / -BeatWindowMin (defaults are the compose names, so an existing scheduled task
  needs no change).

  2026-09-06 revision 2 (round-4 review, DISABLED live books): the roster no longer filters on
  `enabled`. Disabling a book stops NEW risk only - src/app/trading-schedule-dispatch.ts logs "book
  disabled - rotation skipped (protective exits still ran)" and "book disabled - new entries skipped
  (exits/sells still ran)" - so a disabled live book's autopilot leg keeps running its hard stops,
  take-profits and trailing exits on real money. With `AND enabled` in the SQL such a book never
  entered the expected set, its leg was dropped by the leg read, and the evaluation returned early
  when the set was empty: its protective exits could stop firing with NOTHING alerting. Every live
  book now carries an Enabled flag and the four states are alerted apart -> 'live-loop-silent-<ref>'
  (enabled, active leg, no beat: entries AND exits dead), 'live-exits-silent-<ref>' (DISABLED, ACTIVE
  leg, no beat: only the protective exits are dead), 'live-leg-paused-<ref>' (enabled book, paused
  leg), 'events-leg-silent' (enabled legless book, per-sub tick). A DISABLED book with a paused leg or
  no leg is logged and stays SILENT: both switches are off, nothing is scheduled to run, and paging on
  it would train the operator to ignore the whole family. Fail-closed is unchanged in strength: a
  books read failure still assumes an ENABLED legacy 'live' book, and a leg-map read failure still
  requires the legacy live beat whenever any book is enabled (and now also raises 'legs-unreadable'
  when every live book is disabled, since blindness over a leg that runs exits is not a quiet state).

  2026-09-06 revision 3 (ADR-134 D3.7, "catch a silently-wrong book, not just a dead process"): the
  DECIDABLE half of this file moved into scripts/lib/trading-watchdog-checks.js - pure functions over
  plain objects, docker-cp'd into the api container and required by the fetchers that run there, so
  every threshold comparison is mutation-proved by tests/unit/trading-watchdog-checks.spec.ts instead
  of being source-pinned inside a .ps1. What that bought:
    G. PER-BOOK AUDIT (replaces the single-book check E). Every LIVE book from the same
       oshal_trading_books roster B2(a) uses - enabled AND disabled, since a disabled book still runs
       protective exits on real money - is read through the api's caller-scoped /account, /positions
       and /orders with ?book=<ref> (the query-first param, oshal-applications/trading
       src-routes/trading-accounts-routes.ts routeBook), and audited for: unprotected bleeders (the
       old check E, now per book AND per symbol), stranded sells, HOLDING PAST THE STOP
       (TRADING_WD_DEEP_LOSS_PCT, above every shipped posture's stopLossPct - the autopilot rests no
       venue stops, so this reads "the loop's own exit did not happen", never "a stop is missing"),
       NEGATIVE buying power / cash, an open-position count above a coarse anomaly floor, and
       single-name concentration. Check E audited ONE book (?mode=live -> the legacy book); with three
       live books on the roster that left two real-money accounts unwatched.
    PER-SYMBOL SUPPRESSION with hysteresis ($symStateFile, decided by the module): one key per
       condition per book per symbol - never a symbol-SET key, whose churn minted a new key every run
       - re-alerting inside the window only when the condition WORSENS past a band, logging one
       'recovered:' line and clearing the key when it clears. Keys are only reconciled for the books
       and check kinds the run actually evaluated, so a book that could not be read never "recovers".
    EMPTY, FAILED OR SLOW EXEC IS A FAILED CHECK. Every docker exec goes through Invoke-WdExec: a
       non-zero exit, empty output, or a run past TRADING_WD_EXEC_TIMEOUT_SEC (default 60s, the
       process is killed) raises 'check-infra-<name>' instead of parsing to nothing and reading
       all-clear - the deadline is what stops one wedged /api/trading read from eating the whole run
       and the alerts it had already raised. Same rule, same deadline, for every docker cp into the
       container ('wd-checks-unavailable' / 'check-infra-<name>'), because a cp that fails silently
       leaves the PREVIOUS run's file in place and prints a well-formed wrong result.
       THE TWO DEADLINES ARE RELATED BY A FORMULA, not left to agree by luck: the container-side
       audit is handed a BUDGET of (exec deadline - 10s slack) and gives each book an equal share,
       and TRADING_WD_HTTP_TIMEOUT_SEC (default 20) caps a single read WITHIN that share. So the
       fetcher always prints its per-book results before the host kills it, and one wedged book
       costs only its own share. Before that formula (round-3 review, MEASURED against a real
       hanging server at the shipped defaults) three wedged books took 126s against the 60s exec
       deadline: the child was killed and the operator lost the wedged books' error lines AND the
       healthy books' findings, getting one generic 'ran past its deadline' instead.
       NOT bounded by a deadline, and honestly so: `docker inspect` (uptime), the two `docker logs`
       reads (they need line-numbered arrays, which the process wrapper does not return) and the
       final `oshal-send-alert.js` delivery exec (its body carries newlines and quotes that
       ConvertTo-WdArgLine refuses by design). A wedged docker daemon can still park those.
    CHECK F needs a REAL print: size, recency and a two-sided quote whose mid crosses the same
       threshold, or it logs a skip instead of paging on one thin stale odd-lot print.
  Thresholds are settings, never literals: -AlertPct/-GapAlertPct params, then TRADING_WD_* in the
  operator-local .env, then the defaults in trading-watchdog-checks.js defaultSettings(). $AlertPct
  resolves BEFORE $LiveAlertPct, because it is the live threshold's fallback.

  CHANGE LOG (started 2026-09-06; earlier revisions remain described above and in Git)
  -----------------------------------------------------------------------------
  SEQ | AUTHOR                                     | DESCRIPTION
  -----------------------------------------------------------------------------
  1 | maintainer@emeraldcoastsystemsgroup.com   | Move every DECIDABLE check into scripts/lib/trading-watchdog-checks.js (pure functions, mutation-proved by tests/unit/trading-watchdog-checks.spec.ts) and keep this file to fetching, delivery and Raise. Adds block G: the per-book audit of EVERY live book on the roster (the retired check E read only ?mode=live, so two real-money books had nothing watching them) - unprotected bleeders, stranded sells, holding past the stop, negative buying power/cash, position count and single-name concentration - with per-book/per-symbol suppression, a worsening band and one-shot recovery in $symStateFile. Every docker exec now goes through Invoke-WdExec, so an empty or failed exec raises check-infra-<name> instead of parsing to nothing and reading as all-clear; a missing checks module raises wd-checks-unavailable. Check F requires a real print (size, recency, quote-mid corroboration). Thresholds are settings: -params, then TRADING_WD_* in the operator-local .env, then the module defaults (which sit above every shipped risk posture).
  2 | maintainer@emeraldcoastsystemsgroup.com   | Round-2 review fixes, all three on the real-money half. (a) $AlertPct now resolves BEFORE $LiveAlertPct: the other order meant TRADING_WD_ALERT_PCT=3 tightened the paper book and left the Schwab books on the param default of 5 - looser where it matters most. (b) Invoke-WdExec runs docker as a real child process with a DEADLINE (TRADING_WD_EXEC_TIMEOUT_SEC, default 60): block G reads three endpoints per book, so an api that answers /api/health while /api/trading is wedged could park the run on undici's 300s-per-request default, past the next scheduled runs, with api-down/engine-blind already raised and never emailed; the container-side fetcher additionally bounds ONE read (TRADING_WD_HTTP_TIMEOUT_SEC, default 20) so a single wedged book does not cost the others. (c) The TRADING_CORE_SYMBOLS and TRADING_MULTI_ACCOUNT reads go through Invoke-WdExec too (node -p with a 'wd:' sentinel, since printenv exits 1 on an unset variable) - an empty catch used to hand the checks an empty exemption set, which would have paged 'HOLDING PAST ITS STOP' on a deliberate :0 hold once per window per book; a failed core read now withholds every core-exempting check for the run and says so. Also: every docker cp into the container is fail-closed (a stale /tmp file otherwise yields a well-formed wrong result), block G's fallback alert has its own key so the beat check's does not swallow it, and an unparseable setting is reported as a warning instead of silently defaulting.
  3 | maintainer@emeraldcoastsystemsgroup.com   | Round-3 review fixes. (a) CORRECTS SEQ 2's claim that TRADING_WD_HTTP_TIMEOUT_SEC alone kept one wedged book from costing the others: it does not, because two unrelated numbers cannot agree by luck. Measured against a real hanging server at the shipped defaults, THREE wedged books spent 126s inside a 60s exec deadline (20s per read x 2 attempts x 3 books), so the child was killed and every book's result - wedged and healthy alike - was thrown away. The audit is now handed a BUDGET derived from the exec deadline (Get-WdAuditBudgetSec = deadline - 10s slack), slices it equally per book, caps each read at min(HTTP_TIMEOUT_SEC, what is left of that book's share), and never retries a read that TIMED OUT (a wedge does not clear in 2s; retrying doubled the cost of exactly the failure the deadline exists to bound). The fetcher therefore always prints inside the deadline, and the deadline is a backstop again. (b) docker cp is deadline-bound too, through Invoke-WdProcess - it could not use Invoke-WdExec because a successful cp prints nothing - and Copy-WdChecksModule is now that one helper with its own alert key instead of a second copy of the same logic. ConvertTo-WdArgLine accordingly refuses only a double quote or a TRAILING backslash (a Windows path full of backslashes is exactly what cp needs). (c) The audit's suppression-state read no longer swallows its failure - an unreadable state file becomes a warning in the log, since it silently turns every open condition into a fresh page. The block-G gate is now marker-wrapped so the spec can EXECUTE the withholding wiring instead of pinning its source text.
  4 | maintainer@emeraldcoastsystemsgroup.com   | Plumbs TRADING_WD_BLEED_BOOKS from the operator-local .env into the audit request, so the BLEED check can be scoped to the books the autopilot manages while the hand-traded rollover keeps its deep-loss coverage. It is a STRING setting, so it cannot ride Get-WdSetting (which parses doubles under InvariantCulture) and is read straight off the parsed $script:WdEnv map; an absent key resolves to the empty string, which the module reads as "every book". Proven at the real boundary in the spec (real powershell.exe, a real .env file, the shipped Read-WdEnvSettings and this exact expression) because the watchdog hard-exits outside 08:00-19:59 ET and cannot be exercised live off-session.

  Register (every 10 minutes, windowless -- launch through trading-watchdog-hidden.vbs; a bare
  powershell action pops a visible console every run, which steals focus from desktop automation):
    schtasks /create /tn "OSHAL Trading Watchdog" /sc minute /mo 10 /f ^
      /tr "wscript.exe //B //Nologo C:\Projects\oshal\scripts\trading-watchdog-hidden.vbs"
#>
[CmdletBinding()]
param(
  [double]$AlertPct = 5.0,
  # Default: the repo this script lives in (scripts/ -> repo root). Override for a nonstandard layout.
  [string]$Repo = '',
  # The live book's owner sub (single-operator deployment) - check E audits this user's REAL-money
  # positions via the api's caller-scoped endpoints. Default: resolved at runtime from $Repo\.env
  # OSHAL_OPERATOR_SUBS (first entry) so the personal sub never lives in the committed file.
  [string]$LiveSub = '',
  # Deep-bleed threshold for the REAL-MONEY books (check G). Defaults to .env
  # TRADING_WD_LIVE_ALERT_PCT, else $AlertPct - so an operator can page later on live than on paper
  # without touching this file. An explicitly passed -LiveAlertPct always wins over the .env.
  [double]$LiveAlertPct = 0,
  # The decidable checks module (pure functions; docker-cp'd into the api container each run).
  [string]$ChecksModule = '',
  # Check F: pre-market SPY gap-down (percent vs prior close) that triggers the before-the-open alert.
  [double]$GapAlertPct = 1.0,
  # Check B2(a): where the books roster and the schedule store live (compose container names) and
  # how far back a per-book beat may be. Override for a nonstandard compose project.
  [string]$DbContainer = 'oshal-local-db',
  [string]$DbUser = 'oshal',
  [string]$DbName = 'oshal',
  [string]$RedisContainer = 'oshal-local-redis',
  [int]$BeatWindowMin = 20,
  # Every docker read/exec in this file targets the api container by this name.
  [string]$ApiContainer = 'oshal-local-api'
)
$ErrorActionPreference = 'Continue'
if (-not $Repo) { $Repo = Split-Path -Parent $PSScriptRoot }
if (-not $ChecksModule) { $ChecksModule = Join-Path $PSScriptRoot 'lib/trading-watchdog-checks.js' }
if (-not $LiveSub) {
  # Operator-local .env, never committed: first OSHAL_OPERATOR_SUBS entry is the live-book owner.
  $dotEnv = Join-Path $Repo '.env'
  if (Test-Path $dotEnv) {
    $subsLine = Get-Content $dotEnv | Where-Object { $_ -match '^\s*OSHAL_OPERATOR_SUBS\s*=' } | Select-Object -First 1
    if ($subsLine) { $LiveSub = ((($subsLine -split '=', 2)[1]) -split ',')[0].Trim() }
  }
}
$stateDir = Join-Path $env:LOCALAPPDATA 'oshal'
$stateFile = Join-Path $stateDir 'trading-watchdog-state.json'
# Per-symbol/per-book suppression lives in its OWN file: $state's prune loop casts every value to
# [datetime], which would delete these object values on the next run.
$symStateFile = Join-Path $stateDir 'trading-watchdog-symbols.json'
$logFile = Join-Path $stateDir 'trading-watchdog.log'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir | Out-Null }
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format s), $m) | Add-Content $logFile; Write-Host $m }

# Market-hours gate: 08:00-20:00 ET, Mon-Fri (covers pre + regular + after hours).
# ('Eastern Standard Time' on Windows carries DST rules, so this resolves to EDT in summer.)
$et = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'Eastern Standard Time')
if ($et.DayOfWeek -in @('Saturday','Sunday') -or $et.Hour -lt 8 -or $et.Hour -ge 20) { exit 0 }

# NYSE full closures + half-days (13:00 ET close), published years ahead. The watchdog needs its OWN
# holiday source: its $rth is a LOCAL clock calc with no calendar, so without this it would treat a
# holiday as RTH and false-alarm "the engine says market closed during market hours" every holiday --
# the engine would be telling the truth. Extend before 2029.
$nyseHolidays = @(
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25'
)
$nyseHalfDays = @('2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24')
$etDate  = $et.ToString('yyyy-MM-dd')
$etMin   = ($et.Hour * 60) + $et.Minute
$isHoliday = $nyseHolidays -contains $etDate
$rthClose  = if ($nyseHalfDays -contains $etDate) { 13 * 60 } else { 16 * 60 }

# Regular trading hours flag (09:30-16:00 ET, 13:00 on a half-day, never on a holiday). Several "no
# working sell rests" conclusions below are only meaningful during RTH - pre-market and after-hours the
# autopilot legitimately has no resting intraday sells, so flagging "unprotected" then is expected-state
# noise (the 07-15 real-money AMAT spam all fired 08:15-09:25 ET, before the open).
$rth = (-not $isHoliday) -and ($etMin -ge 570) -and ($etMin -lt $rthClose)

# Container freshness: a market-hours rebuild+recreate resets the docker-log stream to EMPTY and
# leaves the api briefly cold. For up to ~20 min after a (re)start the heartbeat window (check B)
# physically cannot be populated and the position reads (C/D/E) can hit a not-yet-warm api - this
# false-alarmed "trading loop is not firing" on every deploy 07-13..07-15. Skip the log/warm-api
# checks while freshly recreated; check A (a direct HTTP probe, now with retry) still catches a
# genuinely down api regardless of uptime.
$uptimeMin = 9999.0
try {
  $started = docker inspect $ApiContainer --format '{{.State.StartedAt}}' 2>$null | Select-Object -First 1
  if ($started) { $uptimeMin = ((Get-Date).ToUniversalTime() - ([datetimeoffset]$started).UtcDateTime).TotalMinutes }
} catch {}
$freshlyRecreated = $uptimeMin -lt 20

# Alert plumbing with 60-min suppression per condition key.
$state = @{}
if (Test-Path $stateFile) { try { (Get-Content $stateFile -Raw | ConvertFrom-Json).psobject.properties | ForEach-Object { $state[$_.Name] = $_.Value } } catch {} }
# Prune suppression entries older than 24h so the state file does not grow without bound.
foreach ($k in @($state.Keys)) { try { if (((Get-Date) - [datetime]$state[$k]).TotalHours -gt 24) { $state.Remove($k) } } catch { $state.Remove($k) } }
$alerts = New-Object System.Collections.ArrayList
function Raise($cond, $msg) {
  $last = if ($state.ContainsKey($cond)) { [datetime]$state[$cond] } else { [datetime]::MinValue }
  if (((Get-Date) - $last).TotalMinutes -lt 60) { Log ("suppressed (raised recently): " + $msg); return }
  $state[$cond] = (Get-Date).ToString('o')
  [void]$alerts.Add($msg)
  Log ("ALERT: " + $msg)
}

# ---- wd: settings + exec ----
# Thresholds are configuration, never literals in this file: an explicit -Param wins, then
# TRADING_WD_<NAME> in the operator-local .env (never committed), then the default the caller passes
# (which is itself the module's default). Values parse under InvariantCulture so a non-US host locale
# cannot turn '8.5' into 85.
function Read-WdEnvSettings($path) {
  $map = @{}
  if ($path -and (Test-Path $path)) {
    foreach ($line in Get-Content $path) {
      if ($line -match '^\s*TRADING_WD_([A-Z0-9_]+)\s*=\s*(.*)$') { $map[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $map
}
function Get-WdSetting($name, $default) {
  if ($script:WdEnv -and $script:WdEnv.ContainsKey($name)) {
    $raw = [string]$script:WdEnv[$name]
    $parsed = 0.0
    if ([double]::TryParse($raw, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) { return $parsed }
    Log ("ignoring TRADING_WD_" + $name + "='" + $raw + "' - not a number; using " + $default)
  }
  return $default
}
# The docker CLI as a REAL child process, so the deadline below can actually kill it. Overridable
# only so the guard can drive a real process (a real exit code, real empty output, a real hang)
# instead of stubbing a PowerShell function no timeout could ever terminate; production always uses
# the docker on PATH.
$script:WdDockerExe = 'docker'
$script:WdDockerArgPrefix = @()
# Win32 command-line quoting. An argument containing whitespace is quoted; one this file cannot
# quote CORRECTLY is REFUSED (returns $null) rather than mis-quoted, because a silently mangled
# argument is how a check ends up running against the wrong thing and reporting all-clear. Two
# shapes are refused: a DOUBLE QUOTE (which needs the full Win32 backslash-doubling rule this file
# does not implement) and a TRAILING backslash in an argument that has to be quoted, where the
# backslash would escape the closing quote and swallow the argument after it. A backslash anywhere
# else is accepted and must be: the host paths handed to `docker cp` are full of them.
function ConvertTo-WdArgLine([string[]]$argv) {
  $parts = New-Object System.Collections.ArrayList
  foreach ($a in @($argv)) {
    $s = [string]$a
    if ($s -match '"') { return $null }
    if ($s -match '\s') {
      if ($s -match '\\$') { return $null }
      [void]$parts.Add('"' + $s + '"')
    } else { [void]$parts.Add($s) }
  }
  return ($parts -join ' ')
}
# Runs one child process to completion or KILLS it at the deadline. Both pipes are drained
# ASYNCHRONOUSLY: a blocking ReadToEnd() deadlocks against a child that fills the other pipe's
# buffer, which is one of the hangs this deadline exists to bound.
function Invoke-WdProcess([string]$exe, [string]$line, [int]$limitSec) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $line
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEndAsync()
    [void]$p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($limitSec * 1000)) {
      try { $p.Kill() } catch { Log ("could not kill a timed-out exec: " + $_.Exception.Message) }
      $p.Dispose()
      return @{ Started = $true; TimedOut = $true }
    }
    $p.WaitForExit()
    $r = @{ Started = $true; TimedOut = $false; Code = $p.ExitCode; Text = ([string]$so.Result).Trim() }
    $p.Dispose()
    return $r
  } catch {
    Log ("could not start '" + $exe + "': " + $_.Exception.Message)
    return @{ Started = $false; Error = $_.Exception.Message }
  }
}
# EVERY docker exec goes through this. An exec that exits non-zero, returns nothing, OR RUNS PAST
# ITS DEADLINE is a check that DID NOT RUN, and a check that did not run must never read as a check
# that passed: the old sites parsed empty output to nothing and fell through their `if ($r.error)`
# guards silently (the 'no silently healthy infrastructure-check result' rule, in code rather than
# prose). The DEADLINE matters as much as the exit code: block G reads three endpoints per book, and
# an api that answers /api/health while /api/trading is wedged (pool exhaustion, a hung broker call)
# would otherwise park this run on undici's 300s-per-request default - past the next scheduled runs,
# with every alert the run had already raised (api-down, engine-blind) still sitting unsent in
# $alerts. Seconds from TRADING_WD_EXEC_TIMEOUT_SEC in the operator-local .env, default 60.
function Invoke-WdExec($name, [string[]]$dockerArgs, $timeoutSec) {
  $limit = if ($timeoutSec) { [int]$timeoutSec } elseif ($script:WdExecTimeoutSec) { [int]$script:WdExecTimeoutSec } else { 60 }
  $line = ConvertTo-WdArgLine (@($script:WdDockerArgPrefix) + @($dockerArgs))
  if ($null -eq $line) {
    Raise ('check-infra-' + $name) ("The watchdog REFUSED to run its '" + $name + "' check: an argument contains a double quote or a backslash, which this file does not quote. A check that cannot run is NOT a passing check.")
    return $null
  }
  $r = Invoke-WdProcess $script:WdDockerExe $line $limit
  if (-not $r.Started) {
    Raise ('check-infra-' + $name) ("The watchdog could not START its '" + $name + "' check (" + $script:WdDockerExe + "): " + [string]$r.Error + ". A check that cannot run is NOT a passing check.")
    return $null
  }
  if ($r.TimedOut) {
    Raise ('check-infra-' + $name) ("The watchdog's '" + $name + "' check RAN PAST its " + $limit + " second deadline and was KILLED - treated as a FAILED check, never a passing one. The api can answer /api/health while /api/trading is wedged, and the deadline is what stops one wedged read from eating the whole run along with the alerts it had already raised. Raise TRADING_WD_EXEC_TIMEOUT_SEC only if this box is genuinely that slow.")
    return $null
  }
  if (($r.Code -ne 0) -or (-not $r.Text)) {
    $what = if ($r.Text) { 'unusable output' } else { 'NOTHING' }
    Raise ('check-infra-' + $name) ("The watchdog could not RUN its '" + $name + "' check: docker exec exited " + $r.Code + " and returned " + $what + ". A check that cannot run is NOT a passing check. Verify the container is up and that the docker CLI works from the scheduled task's account (container-name overrides: -ApiContainer / -DbContainer / -RedisContainer).")
    return $null
  }
  return $r.Text
}
# Copies one host file into the api container, FAIL-CLOSED and DEADLINE-BOUND. A cp that silently
# fails leaves the PREVIOUS run's file at that path, so the check then runs against a stale
# request/state/script and prints a well-formed WRONG result - the worst shape a watchdog result can
# have. It goes through Invoke-WdProcess for the same reason every exec does: a wedged docker daemon
# must not park the run before the alerts already sitting in $alerts are delivered. (It cannot go
# through Invoke-WdExec: a SUCCESSFUL docker cp prints nothing, which that wrapper correctly treats
# as a failed check.) $alertKey lets a caller own the message key - the checks-module copy alerts as
# 'wd-checks-unavailable', which names the actual consequence.
function Copy-WdIntoApi($name, $local, $remote, $alertKey) {
  $key = if ($alertKey) { [string]$alertKey } else { 'check-infra-' + $name }
  $limit = if ($script:WdExecTimeoutSec) { [int]$script:WdExecTimeoutSec } else { 60 }
  $line = ConvertTo-WdArgLine (@($script:WdDockerArgPrefix) + @('cp', $local, ($ApiContainer + ':' + $remote)))
  if ($null -eq $line) {
    Raise $key ("The watchdog REFUSED to copy " + $remote + " into " + $ApiContainer + ": a path contains a double quote or ends in a backslash, which this file does not quote. The '" + $name + "' check is treated as FAILED, never as passing.")
    return $false
  }
  $r = Invoke-WdProcess $script:WdDockerExe $line $limit
  $why = ''
  if (-not $r.Started) { $why = "docker could not start (" + [string]$r.Error + ")" }
  elseif ($r.TimedOut) { $why = "docker cp RAN PAST its " + $limit + " second deadline and was KILLED" }
  elseif ($r.Code -ne 0) { $why = "docker cp exited " + $r.Code }
  if ($why) {
    Raise $key ("The watchdog could not copy " + $remote + " into " + $ApiContainer + " (" + $why + ") - the '" + $name + "' check would otherwise have run against the PREVIOUS run's copy of that file and printed a well-formed WRONG result. Treated as a failed check.")
    return $false
  }
  return $true
}
# ---- wd: audit budget ----
# The container-side audit's total wall-clock budget, DERIVED from the host deadline instead of
# being a second, unrelated number. Round-3 review, MEASURED: with the shipped 20 second per-read
# cap and the shipped 60 second exec deadline, THREE wedged books took 126 seconds - so the host
# killed the child and threw away both the wedged books' own error lines and every healthy book's
# findings, leaving the operator one generic 'ran past its deadline'. The fetcher now slices this
# budget per book and always prints inside it, which is what makes the exec deadline a backstop
# again instead of the normal outcome. The slack covers docker exec startup, node boot and printing.
$script:WdAuditSlackSec = 10
function Get-WdAuditBudgetSec {
  $limit = if ($script:WdExecTimeoutSec) { [int]$script:WdExecTimeoutSec } else { 60 }
  return [Math]::Max(5, $limit - $script:WdAuditSlackSec)
}
# ---- wd: end audit budget ----
# ---- wd: end settings + exec ----

# ---- wd: symbol state ----
# The per-symbol suppression map is opaque JSON to PowerShell: the module DECIDES (raise / suppress
# / recovered) and returns the next state; this file only persists it. A corrupt or missing file
# starts empty - which can only cause an extra alert, never a missed one.
function Read-WdSymbolState($path) {
  if (-not (Test-Path $path)) { return '{}' }
  try {
    $raw = Get-Content $path -Raw
    if (-not $raw -or -not $raw.Trim()) { return '{}' }
    ($raw | ConvertFrom-Json) | Out-Null
    return $raw.Trim()
  } catch {
    Log ("symbol-state file unreadable, starting empty (an extra alert is the safe failure): " + $_.Exception.Message)
    return '{}'
  }
}
function Write-WdSymbolState($path, $json) {
  try { $json | Set-Content $path -Encoding ascii } catch { Log ("could not write the symbol-state file: " + $_.Exception.Message) }
}
# Alerts whose suppression the module already decided: deliver + log WITHOUT touching $state, whose
# 60-minute key is the wrong (and second) suppressor for a per-symbol condition.
function Add-WdAlert($cond, $msg) {
  [void]$alerts.Add($msg)
  Log ("ALERT [" + $cond + "]: " + $msg)
}
# ---- wd: end symbol state ----

# ---- wd: threshold precedence ----
$script:WdEnv = Read-WdEnvSettings (Join-Path $Repo '.env')
# $PSBoundParameters, not the value: a defaulted [double] param is indistinguishable from an
# operator passing the same number, so without this the .env would never be consulted.
# THE ORDER IS LOAD-BEARING: $AlertPct resolves FIRST because it is the FALLBACK for the real-money
# threshold. Shipped the other way round (2026-09-06 first cut), an operator who tightened only
# TRADING_WD_ALERT_PCT=3 got 3 percent on the PAPER book and silently kept the param default of 5 on
# the Schwab books - looser on the only checks that watch real money. The spec executes these exact
# lines under real powershell against a real .env to pin the order, not just the mechanism.
if (-not $PSBoundParameters.ContainsKey('AlertPct')) { $AlertPct = [double](Get-WdSetting 'ALERT_PCT' $AlertPct) }
if (-not $PSBoundParameters.ContainsKey('LiveAlertPct')) { $LiveAlertPct = [double](Get-WdSetting 'LIVE_ALERT_PCT' $AlertPct) }
if (-not $PSBoundParameters.ContainsKey('GapAlertPct')) { $GapAlertPct = [double](Get-WdSetting 'GAP_ALERT_PCT' $GapAlertPct) }
# How long any single docker exec may run before it is killed and reported as a FAILED check.
$script:WdExecTimeoutSec = [int](Get-WdSetting 'EXEC_TIMEOUT_SEC' 60)
# ---- wd: end threshold precedence ----

# ---- per-book beat derivation (ADR-134 D2 #7) ----
# LIVE books for $sub straight from oshal_trading_books (psql as the DB superuser, RLS does not scope
# it) - ENABLED AND DISABLED, each carrying its own Enabled flag. A disabled book is NOT idle: the
# kernel dispatch (src/app/trading-schedule-dispatch.ts) skips only rotation and new entries for one
# ("book disabled - new entries skipped (exits/sells still ran)"), so its autopilot leg keeps running
# the PROTECTIVE EXITS on real money. Filtering "AND enabled" in the SQL - which this did until the
# 2026-09-06 round-4 review - dropped such a book out of the expected set entirely, and its leg could
# then die with nothing alerting: a fail-open on stops, not on entries. Returns
# @{ Ok = $true; Books = @(@{ Ref; BookId; Enabled }, ...) } (Books possibly empty), or @{ Ok = $false }
# on ANY failure so the caller can fail closed. The SQL goes in on STDIN with `-f -` because psql's -c
# never interpolates :'sub' (-v keeps the sub out of the SQL text, so a hostile sub is a bound literal,
# never syntax). ASCII only.
function Get-ExpectedLiveBooks($sub) {
  if (-not $sub) { return @{ Ok = $false } }
  # One retry: a docker exec under engine contention (deploys, parallel specs) can fail transiently,
  # and a page on every blip is the false-alarm spiral this file already fought. Two failures alert.
  $r = Read-ExpectedLiveBooksOnce $sub
  if (-not $r.Ok) { Start-Sleep -Seconds 2; $r = Read-ExpectedLiveBooksOnce $sub }
  return $r
}
function Read-ExpectedLiveBooksOnce($sub) {
  try {
    # 'y'/'n' rather than the bare boolean on purpose: psql renders a boolean as unquoted t/f, and
    # every non-empty string is truthy in PowerShell - a mis-shaped row must fail the parse below
    # (-> Ok=$false -> fail closed), never quietly read a disabled book as enabled.
    $sql = "SELECT ref, book_id::text, CASE WHEN enabled THEN 'y' ELSE 'n' END FROM oshal_trading_books WHERE user_sub = :'sub' AND kind = 'live' ORDER BY (ref = 'live') DESC, created_at"
    $rows = $sql | docker exec -i $DbContainer psql -U $DbUser -d $DbName -tA -F '|' -v ("sub=" + $sub) -f - 2>&1
    if ($LASTEXITCODE -ne 0) { Log ("books read failed (psql exit " + $LASTEXITCODE + "): " + ((@($rows) | Select-Object -First 3) -join ' ')); return @{ Ok = $false } }
    $found = New-Object System.Collections.ArrayList
    foreach ($line in @($rows)) {
      $t = ([string]$line).Trim()
      if (-not $t) { continue }
      if ($t -match '^([^|]+)\|([0-9a-fA-F-]{36})\|([yn])$') { [void]$found.Add(@{ Ref = $Matches[1]; BookId = $Matches[2].ToLower(); Enabled = ($Matches[3] -eq 'y') }) } else { Log ("books read returned an unparseable row: " + $t); return @{ Ok = $false } }
    }
    return @{ Ok = $true; Books = $found.ToArray() }
  } catch { Log ("books read failed: " + $_.Exception.Message); return @{ Ok = $false } }
}

# Autopilot legs owned by $sub in the Redis schedule store, mapped to book refs:
# taskData.bookId -> the matching $books entry; no bookId + mode 'live' -> the legacy 'live' book.
# $books carries EVERY live book (enabled or not), so a disabled book's leg is mapped too - that leg
# is what runs the disabled book's protective exits.
# Returns @{ Legs = @{ ref -> scheduleId }; Paused = @{ ref -> 'id status=<st>' } } (either may be
# empty), or $null on any read/parse failure. ACTIVE and PAUSED are DIFFERENT states and must never be
# merged: an enabled live book whose leg exists but is paused is NOT 'legless' - dropping it into the
# legless bucket let the per-sub events tick satisfy it and silenced the very state the retired
# hand-known-schedule-id check paged on (visible only when ANOTHER book still had an active leg, i.e.
# exactly the two-live-book world this derivation exists to prepare for). NOTE: do not write the
# retired grep's literal text anywhere in this file - trading-books-cutover.sh precondition 5(a)
# refuses a watchdog that still contains it.
function Get-AutopilotLegRefs($sub, $books) {
  $r = Read-AutopilotLegRefsOnce $sub $books
  if ($null -eq $r) { Start-Sleep -Seconds 2; $r = Read-AutopilotLegRefsOnce $sub $books }
  return $r
}
function Read-AutopilotLegRefsOnce($sub, $books) {
  try {
    $keys = docker exec $RedisContainer redis-cli --scan --pattern 'oshal:scheduler:schedule:trading-autopilot_*' 2>&1
    if ($LASTEXITCODE -ne 0) { Log ("leg read failed (redis-cli scan exit " + $LASTEXITCODE + "): " + ((@($keys) | Select-Object -First 3) -join ' ')); return $null }
    $map = @{}
    $paused = @{}
    foreach ($k in @($keys)) {
      $key = ([string]$k).Trim()
      if (-not $key) { continue }
      $raw = docker exec $RedisContainer redis-cli GET $key 2>&1
      if ($LASTEXITCODE -ne 0) { Log ("leg read failed (redis-cli GET " + $key + " exit " + $LASTEXITCODE + ")"); return $null }
      $rec = (($raw | ForEach-Object { [string]$_ }) -join '') | ConvertFrom-Json
      if (([string]$rec.ownerSub -ne [string]$sub) -and ([string]$rec.taskData.userSub -ne [string]$sub)) { continue }
      $ref = $null
      $bid = [string]$rec.taskData.bookId
      if ($bid) { foreach ($b in @($books)) { if ([string]$b.BookId -eq $bid.ToLower()) { $ref = $b.Ref } } }
      elseif ([string]$rec.taskData.mode -eq 'live') { $ref = 'live' }
      if (-not $ref) { continue }
      $st = [string]$rec.status
      if ($st -eq 'active') { $map[$ref] = [string]$rec.id } else { $paused[$ref] = ([string]$rec.id + ' status=' + $st) }
    }
    return @{ Legs = $map; Paused = $paused }
  } catch { Log ("leg read failed: " + $_.Exception.Message); return $null }
}

# Pure: refs (keys of $patterns) with NO "autopilot run complete" line matching their regex.
# Emits the refs one by one (callers wrap in @()) - never `,@(...)`: an @(command) around a
# comma-wrapped array collects the WHOLE array as one element.
function Find-MissingBookBeats($lines, $patterns) {
  $missing = New-Object System.Collections.ArrayList
  foreach ($ref in @($patterns.Keys | Sort-Object)) {
    $hit = $lines | Select-String 'autopilot run complete' | Select-String ([string]$patterns[$ref]) | Select-Object -First 1
    if (-not $hit) { [void]$missing.Add($ref) }
  }
  return $missing.ToArray()
}

# The trading-events leg's per-fire log line. Two spellings are accepted on purpose: the kernel
# reworded it while this landed, and a watchdog that goes blind on a wording change is worse than one
# that accepts either. tests/unit/trading-watchdog-books.spec.ts pins this regex against the source.
$EventsTickPattern = 'event plans \+ protected lots \+ dated orders tick|trading-events leg tick'

# Beat regexes per book ref, plus the leg map they were built from. FAIL-CLOSED: a null (read failure)
# or empty leg map while ENABLED live books exist raises 'legs-unreadable' and STILL requires the
# legacy live leg's beat - never fewer required beats than the retired single-grep check. A genuine
# read FAILURE ($null, as opposed to an honest empty map) also raises when every live book is
# DISABLED, because a disabled book's leg still runs protective exits and blindness there is not a
# quiet state; it adds no beat requirement there, since a disabled book may legitimately have no leg.
function Get-LiveBeatPatterns($books, $legs, $enabledCount) {
  $patterns = @{}
  if (($null -eq $legs) -or ($legs.Count -eq 0)) {
    if (($enabledCount -gt 0) -or ($null -eq $legs)) {
      Raise 'legs-unreadable' ("Watchdog has NO usable autopilot leg map while " + @($books).Count + " live book(s) exist - either the Redis schedule store (docker exec " + $RedisContainer + " redis-cli) could not be read, or no active leg maps to a known book. Treated as a REAL problem (fail-closed): the legacy live leg's beat is still required whenever a book is enabled. Per-book coverage is DOWN until it resolves.")
    }
    if ($enabledCount -gt 0) { $patterns['live'] = 'trading-autopilot_[^"]*_live"' }
    return @{ Patterns = $patterns; Legs = @{} }
  }
  foreach ($ref in @($legs.Keys)) { $patterns[$ref] = '"scheduleId":"' + [regex]::Escape([string]$legs[$ref]) + '"' }
  return @{ Patterns = $patterns; Legs = $legs }
}

# The per-book "this leg logged no run" alerts. The two book states lose DIFFERENT things and get
# their own keys: an ENABLED book with a silent leg loses entries AND protective exits
# ('live-loop-silent-<ref>'); a DISABLED book with a silent ACTIVE leg loses ONLY the protective
# exits ('live-exits-silent-<ref>') - disable means "take no new risk", never "abandon the book" -
# and that is just as much real money at risk. A ref with no book behind it (the fail-closed legacy
# 'live' pattern) keeps the original key.
function Test-MissingBookBeats($lines, $books, $patterns, $legs, $flagNote, $windowMin) {
  $off = @{}
  foreach ($b in @($books)) { if (-not $b.Enabled) { $off[[string]$b.Ref] = $true } }
  foreach ($ref in @(Find-MissingBookBeats $lines $patterns)) {
    $legId = if ($legs.ContainsKey($ref)) { [string]$legs[$ref] } else { 'legacy _live leg' }
    if ($off.ContainsKey($ref)) {
      Raise ('live-exits-silent-' + $ref) ("The autopilot leg for the DISABLED LIVE (real-money) book '" + $ref + "' (schedule " + $legId + ") is ACTIVE but shows NO run in " + $windowMin + "+ min during regular hours. Disabling a book stops NEW entries and rotation ONLY - its PROTECTIVE EXITS (hard stop / take-profit / trailing) still run on every fire, so a silent leg means the open positions in that book have NO stops. " + $flagNote + " Check the schedule and Schwab auth NOW; if the book is meant to be fully stopped, FLATTEN it first, then pause the leg.")
    } else {
      Raise ('live-loop-silent-' + $ref) ("The LIVE (real-money) autopilot leg for book '" + $ref + "' (schedule " + $legId + ") shows NO run in " + $windowMin + "+ min during regular hours while the paper loop is alive - that book may be going unmanaged. " + $flagNote + " Check the schedule and Schwab auth NOW.")
    }
  }
}

# Books with NO active leg. An ENABLED one is either paused - its own alert, because the per-sub
# events tick must never stand in for an autopilot leg somebody stopped - or legless, in which case
# the trading-events leg (pinned lots / event plans / dated orders) is its only scheduled protection.
# That tick is PER SUB: a tick proves the leg ran for the operator, not that each book was processed,
# so 'events-leg-silent' names the leg, never one skipped book.
# A DISABLED one is QUIET BY DESIGN: book off AND no active leg means nothing is expected to run at
# all, and paging on that would train the operator to ignore this whole family of alerts.
function Test-BookLegCoverage($lines, $books, $patterns, $pausedLegs, $flagNote, $windowMin) {
  $paused = if ($null -eq $pausedLegs) { @{} } else { $pausedLegs }
  $legless = @()
  foreach ($b in @($books)) {
    if ($patterns.ContainsKey($b.Ref)) { continue }
    if (-not $b.Enabled) {
      $why = if ($paused.ContainsKey($b.Ref)) { "its leg is paused (" + [string]$paused[$b.Ref] + ")" } else { "it has no autopilot leg" }
      Log ("live book '" + [string]$b.Ref + "' is DISABLED and " + $why + " - nothing scheduled runs for it, so no beat is required (a disabled book with an ACTIVE leg IS required: that leg still runs its protective exits)")
      continue
    }
    if ($paused.ContainsKey($b.Ref)) {
      Raise ('live-leg-paused-' + $b.Ref) ("The LIVE (real-money) autopilot leg for book '" + $b.Ref + "' EXISTS but is NOT active (" + [string]$paused[$b.Ref] + ") while the book is ENABLED - that book runs NO scheduled entries and NO scheduled protective exits, and the per-sub trading-events tick does NOT stand in for it. " + $flagNote + " Resume the leg or disable the book.")
      continue
    }
    $legless += $b.Ref
  }
  if ($legless.Count -gt 0) {
    $tick = $lines | Select-String $EventsTickPattern | Select-Object -First 1
    if (-not $tick) { Raise 'events-leg-silent' ("The trading-events leg (per-sub tick: 'event plans + protected lots + dated orders tick') has NOT fired in " + $windowMin + "+ min during regular hours, and enabled live book(s) " + ($legless -join ', ') + " have NO autopilot leg - that tick is their only scheduled protection (event plans / pinned lots / dated orders). Check the trading-events schedule for the operator sub; a 'TRADING_EVENT_PLANS is off' line is not a beat.") }
  }
}

# Pure (given its inputs): the per-book B2(a) evaluation. $books / $legs may be $null (read failure)
# or empty; both fail CLOSED - the legacy 'live' book / leg is always required at minimum, and the
# assumed book is treated as ENABLED so the fallback is never weaker than before. $books now carries
# DISABLED live books too (a disabled book still runs protective exits); the state matrix is:
#   enabled  + active leg silent -> 'live-loop-silent-<ref>'   (entries AND exits are dead)
#   disabled + active leg silent -> 'live-exits-silent-<ref>'  (protective exits are dead)
#   enabled  + leg paused        -> 'live-leg-paused-<ref>'    (book says run, leg says stopped)
#   enabled  + no leg            -> the per-sub events tick, else 'events-leg-silent'
#   disabled + leg paused/no leg -> silent (logged): both switches are off, nothing should run
# $pausedLegs (ref -> 'id status=<st>') carries the NON-active legs of the same read; $null is read as
# "none known", which only ever ADDS required beats.
function Test-LiveBookBeats($lines, $books, $legs, $multiFlag, $windowMin, $pausedLegs) {
  if ($null -eq $books) {
    Raise 'books-unreadable' ("Watchdog could NOT read the live books from oshal_trading_books (docker exec " + $DbContainer + " psql) - treated as a REAL problem (fail-closed), assuming the legacy 'live' book only. Per-book coverage is DOWN until the read works.")
    $books = @(@{ Ref = 'live'; BookId = ''; Enabled = $true })
  }
  if (@($books).Count -eq 0) { Log 'no live books for the operator sub - per-book live beat check has nothing to require'; return }
  $enabledCount = @(@($books) | Where-Object { $_.Enabled }).Count
  $built = Get-LiveBeatPatterns $books $legs $enabledCount
  $flagNote = if ([string]$multiFlag -eq 'true') { 'TRADING_MULTI_ACCOUNT=true in the api container.' } else { 'TRADING_MULTI_ACCOUNT is NOT true in the api container: per-book schedules hard-skip BY DESIGN - disable the book or arm the flag (scripts/trading-books-cutover.sh --arm).' }
  Test-MissingBookBeats $lines $books $built.Patterns $built.Legs $flagNote $windowMin
  Test-BookLegCoverage $lines $books $built.Patterns $pausedLegs $flagNote $windowMin
}

# A) api health. Retry a few times before declaring down so a single transient blip (or the
# ~90s port-down window of a recreate) does not page - but a genuinely down/crash-looping api
# still fails all attempts and alerts (this check is NOT suppressed by $freshlyRecreated).
$apiUp = $false
foreach ($try in 1..3) {
  try { if ((Invoke-WebRequest 'http://127.0.0.1:35457/api/health' -TimeoutSec 8 -UseBasicParsing).StatusCode -eq 200) { $apiUp = $true; break } } catch {}
  if ($try -lt 3) { Start-Sleep -Seconds 3 }
}
if (-not $apiUp) { Raise 'api-down' 'OSHAL api is NOT responding on 127.0.0.1:35457 - the trading autopilot is NOT running. Bring the stack up (scripts/oshal-up.sh).' }

# ---- wd: book audit ----
# The container-side fetcher for block G. It is a FETCHER: every threshold comparison, key and
# message comes from /tmp/oshal-wd-checks.js (scripts/lib/trading-watchdog-checks.js, copied in by
# Copy-WdChecksModule), which is the file tests/unit/trading-watchdog-checks.spec.ts mutation-proves.
# Reads go through the api's own caller-scoped endpoints with ?book=<ref> (query-first: the store's
# routeBook reads req.query.book first), authenticated with the container's service secret plus the
# canonical base64url sub header (the plain header is sent too, for a kernel that still prefers it) -
# no broker credential ever touches the host. FAIL-CLOSED: a non-2xx or a payload whose array field
# is missing becomes a per-book error, never an empty (healthy-looking) book.
$auditJs = @'
const fs = require("fs");
const C = require("/tmp/oshal-wd-checks.js");
const req = JSON.parse(fs.readFileSync("/tmp/wd-audit-request.json", "utf8"));
let prior = {};
const warnings = [];
// NEVER a silent catch: an absent or truncated state file reads as "nothing was raised before",
// which duplicate-pages every open condition. That is the safe direction, but it has to be VISIBLE
// in the watchdog log or a cp that half-landed looks exactly like a quiet, healthy run.
try { prior = JSON.parse(fs.readFileSync("/tmp/wd-audit-state.json", "utf8")); }
catch (e) { prior = {}; warnings.push("prior suppression state unreadable (" + String((e && e.message) || e) + ") - conditions already raised this window may page again"); }
const sub = String(req.sub || "");
// The canonical encoded header is preferred by the kernel (authz.ts getTrustedServiceUserSub) and
// the legacy plain one is still accepted; send both, and NEITHER when the sub is unknown - an empty
// encoded header fails the decode closed rather than authenticating as nobody.
const H = sub ? {"X-Service-Secret": process.env.SWARM_SERVICE_SECRET,
                 "X-Oshal-User-Sub-B64": Buffer.from(sub, "utf8").toString("base64url"),
                 "X-OSHAL-User-Sub": sub}
              : {"X-Service-Secret": process.env.SWARM_SERVICE_SECRET};
const base = "http://127.0.0.1:5000/api/trading";
// TWO deadlines, and the SECOND one is what makes the promise true. httpMs
// (TRADING_WD_HTTP_TIMEOUT_SEC, default 20) caps ONE read. bookDeadline caps everything this run
// may spend on ONE BOOK - its share of the audit budget the host derives from the exec deadline
// (Get-WdAuditBudgetSec). Without the per-book share, three wedged books at the shipped defaults
// spent 126 seconds against a 60 second host deadline (round-3 review, measured): the child was
// killed and the healthy books' findings died with it. Each read therefore gets whichever is
// smaller, and a book whose share is gone reports THAT rather than borrowing the next book's time.
let httpMs = 20000;
let bookDeadline = Infinity;
async function read(path, book, field) {
  const left = bookDeadline - Date.now();
  if (left <= 0) throw new Error(path + " was not read: this book's share of the audit budget was already spent (fail-closed - the other books keep theirs)");
  const r = await fetch(base + path + "?book=" + encodeURIComponent(book), {headers: H, signal: AbortSignal.timeout(Math.max(250, Math.min(httpMs, left)))});
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(path + " read failed (fail-closed): HTTP " + r.status + ((j && j.error) ? " " + j.error : ""));
  if (field === "account" ? !j.account : !Array.isArray(j[field])) throw new Error(path + " payload has no usable " + field + " (fail-closed)");
  return j;
}
(async () => {
  const findings = [], errors = [], refs = [];
  // A setting that will not parse is REPORTED, not silently defaulted: the module hands back the
  // default and the operator sees the line in the watchdog log.
  const settings = C.defaultSettings(req.settings, (k, v) =>
    warnings.push("watchdog setting " + k + "=" + JSON.stringify(v) + " is not a number - the module default was used"));
  settings.core = C.coreSymbolSet(req.coreHolds);
  settings.bleedBooks = C.bleedBookSet(req.bleedBooks);
  settings.rth = !!req.rth;
  settings.nowMs = Date.now();
  httpMs = Math.max(1000, Math.round(settings.httpTimeoutSec * 1000));
  const auditBook = async (b) => C.evaluateBook(b, {
    account: (await read("/account", b.ref, "account")).account,
    positions: (await read("/positions", b.ref, "positions")).positions,
    orders: (await read("/orders", b.ref, "orders")).orders}, settings);
  const books = req.books || [];
  // Every book gets an EQUAL share of the budget, so one wedged book cannot spend another book's
  // time - the correlated case that matters here is three Schwab books stalling together.
  const budgetMs = Math.max(2000, (Number(req.auditBudgetSec) || 50) * 1000);
  const sliceMs = Math.max(1000, Math.floor(budgetMs / Math.max(1, books.length)));
  for (const b of books) {
    bookDeadline = Date.now() + sliceMs;
    let ev = null;
    try { ev = await auditBook(b); } catch (first) {
      // ONE retry per book, then alert - the same rule the books/legs reads use. A broker read can
      // fail transiently (a Schwab 502) and a page on every blip is the false-alarm spiral this
      // file has fought since 2026-07-13; two failures in a row is a real problem. But NOT after a
      // timeout: a wedge does not clear in two seconds, and retrying one DOUBLED the cost of
      // exactly the failure the deadlines exist to bound. Nor when the book's share is nearly gone.
      const msg = String((first && ((first.name || "") + " " + (first.message || ""))) || first);
      const wedged = /timeout|abort/i.test(msg);
      if (wedged || bookDeadline - Date.now() < 3000) {
        errors.push({ref: b.ref, error: String((first && first.message) || first)});
      } else {
        await new Promise((r) => setTimeout(r, 2000));
        try { ev = await auditBook(b); } catch (second) { errors.push({ref: b.ref, error: String((second && second.message) || second)}); }
      }
    }
    if (!ev) continue;
    refs.push(b.ref);
    for (const f of ev.findings) findings.push(f);
    for (const w of ev.warnings) warnings.push(w);
  }
  const d = C.decideAlerts(prior, findings, {nowMs: settings.nowMs, windowMin: settings.windowMin,
    scope: {refs: refs, kinds: C.evaluatedKinds(settings.rth)}});
  console.log(JSON.stringify({alerts: d.alerts, suppressed: d.suppressed, recovered: d.recovered,
    state: d.state, warnings: warnings, errors: errors, books: refs}));
})().catch(e => { console.log(JSON.stringify({error: String((e && e.message) || e)})); });
'@

# Copies the decidable-checks module into the api container. A module that is missing or cannot be
# copied means blocks G and F cannot DECIDE anything - which is a failed check, not a quiet one.
function Copy-WdChecksModule($path) {
  if (-not (Test-Path $path)) {
    Raise 'wd-checks-unavailable' ("The watchdog's decidable-checks module is MISSING at " + $path + " - the per-book audit (G) and the pre-market gap check (F) cannot run, so this run proves nothing about the books. Restore scripts/lib/trading-watchdog-checks.js or pass -ChecksModule.")
    return $false
  }
  # One copy helper for every file this run puts in the container (fail-closed, deadline-bound);
  # only the alert KEY differs, because 'the checks module is missing' is a different consequence
  # from 'this one check's input is stale'.
  return (Copy-WdIntoApi 'checks-module' $path '/tmp/oshal-wd-checks.js' 'wd-checks-unavailable')
}

# Block G: one exec, every live book. Writes the request + prior suppression state as files (a
# here-string through -e would be at the mercy of PS 5.1 native-argument quoting), runs the fetcher,
# and returns the parsed result - or $null, which Invoke-WdExec has already alerted about.
function Invoke-WdBookAudit($books, $rthFlag, $coreSymbols, $priorState) {
  $request = @{
    sub = $LiveSub; rth = [bool]$rthFlag; coreHolds = [string]$coreSymbols
    # Which books the BLEED finding may fire on. A STRING, so it cannot go through Get-WdSetting
    # (that parses doubles); read straight off the parsed .env map. Blank = every book (fail-open).
    bleedBooks = [string]$(if ($script:WdEnv -and $script:WdEnv.ContainsKey('BLEED_BOOKS')) { $script:WdEnv['BLEED_BOOKS'] } else { '' })
    # DERIVED from the exec deadline below, never a second free-standing number: the fetcher slices
    # this across the books and must always print INSIDE the deadline Invoke-WdExec enforces, or a
    # wedged book takes the healthy books' findings down with it.
    auditBudgetSec = (Get-WdAuditBudgetSec)
    books = @(@($books) | ForEach-Object { @{ ref = [string]$_.Ref; enabled = [bool]$_.Enabled } })
    settings = @{
      alertPct = $LiveAlertPct; deepLossPct = (Get-WdSetting 'DEEP_LOSS_PCT' $null)
      minPositionUsd = (Get-WdSetting 'MIN_POSITION_USD' $null); maxPositions = (Get-WdSetting 'MAX_POSITIONS' $null)
      concentrationPct = (Get-WdSetting 'CONCENTRATION_PCT' $null); hysteresisPct = (Get-WdSetting 'HYSTERESIS_PCT' $null)
      staleOrderMin = (Get-WdSetting 'STALE_ORDER_MIN' $null); windowMin = (Get-WdSetting 'ALERT_WINDOW_MIN' $null)
      httpTimeoutSec = (Get-WdSetting 'HTTP_TIMEOUT_SEC' $null)
    }
  }
  $reqFile = Join-Path $env:TEMP 'wd-audit-request.json'
  $stFile = Join-Path $env:TEMP 'wd-audit-state.json'
  ($request | ConvertTo-Json -Depth 5 -Compress) | Set-Content $reqFile -Encoding ascii
  $priorState | Set-Content $stFile -Encoding ascii
  $jsFile = Join-Path $env:TEMP 'wd-audit.js'
  $auditJs | Set-Content $jsFile -Encoding ascii
  # FAIL-CLOSED on every copy: a silently failed cp leaves the PREVIOUS run's book list and
  # suppression state in the container, and the audit then prints a well-formed result about the
  # wrong books - worse than no result at all.
  if (-not (Copy-WdIntoApi 'book-audit' $reqFile '/tmp/wd-audit-request.json')) { return $null }
  if (-not (Copy-WdIntoApi 'book-audit' $stFile '/tmp/wd-audit-state.json')) { return $null }
  if (-not (Copy-WdIntoApi 'book-audit' $jsFile '/tmp/wd-audit.js')) { return $null }
  $out = Invoke-WdExec 'book-audit' @('exec', $ApiContainer, 'node', '/tmp/wd-audit.js')
  if ($null -eq $out) { return $null }
  try { return ($out | ConvertFrom-Json) } catch {
    Raise 'audit-parse' ("The watchdog could not parse its per-book audit output - treated as a REAL problem, not an all-clear: " + $out.Substring(0, [Math]::Min(300, $out.Length)))
    return $null
  }
}

# Delivery for block G. The module already decided suppression per key, so alerts go through
# Add-WdAlert (not Raise, whose 60-minute key would suppress a WORSENING condition a second time).
# A per-book READ failure is a real problem: a Schwab re-login gets the existing once-daily key,
# anything else gets its own per-book key - never an empty healthy book.
function Send-WdAuditAlerts($r, $statePath) {
  if ($null -eq $r) { return }
  if ($r.error) { Raise 'audit-error' ("The watchdog per-book audit FAILED before it could read any book - treated as a REAL problem (fail-closed): " + [string]$r.error); return }
  foreach ($e in @($r.errors)) {
    if ([string]$e.error -match 'not configured|broker_not_configured|unauthor|401|403|token|reconnect|expired|disconnect|auth') {
      Raise ('live-relogin-' + (Get-Date -Format 'yyyy-MM-dd')) ("Book '" + [string]$e.ref + "' is UNREADABLE - the broker looks disconnected/expired (" + [string]$e.error + "). The watchdog cannot see that book's positions OR its protective orders until you re-login (the ~weekly Schwab refresh). Reconnect from the trading surface.")
    } else {
      Raise ('audit-error-' + [string]$e.ref) ("The watchdog audit of book '" + [string]$e.ref + "' FAILED - treated as a REAL problem (fail-closed), NOT an empty healthy book: " + [string]$e.error)
    }
  }
  foreach ($a in @($r.alerts)) { Add-WdAlert ([string]$a.key) ([string]$a.message) }
  foreach ($k in @($r.suppressed)) { Log ("suppressed (raised recently, not worsening): " + [string]$k) }
  foreach ($k in @($r.recovered)) { Log ("recovered: " + [string]$k) }
  foreach ($w in @($r.warnings)) { Log ("audit warning: " + [string]$w) }
  if ($null -ne $r.state) { Write-WdSymbolState $statePath ($r.state | ConvertTo-Json -Depth 5 -Compress) }
}
# ---- wd: end book audit ----

if ($apiUp) {
 # B0) PRESENCE-of-evidence checks. Deliberately NOT gated by $freshlyRecreated: a matched line is
 # PROOF at any uptime, and the recreate is the fault-INJECTION event -- on 2026-07-16 the api was
 # recreated at 11:36 ET and went blind 11 seconds later, so a freshness gate would hide exactly the
 # thing this must catch. ($freshlyRecreated exists for ABSENCE checks like B and cold reads C/D/E.)
 # ASCII-only patterns: this file is pure ASCII and PS 5.1 mojibakes a literal em dash, so the engine
 # logs these two lines with plain hyphens on purpose. Keep them in sync with trading-schedule-dispatch.
 # RECOVERY-AWARE: alarm only when the engine has NOT recovered since the last bad line. `docker logs`
 # is chronological, so a LineNumber later than the last "run complete" means it is STILL bad. Without
 # this, a recreate's cold-start DNS transient (measured 2026-07-16: two "venue clock unreachable" at
 # +20s/+108s, healthy by +171s) would page on EVERY deploy - and a watchdog that cries wolf on every
 # deploy is one nobody reads (the 07-13..07-15 false-alarm spiral this file already fought).
 # The decidable checks run INSIDE the api container, next to the fetchers that call them.
 $checksReady = Copy-WdChecksModule $ChecksModule

 $presence = docker logs $ApiContainer --since 25m 2>&1
 $lastOkLn = ($presence | Select-String 'autopilot run complete' | Select-Object -Last 1).LineNumber
 $StillBad = { param($pat) $ln = ($presence | Select-String $pat | Select-Object -Last 1).LineNumber; $ln -and ((-not $lastOkLn) -or ($lastOkLn -lt $ln)) }

 if (& $StillBad 'venue clock unreachable') {
   Raise 'engine-blind' ('The trading engine is BLIND and has NOT recovered: the venue clock is unreachable, so it cannot tell whether the market is open and is STANDING DOWN - no entries AND no protective exits (stops/take-profit/trailing) are running. This is the 2026-07-16 outage signature (a pinned public DNS blackholed by a VPN). Check: docker exec ' + $ApiContainer + ' getent hosts api.schwabapi.com. Positions are UNGUARDED until it clears.')
 }
 if ($rth -and (& $StillBad 'TRADING_HALT kill switch engaged')) {
   Raise 'halt-during-rth' ('TRADING_HALT is ENGAGED during regular trading hours - the autopilot is running NO protective exits on the live book. That is fine if you meant it (a gap-down stand-down), but it is NOT a safe resting state with open positions: nothing will stop out. Clear it (.env TRADING_HALT= then recreate oshal-api) or accept that stops are off.')
 }

 if ($freshlyRecreated) {
  Log ("skipped heartbeat + position checks (B/C/D/E): container (re)started " + [math]::Round($uptimeMin,1) + " min ago - the docker-log window is not yet populated and the api may be cold; check A (health) and F (gap) still run")
 } else {
  # The LIVE book roster, read ONCE per run and shared by B2(a) (per-book beats) and G (per-book
  # audit). $null = the read failed; both consumers fail closed on it in their own way.
  $booksRead = Get-ExpectedLiveBooks $LiveSub
  $liveBooks = if ($booksRead.Ok) { @($booksRead.Books) } else { $null }

  # B) autopilot heartbeat (either book) in the last 20 minutes. Only TWO scheduler lines prove
  # the loop is ALIVE-AND-WELL: "autopilot run complete" (fired every ~5 min inside the tradable
  # session) and "autopilot skipped - market closed" (fired outside it, and on weekday holidays).
  # The scheduler ALSO logs "autopilot skipped - market-data or broker keys not configured" and
  # "live autopilot skipped - regular-hours-only" - matching the bare word "skipped" (as the first
  # 07-15 fix did) would treat a broker outage during RTH as healthy, which is exactly the dead-
  # loop case this check must catch. So accept ONLY "run complete" or "skipped ... market closed".
  # 2026-07-16: accepting "market closed" as a heartbeat is what made a 28-min live blackout SILENT --
  # the engine logged it every 5 min while the market was open and the watchdog called that healthy.
  # During RTH on a real trading day a HEALTHY loop can ONLY say "run complete": the engine now logs a
  # blind clock and an engaged halt as their own distinct lines (caught by B0 above), so "market closed"
  # during RTH means the session logic is wrong -- alarm on it instead of accepting it. Outside RTH (and
  # on holidays/half-days, which $rth now knows) "market closed" is the truth and still counts.
  # 2026-07-17: pre-market the scheduler now emits "autopilot skipped - extended hours disabled
  # (TRADING_EXTENDED_HOURS=false)" instead of the market-closed line - the loop is alive and
  # correctly standing down, so OUTSIDE RTH it counts as a beat (false-alarmed 08:07 CT 07-17).
  # During RTH it stays excluded: an extended-hours skip while the market is open would mean the
  # session logic is wrong - that must alarm, same reasoning as the market-closed-in-RTH case.
  $recentLogs = docker logs $ApiContainer --since ([string]$BeatWindowMin + 'm') 2>&1
  $beatPat = if ($rth) { 'autopilot run complete' } else { 'autopilot run complete|autopilot skipped.*market closed|autopilot skipped.*extended hours disabled' }
  $beat = $recentLogs | Select-String $beatPat | Select-Object -First 1
  if (-not $beat) {
    if ($rth -and ($recentLogs | Select-String 'autopilot skipped.*market closed' | Select-Object -First 1)) {
      Raise 'engine-says-closed-in-rth' ('The autopilot is logging "market closed" DURING regular trading hours on a real trading day (' + $etDate + ') - the market IS open, so its session check is wrong and the desk is running NO entries and NO protective exits. Not a holiday/half-day per the watchdog calendar. Investigate the venue clock/calendar path (tradingSession).')
    } else {
      Raise 'autopilot-silent' 'No autopilot heartbeat ("run complete", or a "market closed" / "extended hours disabled" skip outside RTH) in the api logs for 20+ minutes during market hours - the trading loop is not firing (a "keys not configured" / "regular-hours-only" / halt / blind-clock skip does NOT count).'
    }
  }

  # B2) per-book depth (only if SOME beat exists - otherwise B already alerted). Two gaps the plain
  # heartbeat misses: (a) it is book-agnostic, so a healthy PAPER "run complete" masks a dead LIVE
  # loop - and with several live books, ONE live beat masks the others; (b) the scheduler logs
  # "run complete" even when its errors[] is non-empty (broker read
  # failure / rejected protective sell - the 07-07 zombie-fire signature), so a loop failing at its
  # one job every cycle reads healthy. Both are FALSE-NEGATIVES the 2026-07-15 audit flagged.
  if ($beat) {
    # (a) During RTH EVERY enabled live book must show its own dispatch outcome (ADR-134 D2 #7):
    # the expected set comes from oshal_trading_books, the leg ids from the Redis schedule store,
    # and each "autopilot run complete" line is matched on its own "scheduleId". Outside RTH the
    # paper beat is sufficient (live stands down). See Test-LiveBookBeats for the fail-closed rules.
    if ($rth) {
      # The leg read runs EVEN WHEN the books read failed, against the same legacy 'live' book
      # Test-LiveBookBeats assumes in that case. Skipping it made a plain DB blip raise
      # 'legs-unreadable' too, naming a Redis store the run had never consulted.
      $legBooks = if ($null -ne $liveBooks) { $liveBooks } else { @(@{ Ref = 'live'; BookId = '' }) }
      $legRead = $null
      if (@($legBooks).Count -gt 0) { $legRead = Get-AutopilotLegRefs $LiveSub $legBooks }
      $liveLegs = if ($null -ne $legRead) { $legRead.Legs } else { $null }
      $pausedLegs = if ($null -ne $legRead) { $legRead.Paused } else { @{} }
      # Through Invoke-WdExec like every other exec, and via `node -p` rather than printenv:
      # printenv exits 1 for an UNSET variable, which is indistinguishable from a failed exec. The
      # 'wd:' sentinel makes "read fine, value empty" a non-empty output, so only a real exec
      # failure raises check-infra-multi-account-flag.
      $multiRaw = Invoke-WdExec 'multi-account-flag' @('exec', $ApiContainer, 'node', '-p', "'wd:'+(process.env.TRADING_MULTI_ACCOUNT||'')")
      $multiFlag = if ($null -ne $multiRaw) { ($multiRaw -replace '^wd:', '').Trim() } else { '' }
      Test-LiveBookBeats $recentLogs $liveBooks $liveLegs $multiFlag $BeatWindowMin $pausedLegs
    }
    # (b) Any run that completed WITH a non-empty errors[] array. Regex: "errors":[ followed by a
    # non-"]" char means the array has content ("errors":[] does not match).
    $errRuns = $recentLogs | Select-String 'autopilot run complete' | Select-String '"errors":\[[^\]]' | Select-Object -First 3
    if ($errRuns) {
      $errDetail = ($errRuns | ForEach-Object { $_.Line } | Out-String).Trim()
      if ($errDetail.Length -gt 500) { $errDetail = $errDetail.Substring(0, 500) }
      Raise 'autopilot-run-errors' ("The autopilot loop is RUNNING but recent run(s) reported errors[] NON-EMPTY (broker read failure / protective-sell rejection - the 07-07 zombie-fire signature; the loop 'completes' but is not doing its job): " + $errDetail)
    }
  }

  # Core / ':0' operator-holds (TRADING_CORE_SYMBOLS, e.g. SPY:60,SKHY:0) are BY DESIGN exempt from
  # rotation sells, trims, AND all protective exits - a >5%-down core hold with no working sell is
  # the intended state, not a protection failure (07-13 flagged SKHY -8.8% as an "unprotected
  # bleeder" - a false positive). Read the list from the container and exclude those symbols from the
  # bleed filters below. (WD_CORE_HOLDS is passed as the raw "SYM:qty,SYM:qty" string; the JS strips
  # the ':qty'.)
  # Read through Invoke-WdExec (same node -p + 'wd:' sentinel as the flag above): an EMPTY catch
  # here used to turn a failed exec into an empty core-hold set, which silently unexempted every
  # deliberate hold - and the new deep-loss check would then page "HOLDING PAST ITS STOP" once per
  # window per book for a :0 operator hold, the exact 2026-07-13 SKHY false positive in a louder
  # form. A check that cannot read its own exemption list must not conclude: $coreKnown gates every
  # loss conclusion below (C/D and G), and check-infra-core-holds has already said so out loud.
  # ---- wd: core holds ----
  $coreRaw = Invoke-WdExec 'core-holds' @('exec', $ApiContainer, 'node', '-p', "'wd:'+(process.env.TRADING_CORE_SYMBOLS||'')")
  $coreKnown = ($null -ne $coreRaw)
  $coreHolds = if ($coreKnown) { ($coreRaw -replace '^wd:', '').Trim() } else { '' }
  if (-not $coreKnown) { Log 'core-hold list UNREADABLE - the position checks that exempt TRADING_CORE_SYMBOLS (paper C/D and the per-book audit G) are WITHHELD this run; running them blind would page on every deliberate hold.' }
  # ---- wd: end core holds ----

  # C + D) paper book: unprotected bleeders + stranded sells (direct Alpaca from the host via the container env)
  $checkJs = @'
const k=process.env.ALPACA_PAPER_KEY_ID||process.env.ALPACA_KEY_ID, s=process.env.ALPACA_PAPER_SECRET_KEY||process.env.ALPACA_SECRET_KEY;
const H={"APCA-API-KEY-ID":k,"APCA-API-SECRET-KEY":s};
const core=new Set(String(process.env.WD_CORE_HOLDS||"").split(",").map(x=>x.split(":")[0].trim().toUpperCase()).filter(Boolean));
(async()=>{
  const pos=await (await fetch("https://paper-api.alpaca.markets/v2/positions",{headers:H})).json();
  const open=await (await fetch("https://paper-api.alpaca.markets/v2/orders?status=open&limit=100",{headers:H})).json();
  const sells=new Set(open.filter(o=>o.side==="sell").map(o=>o.symbol));
  const pct=Number(process.env.WD_ALERT_PCT||5);
  const bleed=pos.filter(p=>Number(p.unrealized_plpc)*100<=-pct && !sells.has(p.symbol) && !core.has(String(p.symbol).toUpperCase()))
    .map(p=>p.symbol+" "+(Number(p.unrealized_plpc)*100).toFixed(1)+"% ($"+Number(p.unrealized_pl).toFixed(0)+")");
  const now=Date.now();
  const stale=open.filter(o=>o.side==="sell" && now-Date.parse(o.submitted_at)>30*60*1000)
    .map(o=>o.symbol+" x"+o.qty+" limit@"+o.limit_price+" age="+Math.round((now-Date.parse(o.submitted_at))/60000)+"min");
  console.log(JSON.stringify({bleed,stale}));
})().catch(e=>{console.log(JSON.stringify({error:String(e&&e.message||e)}))});
'@
  $tmp = Join-Path $env:TEMP 'wd-check.js'
  $checkJs | Set-Content $tmp -Encoding ascii
  # Through Invoke-WdExec: an exec that returns NOTHING used to parse to $null and fall through every
  # if ($r.error) / if ($r.bleed) test below without a sound - a check that did not run reading as
  # a check that PASSED. That is the rule this wrapper exists to make impossible. The cp is
  # fail-closed for the same reason (a stale /tmp/wd-check.js still prints a well-formed result).
  $out = $null
  if ($coreKnown -and (Copy-WdIntoApi 'paper-positions' $tmp '/tmp/wd-check.js')) {
    $out = Invoke-WdExec 'paper-positions' @('exec', '-e', ('WD_ALERT_PCT=' + $AlertPct.ToString([Globalization.CultureInfo]::InvariantCulture)), '-e', ('WD_CORE_HOLDS=' + $coreHolds), $ApiContainer, 'node', '/tmp/wd-check.js')
  }
  if ($null -ne $out) {
   try {
    $r = $out | ConvertFrom-Json
    if ($r.error) { Raise 'check-error' ("watchdog position check failed: " + $r.error) }
    # Suppression keys must be STABLE across runs, so key on the SYMBOL SET only. The full
    # detail strings embed age=/percent values that change every run - no two runs ever made
    # the same key, the 60-min suppression never matched, and a persisting condition emailed
    # every 10 minutes all day (observed 2026-07-08). Detail stays in the message.
    # Only conclude "unprotected" during RTH: pre-market / after-hours the autopilot has no resting
    # intraday sells by design, so "down >5%, no working sell" is expected then, not a failure.
    if ($rth -and $r.bleed -and @($r.bleed).Count -gt 0) {
      $bleedKey = 'bleed-' + ((@($r.bleed) | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object) -join ',')
      Raise $bleedKey ("PAPER position(s) down more than " + $AlertPct + " percent during regular hours with no working sell: " + (@($r.bleed) -join '; ') + ". The strategy exits via market orders each run (rests no stops), so this is a failure only if the loop is not exiting them - check the api logs / heartbeat.")
    }
    if ($r.stale -and @($r.stale).Count -gt 0) {
      $staleKey = 'stale-' + ((@($r.stale) | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object) -join ',')
      Raise $staleKey ("STRANDED sell order(s) older than 30 min (limit the market fell away from - the 07-07 lockout signature): " + (@($r.stale) -join '; '))
    }
   } catch { Raise 'check-parse' ("watchdog could not parse position check output: " + ($out | Out-String).Substring(0, [Math]::Min(200, ($out | Out-String).Length))) }
  }

  # G) EVERY LIVE BOOK (Schwab, real money) - replaces the single-book check E (2026-07-08..2026-09-06),
  # which audited only ?mode=live, i.e. the legacy book: with three live books on the roster that left
  # two real-money accounts with NOTHING watching them. Same reads (positions from the broker, working
  # sells from the order ledger, through the api's caller-scoped endpoints with the container's service
  # secret - no broker keys on the host), now per book and with the account snapshot as well, and every
  # conclusion decided by scripts/lib/trading-watchdog-checks.js:
  #   bleed / deep-loss (RTH-only, same reasoning as the paper book: pre- and post-market a live
  #     position with no resting sell is expected, not a protection failure - the 07-15 AMAT spam)
  #   stranded-sell / negative funds / position count / concentration (true at any hour)
  # Suppression is per book AND per symbol with a worsening band, so a persisting condition pages once
  # per window instead of every 10 minutes, and a DEEPENING one still pages.
  # $coreKnown: see the core-hold read above - without the exemption list every deliberate hold
  # reads as a bleeder and a stop-buster. check-infra-core-holds already alerted, so this is a
  # NAMED withholding, never a silent skip.
  # ---- wd: audit gate ----
  if ($checksReady -and $coreKnown) {
    $auditBooks = if ($null -ne $liveBooks) { @($liveBooks) } else { @(@{ Ref = 'live'; BookId = ''; Enabled = $true }) }
    if ($null -eq $liveBooks) {
      # Its OWN key: the beat check above raises 'books-unreadable' from the same run, and a shared
      # key meant this more specific text ("the audit fell back too") was swallowed by the 60-minute
      # suppressor and never reached the operator.
      Raise 'books-unreadable-audit' ("Watchdog could NOT read the live books from oshal_trading_books (docker exec " + $DbContainer + " psql) - treated as a REAL problem (fail-closed): the per-book position/account audit ALSO falls back to the legacy 'live' book, so any OTHER live book's positions, working sells and account shape are unwatched until the read works.")
    }
    if (@($auditBooks).Count -gt 0) {
      $auditResult = Invoke-WdBookAudit $auditBooks $rth $coreHolds (Read-WdSymbolState $symStateFile)
      Send-WdAuditAlerts $auditResult $symStateFile
    }
  }
  # ---- wd: end audit gate ----
 } # end: else (container not freshly recreated) - B/C/D/G

  # F) PRE-MARKET GAP ALERT (08:00-09:29 ET only). SPY's pre-market tape is the futures proxy we
  # have: if it is gapping down >= GapAlertPct vs yesterday's close, tell the operator BEFORE the
  # open fire deploys new entries, with the halt instructions in the message. This is an ALERT
  # ONLY - the trading algorithm is untouched (live==paper parity); the human decides. Added
  # 2026-07-08 night before the first full-account (52K) open, operator ask: "watch pre-market,
  # look at futures, stop the buy" - the automated entry-filter version goes through paper first.
  # $checksReady gates it: the gap DECISION (real size, real recency, quote-mid corroboration) is
  # the module's, and wd-checks-unavailable has already alerted - running the fetcher without it
  # would only add a second alert for the same cause.
  if ($checksReady -and $et.Hour -ge 8 -and ($et.Hour -lt 9 -or ($et.Hour -eq 9 -and $et.Minute -lt 30))) {
    $gapJs = @'
const C=require("/tmp/oshal-wd-checks.js");
const k=process.env.ALPACA_PAPER_KEY_ID||process.env.ALPACA_KEY_ID, s=process.env.ALPACA_PAPER_SECRET_KEY||process.env.ALPACA_SECRET_KEY;
const H={"APCA-API-KEY-ID":k,"APCA-API-SECRET-KEY":s};
(async()=>{
  const now=new Date(); const today=now.toISOString().slice(0,10);
  const start=new Date(now.getTime()-9*86400e3).toISOString();
  const bj=await (await fetch("https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start="+encodeURIComponent(start)+"&adjustment=all&feed=iex&limit=10",{headers:H})).json();
  const bars=(bj&&bj.bars)||[];
  const prior=bars.filter(b=>String(b.t).slice(0,10)<today).pop();
  const tj=await (await fetch("https://data.alpaca.markets/v2/stocks/SPY/trades/latest?feed=iex",{headers:H})).json();
  const qj=await (await fetch("https://data.alpaca.markets/v2/stocks/SPY/quotes/latest?feed=iex",{headers:H})).json();
  // The DECISION is the module's: a gap pages only on a print with real size, real recency and a
  // two-sided quote whose mid crosses the same threshold (one thin stale odd-lot print is the
  // classic pre-market false alarm). Everything here is fetching.
  const r=C.assessGapPrint({trade:tj&&tj.trade,quote:qj&&qj.quote,priorClose:prior?prior.c:null,
    todayIso:today,nowMs:now.getTime(),minSize:Number(process.env.WD_GAP_MIN_SIZE||100),
    maxAgeMin:Number(process.env.WD_GAP_MAX_AGE_MIN||15),gapPct:Number(process.env.WD_GAP_PCT||1)});
  if(r.skip){console.log(JSON.stringify(r));return;}
  console.log(JSON.stringify(Object.assign({priorClose:prior.c,asOf:tj.trade.t},r)));
})().catch(e=>{console.log(JSON.stringify({error:String(e&&e.message||e)}))});
'@
    $tmpG = Join-Path $env:TEMP 'wd-check-gap.js'
    $gapJs | Set-Content $tmpG -Encoding ascii
    $inv = [Globalization.CultureInfo]::InvariantCulture
    $outG = $null
    if (Copy-WdIntoApi 'premarket-gap' $tmpG '/tmp/wd-check-gap.js') {
     $outG = Invoke-WdExec 'premarket-gap' @('exec',
      '-e', ('WD_GAP_PCT=' + $GapAlertPct.ToString($inv)),
      '-e', ('WD_GAP_MIN_SIZE=' + ([double](Get-WdSetting 'GAP_MIN_PRINT_SIZE' 100)).ToString($inv)),
      '-e', ('WD_GAP_MAX_AGE_MIN=' + ([double](Get-WdSetting 'GAP_MAX_PRINT_AGE_MIN' 15)).ToString($inv)),
      $ApiContainer, 'node', '/tmp/wd-check-gap.js')
    }
    if ($null -ne $outG) {
     try {
      $rg = $outG | ConvertFrom-Json
      if ($rg.alert) {
        $k = 'premarket-gap-' + (Get-Date -Format 'yyyy-MM-dd')
        Raise $k ("PRE-MARKET GAP DOWN: SPY " + $rg.gap + " percent vs yesterday's close (" + $rg.last + " vs " + $rg.priorClose + ", quote mid " + $rg.mid + " = " + $rg.midGap + " percent, print size " + $rg.size + " as of " + $rg.asOf + "). The open fire WILL place new entries unless you halt. To skip today's buying: edit .env TRADING_HALT=true then 'docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api' (~90s). Instant hard stop instead: 'docker stop " + $ApiContainer + "' (stops EVERYTHING incl. exits - prefer the halt).")
      }
      # Surface skip reasons + a malformed response so a silently-broken F check is visible in the log
      # (was an empty `catch {}` - the one before-the-open warning could never-fire with no trace).
      elseif ($rg.skip) { Log ("gap check skipped: " + $rg.skip) }
      elseif ($rg.error) { Log ("gap check error (SPY pre-market read): " + $rg.error) }
      else { Log ("gap check: SPY " + $rg.gap + " percent (mid " + $rg.midGap + " percent), no alert") }
     } catch { Log ("gap check output unparseable: " + ($outG | Out-String).Trim()) }
    }
  }
}

# Deliver alerts: email via the api container when up; always the log + Windows event log.
if ($alerts.Count -gt 0) {
  $body = ($alerts -join "`n`n") + "`n`n-- OSHAL trading watchdog on $env:COMPUTERNAME"
  if ($apiUp) {
    $sendOut = docker exec $ApiContainer node /app/scripts/oshal-send-alert.js "OSHAL TRADING ALERT" "$body" 2>&1 | Out-String
    Log ("email: " + $sendOut.Trim())
  }
  try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('OSHAL-Watchdog')) { New-EventLog -LogName Application -Source 'OSHAL-Watchdog' }
    Write-EventLog -LogName Application -Source 'OSHAL-Watchdog' -EntryType Warning -EventId 1001 -Message $body
  } catch {}
}
($state | ConvertTo-Json) | Set-Content $stateFile -Encoding ascii
exit 0
