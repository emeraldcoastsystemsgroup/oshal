#!/usr/bin/env bash
# trading-books-cutover.sh — ADR-134 PR4: arm multi-account trading books. REFUSES BY DEFAULT.
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — precondition-gated cutover: refuses unless (a) zero NULL book_ids on every user-bearing trading table, (b) broker-account discovery has run, (c) the legacy live book links unambiguously to its discovered account (SCHWAB_ACCOUNT_NUMBER match, else the SINGLE discovered account; ambiguity refuses), (d) --arm was passed. Then: applies migration 125 (side-store PK swaps — without them a second live book's HWM write raises unique_violation and the fail-closed breaker halts it), links the legacy book, flips TRADING_MULTI_ACCOUNT=true in .env, recreates the api (env changes need a recreate), and post-checks flag visibility + health. NEVER re-POSTs autopilot schedules (a blind re-POST forks a digest twin id that double-fires the real account — adversarial-review blocker; legacy schedules keep their ids, new books get their legs minted by the store autopilot route when enabled). Post-cutover rollback doctrine: flag-off + roll-forward ONLY (per-book schedules hard-skip flag-off by PR1 design).
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Every docker target is an env knob: TRADING_DB_CONTAINER / TRADING_DB_USER / TRADING_DB_NAME / TRADING_API_CONTAINER (compose defaults). Precondition 5 parameterised the api and redis names while the psql chokepoint and the post-cutover health/flag probes still carried literals, so the file contradicted itself on a nonstandard compose project.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Precondition 5 — the observability pair (ADR-134 D2 #7) must exist BEFORE a second live book can be armed: (a) the host watchdog derives its expected live set FROM oshal_trading_books (no hand-known '_live' grep), (b) that watchdog is actually scheduled on the host (schtasks task TRADING_WATCHDOG_TASK_NAME, or TRADING_WATCHDOG_TASK_QUERY for a non-Windows host), (c) the RUNNING api image carries the per-book report module + site-oshal-report.js and the three report scripts require it (a runtime probe, not a Dockerfile pin — the image is what the weekly publisher execs), (d) the Redis schedule store the watchdog maps legs from answers PING. Each refusal names its remediation. Probe (c) greps each of the three scripts SEPARATELY: `grep -q pat f1 f2 f3` exits 0 on ANY match, which would have passed the gate with two scripts still un-repointed.
#
# Usage:
#   bash scripts/trading-books-cutover.sh            # dry-run: print every precondition verdict
#   bash scripts/trading-books-cutover.sh --arm      # execute the cutover (market-closed window!)

set -euo pipefail
cd "$(dirname "$0")/.."

ARM=0
[ "${1:-}" = "--arm" ] && ARM=1

# Every docker target is a knob (config -> env -> compose default), so this file is consistent with
# the precondition-5 probes below and with the watchdog's parameters. Nothing here is hardcoded.
DB_CONTAINER="${TRADING_DB_CONTAINER:-oshal-local-db}"
DB_USER="${TRADING_DB_USER:-oshal}"
DB_NAME="${TRADING_DB_NAME:-oshal}"
API_CONTAINER="${TRADING_API_CONTAINER:-oshal-local-api}"
PSQL="docker exec $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -tA -c"
fail() { echo "REFUSED: $*" >&2; exit 1; }
note() { echo "[cutover] $*"; }

# ── Precondition 5: the observability pair is in place (ADR-134 D2 #7) ───────────────────────────
# A second live book must never run behind a watchdog that cannot see its beat or a report that
# merges its curve into another account's. Env knobs (config → env → default):
#   TRADING_WATCHDOG_SCRIPT      host watchdog source        (scripts/trading-watchdog.ps1)
#   TRADING_WATCHDOG_TASK_NAME   Windows scheduled-task name (OSHAL Trading Watchdog)
#   TRADING_WATCHDOG_TASK_QUERY  command that exits 0 when the watchdog is scheduled on a
#                                non-Windows host (default: schtasks query of the task name)
#   TRADING_API_CONTAINER / TRADING_REDIS_CONTAINER   compose container names
#   TRADING_DB_CONTAINER / TRADING_DB_USER / TRADING_DB_NAME   the psql chokepoint (top of file)
check_observability_pair() {
  local wd="${TRADING_WATCHDOG_SCRIPT:-scripts/trading-watchdog.ps1}"
  local task="${TRADING_WATCHDOG_TASK_NAME:-OSHAL Trading Watchdog}"
  # Self-contained on purpose: the spec extracts this function and runs it under `set -u` without
  # the file's top-level assignments, so it must resolve its own default.
  local api="${API_CONTAINER:-${TRADING_API_CONTAINER:-oshal-local-api}}"
  local redis="${TRADING_REDIS_CONTAINER:-oshal-local-redis}"
  # (a) books-derived watchdog source
  [ -f "$wd" ] || fail "watchdog source $wd not found — pull main (ADR-134 D2 #7 watchdog) or set TRADING_WATCHDOG_SCRIPT"
  grep -q "FROM oshal_trading_books" "$wd" \
    || fail "watchdog $wd does not derive its live set FROM oshal_trading_books — pull the ADR-134 D2 #7 watchdog before arming a second live book"
  if grep -q "Select-String '_live'" "$wd"; then
    fail "watchdog $wd still greps the hand-known '_live' schedule id — pull the ADR-134 D2 #7 watchdog"
  fi
  # (b) the watchdog is actually scheduled on the host
  if [ -n "${TRADING_WATCHDOG_TASK_QUERY:-}" ]; then
    sh -c "$TRADING_WATCHDOG_TASK_QUERY" >/dev/null 2>&1 \
      || fail "TRADING_WATCHDOG_TASK_QUERY exited non-zero — the host watchdog is not scheduled; register it first"
  else
    command -v schtasks >/dev/null 2>&1 \
      || fail "schtasks not available — this deployment is Windows-hosted per the runbook; on another host set TRADING_WATCHDOG_TASK_QUERY to a command that exits 0 when the watchdog is scheduled"
    schtasks //query //tn "$task" >/dev/null 2>&1 \
      || fail "scheduled task '$task' is not registered — register it (see the header of $wd) or set TRADING_WATCHDOG_TASK_NAME"
  fi
  # (c) the RUNNING image carries the per-book report module and the scripts that use it.
  #     Each consumer is probed on its own: `grep -q pat f1 f2 f3` exits 0 when ANY one file
  #     matches, which would pass this gate with two of the three scripts still un-repointed.
  docker exec "$api" sh -c 'test -f /app/scripts/lib/trading-book-report.js || exit 1
for f in /app/scripts/site-oshal-report.js /app/scripts/oshal-deck-data.js /app/scripts/oshal-report-journal.js; do
  test -f "$f" || exit 1
  grep -q trading-book-report "$f" || exit 1
done' \
    || fail "api image lacks the per-book report module (scripts/lib/trading-book-report.js + site-oshal-report.js requiring it) — deploy core first (bash scripts/oshal-deploy.sh)"
  # (d) the Redis schedule store the watchdog maps autopilot legs from is reachable
  [ "$(docker exec "$redis" redis-cli PING 2>/dev/null | tr -d '\r')" = "PONG" ] \
    || fail "redis container $redis does not answer PING — the watchdog cannot map autopilot legs to books; fix the stack (or set TRADING_REDIS_CONTAINER)"
  note "observability pair present: books-derived watchdog scheduled, per-book report module in the image, schedule store reachable ✓"
}

# ── Precondition 1: market closed (never cut over mid-session) ────────────────────────────────────
ET_HOUR=$(TZ=America/New_York date +%H)
ET_DOW=$(TZ=America/New_York date +%u)
if [ "$ET_DOW" -le 5 ] && [ "$ET_HOUR" -ge 9 ] && [ "$ET_HOUR" -lt 16 ]; then
  fail "US market hours (ET) — run after 16:00 ET or on a weekend"
fi
note "market-closed window ✓"

# ── Precondition 2: zero NULL book_ids on user-bearing rows ───────────────────────────────────────
for t in oshal_trading_orders oshal_trading_signals oshal_trading_decisions oshal_trading_equity_hwm \
         oshal_trading_peaks oshal_trading_daily_equity oshal_trading_rotation_state oshal_trading_gate_blocks; do
  n=$($PSQL "SELECT count(*) FROM $t WHERE book_id IS NULL AND user_sub IS NOT NULL")
  [ "$n" = "0" ] || fail "$t has $n NULL book_id rows — the PR1 backfill has not converged (redeploy / rerun rails first)"
done
note "book_id backfill converged on all 8 tables ✓"

# ── Precondition 3: discovery has run ─────────────────────────────────────────────────────────────
acct_count=$($PSQL "SELECT count(*) FROM oshal_trading_accounts WHERE broker='schwab'")
[ "$acct_count" != "0" ] || fail "no discovered Schwab accounts — connect Schwab (all accounts checked on the consent screen), then POST /api/trading/accounts/discover"
note "discovered schwab accounts: $acct_count ✓"

# ── Precondition 4: the legacy live book links to exactly ONE discovered account ─────────────────
PIN=$(grep -E '^SCHWAB_ACCOUNT_NUMBER=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)
if [ -n "$PIN" ]; then
  # The env pin decides — exactly the adapter's own selection rule, so linking cannot change
  # which account trades. Match via last4 (numbers are encrypted at rest; the pin is plaintext env).
  LINK_WHERE="a.account_last4 = right('$PIN', 4)"
else
  [ "$acct_count" = "1" ] || fail "no SCHWAB_ACCOUNT_NUMBER pin and $acct_count accounts discovered — ambiguous legacy-book link; set the pin or bind by hand"
  LINK_WHERE="true"
fi
link_n=$($PSQL "SELECT count(*) FROM oshal_trading_accounts a WHERE a.broker='schwab' AND $LINK_WHERE")
[ "$link_n" = "1" ] || fail "legacy live-book link matched $link_n accounts (want exactly 1)"
note "legacy live book links unambiguously ✓"

check_observability_pair

if [ "$ARM" -ne 1 ]; then
  note "DRY RUN COMPLETE — every precondition passed. Re-run with --arm to cut over."
  exit 0
fi

# ── Execute ───────────────────────────────────────────────────────────────────────────────────────
note "applying migration 125 (side-store PK swaps)…"
docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < scripts/migrations/125-trading-books-cutover.sql

note "linking the legacy live book to its discovered account…"
$PSQL "UPDATE oshal_trading_books b
          SET account_id = a.account_id, broker = 'schwab', connection_key = a.connection_key
         FROM oshal_trading_accounts a
        WHERE b.ref = 'live' AND b.account_id IS NULL
          AND a.user_sub = b.user_sub AND a.broker = 'schwab' AND $LINK_WHERE"

note "flipping TRADING_MULTI_ACCOUNT=true in .env…"
if grep -qE '^TRADING_MULTI_ACCOUNT=' .env; then
  sed -i 's/^TRADING_MULTI_ACCOUNT=.*/TRADING_MULTI_ACCOUNT=true/' .env
else
  printf '\nTRADING_MULTI_ACCOUNT=true\n' >> .env
fi

note "recreating the api so the container sees the flag (env changes need a recreate)…"
docker compose -f docker-compose.oshal-local.yml up -d --no-deps api >/dev/null 2>&1 \
  || docker compose -f docker-compose.oshal-local.yml up -d --no-deps oshal-api >/dev/null 2>&1 \
  || fail "api recreate failed — check the compose service name; flag is set in .env but NOT live"

sleep 20
health=$(docker inspect --format '{{.State.Health.Status}}' "$API_CONTAINER" 2>/dev/null || echo unknown)
[ "$health" = "healthy" ] || fail "api is '$health' after recreate — investigate before trading resumes"
flag=$(docker exec "$API_CONTAINER" sh -c 'printf %s "$TRADING_MULTI_ACCOUNT"')
[ "$flag" = "true" ] || fail "container does not see TRADING_MULTI_ACCOUNT=true (compose passthrough missing?)"

note "CUTOVER COMPLETE — multi-account dispatch is ARMED."
note "Next: enable books + assign strategies in the trading surface (Accounts & books tab)."
note "Rollback doctrine from here: TRADING_MULTI_ACCOUNT=false + roll FORWARD only — never a pre-PR1 image (its ON CONFLICT targets are gone once book PKs rule)."
