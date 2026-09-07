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
      $booksRead = Get-ExpectedLiveBooks $LiveSub
      $liveBooks = if ($booksRead.Ok) { @($booksRead.Books) } else { $null }
      # The leg read runs EVEN WHEN the books read failed, against the same legacy 'live' book
      # Test-LiveBookBeats assumes in that case. Skipping it made a plain DB blip raise
      # 'legs-unreadable' too, naming a Redis store the run had never consulted.
      $legBooks = if ($null -ne $liveBooks) { $liveBooks } else { @(@{ Ref = 'live'; BookId = '' }) }
      $legRead = $null
      if (@($legBooks).Count -gt 0) { $legRead = Get-AutopilotLegRefs $LiveSub $legBooks }
      $liveLegs = if ($null -ne $legRead) { $legRead.Legs } else { $null }
      $pausedLegs = if ($null -ne $legRead) { $legRead.Paused } else { @{} }
      $multiFlag = ''
      try { $multiFlag = docker exec $ApiContainer printenv TRADING_MULTI_ACCOUNT 2>$null | Select-Object -First 1 } catch { Log ("could not read TRADING_MULTI_ACCOUNT from " + $ApiContainer + ": " + $_.Exception.Message) }
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
  $coreHolds = ''
  try { $coreHolds = docker exec $ApiContainer printenv TRADING_CORE_SYMBOLS 2>$null | Select-Object -First 1 } catch {}

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
  docker cp $tmp ($ApiContainer + ':/tmp/wd-check.js') 2>$null | Out-Null
  $out = docker exec -e WD_ALERT_PCT=$AlertPct -e WD_CORE_HOLDS=$coreHolds $ApiContainer node /tmp/wd-check.js 2>$null
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

  # E) LIVE book (Schwab, real money): the same unprotected-bleeder + stranded-sell checks.
  # Added 2026-07-08 when the live cap went to the FULL account (52K) - until then the watchdog
  # audited paper only, which the 07-08 incident review flagged as the remaining gap. Reads go
  # through the api's own caller-scoped endpoints (positions from Schwab, working sells from the
  # order ledger) using the container's service secret - no broker keys touch the host.
  $liveJs = @'
const SEC=process.env.SWARM_SERVICE_SECRET, SUB=process.env.WD_LIVE_SUB;
const H={"X-Service-Secret":SEC,"X-OSHAL-User-Sub":SUB};
const base="http://127.0.0.1:5000/api/trading";
const core=new Set(String(process.env.WD_CORE_HOLDS||"").split(",").map(x=>x.split(":")[0].trim().toUpperCase()).filter(Boolean));
(async()=>{
  // FAIL-CLOSED: a Schwab-disconnected book returns HTTP 503 with {error:...}. The old
  // (pj&&pj.positions)||[] read that as an EMPTY (=healthy) book, silencing the real-money safety
  // net exactly during the weekly token-expiry window. Assert response.ok AND an array payload;
  // otherwise return an explicit error so the PS side raises instead of reading "all clear".
  const pr=await fetch(base+"/positions?mode=live",{headers:H});
  const pj=await pr.json().catch(()=>null);
  if(!pr.ok||!pj||!Array.isArray(pj.positions)){console.log(JSON.stringify({error:"live positions read failed (fail-closed): HTTP "+pr.status+((pj&&pj.error)?" "+pj.error:"")}));return;}
  const pos=pj.positions;
  const or=await fetch(base+"/orders?mode=live",{headers:H});
  const oj=await or.json().catch(()=>null);
  if(!or.ok||!oj||!Array.isArray(oj.orders)){console.log(JSON.stringify({error:"live orders read failed (fail-closed): HTTP "+or.status+((oj&&oj.error)?" "+oj.error:"")}));return;}
  const orders=oj.orders;
  const working=orders.filter(o=>o.side==="sell"&&["pending","accepted","partially_filled"].includes(o.status));
  const sells=new Set(working.map(o=>String(o.symbol).toUpperCase()));
  const pct=Number(process.env.WD_ALERT_PCT||5);
  const bleed=pos.filter(p=>{const cost=p.qty*p.avgEntryPrice;const plpc=cost>0?(p.unrealizedPl/cost)*100:0;
      return plpc<=-pct&&!sells.has(String(p.symbol).toUpperCase())&&!core.has(String(p.symbol).toUpperCase());})
    .map(p=>{const cost=p.qty*p.avgEntryPrice;return p.symbol+" "+((p.unrealizedPl/cost)*100).toFixed(1)+"% ($"+Number(p.unrealizedPl).toFixed(0)+")";});
  const now=Date.now();
  const stale=working.filter(o=>now-Date.parse(o.created_at)>30*60*1000)
    .map(o=>o.symbol+" x"+o.qty+(o.limit_price?" limit@"+o.limit_price:"")+" age="+Math.round((now-Date.parse(o.created_at))/60000)+"min");
  console.log(JSON.stringify({bleed,stale}));
})().catch(e=>{console.log(JSON.stringify({error:String(e&&e.message||e)}))});
'@
  $tmpL = Join-Path $env:TEMP 'wd-check-live.js'
  $liveJs | Set-Content $tmpL -Encoding ascii
  docker cp $tmpL ($ApiContainer + ':/tmp/wd-check-live.js') 2>$null | Out-Null
  $outL = docker exec -e WD_ALERT_PCT=$AlertPct -e WD_LIVE_SUB=$LiveSub -e WD_CORE_HOLDS=$coreHolds $ApiContainer node /tmp/wd-check-live.js 2>$null
  try {
    $rl = $outL | ConvertFrom-Json
    if ($rl.error) {
      # A Schwab auth/config failure is the EXPECTED weekly re-login, not a code fault - give it a
      # once-daily key + reconnect text so it does not repeat hourly. Anything else is treated as a
      # REAL problem (fail-closed): the live safety net is down, NOT an all-clear.
      if ($rl.error -match 'not configured|broker_not_configured|unauthor|401|403|token|reconnect|expired|disconnect|auth') {
        Raise ('live-relogin-' + (Get-Date -Format 'yyyy-MM-dd')) ("LIVE (real-money) book is UNREADABLE - Schwab looks disconnected/expired (" + $rl.error + "). The watchdog cannot see live positions OR protective orders until you re-login (the ~weekly Schwab refresh). Reconnect Schwab from the trading surface.")
      } else {
        Raise 'live-check-error' ("watchdog LIVE position check failed - treated as a REAL problem (fail-closed), NOT an empty healthy book: " + $rl.error)
      }
    }
    # RTH-only, same reasoning as the paper book: pre/post-market a live position with no resting
    # sell is expected, not an unprotected-risk failure (the 07-15 real-money AMAT spam was pre-open).
    if ($rth -and $rl.bleed -and @($rl.bleed).Count -gt 0) {
      $k = 'live-bleed-' + ((@($rl.bleed) | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object) -join ',')
      Raise $k ("LIVE (REAL MONEY) position(s) down more than " + $AlertPct + " percent during regular hours: " + (@($rl.bleed) -join '; ') + ". NOTE: the live strategy exits via MARKET orders at each 5-min run and rests NO protective stops on the venue - so 'no working sell' is normal, and this is only a real failure if the loop is NOT exiting them. Confirm the autopilot is firing (look for any 'live-loop-silent' or 'run errors' alert) and that the synthetic stop should have triggered. Core/':0' holds are excluded; manual Schwab stops are invisible to the ledger.")
    }
    if ($rl.stale -and @($rl.stale).Count -gt 0) {
      $k = 'live-stale-' + ((@($rl.stale) | ForEach-Object { ($_ -split ' ')[0] } | Sort-Object) -join ',')
      Raise $k ("LIVE (REAL MONEY) stranded sell order(s) older than 30 min: " + (@($rl.stale) -join '; '))
    }
  } catch { Raise 'live-check-parse' ("watchdog could not parse LIVE check output: " + ($outL | Out-String).Substring(0, [Math]::Min(200, ($outL | Out-String).Length))) }
 } # end: else (container not freshly recreated) - B/C/D/E

  # F) PRE-MARKET GAP ALERT (08:00-09:29 ET only). SPY's pre-market tape is the futures proxy we
  # have: if it is gapping down >= GapAlertPct vs yesterday's close, tell the operator BEFORE the
  # open fire deploys new entries, with the halt instructions in the message. This is an ALERT
  # ONLY - the trading algorithm is untouched (live==paper parity); the human decides. Added
  # 2026-07-08 night before the first full-account (52K) open, operator ask: "watch pre-market,
  # look at futures, stop the buy" - the automated entry-filter version goes through paper first.
  if ($et.Hour -ge 8 -and ($et.Hour -lt 9 -or ($et.Hour -eq 9 -and $et.Minute -lt 30))) {
    $gapJs = @'
const k=process.env.ALPACA_PAPER_KEY_ID||process.env.ALPACA_KEY_ID, s=process.env.ALPACA_PAPER_SECRET_KEY||process.env.ALPACA_SECRET_KEY;
const H={"APCA-API-KEY-ID":k,"APCA-API-SECRET-KEY":s};
(async()=>{
  const now=new Date(); const today=now.toISOString().slice(0,10);
  const start=new Date(now.getTime()-9*86400e3).toISOString();
  const bj=await (await fetch("https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start="+encodeURIComponent(start)+"&adjustment=all&feed=iex&limit=10",{headers:H})).json();
  const bars=(bj&&bj.bars)||[];
  const prior=bars.filter(b=>String(b.t).slice(0,10)<today).pop();
  const tj=await (await fetch("https://data.alpaca.markets/v2/stocks/SPY/trades/latest?feed=iex",{headers:H})).json();
  const tr=tj&&tj.trade;
  if(!prior||!tr){console.log(JSON.stringify({skip:"no prior close or no trade"}));return;}
  if(String(tr.t).slice(0,10)!==today){console.log(JSON.stringify({skip:"no pre-market print yet"}));return;}
  const gap=(Number(tr.p)/Number(prior.c)-1)*100;
  console.log(JSON.stringify({gap:Number(gap.toFixed(2)),last:tr.p,priorClose:prior.c,asOf:tr.t}));
})().catch(e=>{console.log(JSON.stringify({error:String(e&&e.message||e)}))});
'@
    $tmpG = Join-Path $env:TEMP 'wd-check-gap.js'
    $gapJs | Set-Content $tmpG -Encoding ascii
    docker cp $tmpG ($ApiContainer + ':/tmp/wd-check-gap.js') 2>$null | Out-Null
    $outG = docker exec $ApiContainer node /tmp/wd-check-gap.js 2>$null
    try {
      $rg = $outG | ConvertFrom-Json
      if ($null -ne $rg.gap -and [double]$rg.gap -le (-1 * $GapAlertPct)) {
        $k = 'premarket-gap-' + (Get-Date -Format 'yyyy-MM-dd')
        Raise $k ("PRE-MARKET GAP DOWN: SPY " + $rg.gap + " percent vs yesterday's close (" + $rg.last + " vs " + $rg.priorClose + ", as of " + $rg.asOf + "). The open fire WILL place new entries unless you halt. To skip today's buying: edit .env TRADING_HALT=true then 'docker compose -f docker-compose.oshal-local.yml up -d --force-recreate --no-deps oshal-api' (~90s). Instant hard stop instead: 'docker stop " + $ApiContainer + "' (stops EVERYTHING incl. exits - prefer the halt).")
      }
      # Surface skip reasons + a malformed response so a silently-broken F check is visible in the log
      # (was an empty `catch {}` - the one before-the-open warning could never-fire with no trace).
      elseif ($rg.skip) { Log ("gap check skipped: " + $rg.skip) }
      elseif ($rg.error) { Log ("gap check error (SPY pre-market read): " + $rg.error) }
    } catch { Log ("gap check output unparseable: " + ($outG | Out-String).Trim()) }
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
