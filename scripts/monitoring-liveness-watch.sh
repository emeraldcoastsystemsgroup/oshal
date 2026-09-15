#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - BUG-21 tail: monitoring-liveness-check.sh --strict is already the assertion that the observers are observing, but nothing ran it unless a human ran oshal-up.sh. Twice on the night of 2026-09-14 the overlay stayed down after the engine came back and docker ps looked correct throughout. This is the unattended runner: it OBSERVES ONLY (it never starts the engine or a container - operator decision 2026-08-07), confirms a failure across consecutive runs before it speaks, and routes the failure to the existing alert rail (oshal-send-alert.js: Telegram then Gmail) with a re-alert window so a standing outage does not mail an identical line every five minutes.
set -uo pipefail

# -----------------------------------------------------------------------------
# Does anything notice when the observers are gone?
#
#   bash scripts/monitoring-liveness-watch.sh
#
# Registered as a Windows scheduled task through the windowless sibling launcher:
#   powershell -File scripts/register-monitoring-liveness-task.ps1
#
# What it will NOT do, deliberately:
#   - start the Docker engine, or start/recreate any container. Docker must not
#     start by itself on this box (operator decision 2026-08-07, the same decision
#     that paused scripts/oshal-stack-watchdog.ps1). With the engine down there is
#     also no alert rail, because delivery runs inside the api container.
#   - run scripts/oshal-up.sh. Recovery is an operator action; this reports.
#
# Exit code is the strict check's own, so Task Scheduler's Last Result is the real
# answer rather than the launcher's.
#
# Environment (all optional, defaults in brackets):
#   MONITORING_LIVENESS_CHECK        path to the assertion  [scripts/monitoring-liveness-check.sh]
#   MONITORING_WATCH_STATE_DIR       log + streak state dir [%LOCALAPPDATA%/oshal]
#   MONITORING_WATCH_CONFIRM_RUNS    consecutive failures before alerting     [3]
#   MONITORING_WATCH_REALERT_MINUTES quiet window between repeat alerts      [60]
#   MONITORING_WATCH_ENGINE_TIMEOUT  seconds for a bounded docker probe      [20]
#   MONITORING_WATCH_CHECK_TIMEOUT   seconds for the strict check            [60]
#   MONITORING_WATCH_ALERT_TIMEOUT   seconds for alert delivery             [120]
#   OSHAL_API_CONTAINER              container that owns the alert rail  [oshal-local-api]
#   OSHAL_ALERT_SCRIPT               alert entrypoint inside it  [/app/scripts/oshal-send-alert.js]
# -----------------------------------------------------------------------------

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="${MONITORING_LIVENESS_CHECK:-$REPO_DIR/scripts/monitoring-liveness-check.sh}"
CONFIRM_RUNS="${MONITORING_WATCH_CONFIRM_RUNS:-3}"
REALERT_MINUTES="${MONITORING_WATCH_REALERT_MINUTES:-60}"
ENGINE_TIMEOUT="${MONITORING_WATCH_ENGINE_TIMEOUT:-20}"
CHECK_TIMEOUT="${MONITORING_WATCH_CHECK_TIMEOUT:-60}"
ALERT_TIMEOUT="${MONITORING_WATCH_ALERT_TIMEOUT:-120}"
API_CONTAINER="${OSHAL_API_CONTAINER:-oshal-local-api}"
ALERT_SCRIPT="${OSHAL_ALERT_SCRIPT:-/app/scripts/oshal-send-alert.js}"
HOST_LABEL="${COMPUTERNAME:-$(hostname 2>/dev/null || echo this-machine)}"

# Git Bash rewrites a leading-slash argument into a Windows path, which turns the
# in-container alert path into a C:\Program Files\... path that does not exist there
# and black-holes the mail. ci-local.sh learned this the same way.
export MSYS_NO_PATHCONV=1

# %LOCALAPPDATA%\oshal is where every other unattended oshal task keeps its log and
# state (ci-local.sh, both watchdogs), so an operator looks in one place.
resolve_state_dir() {
  local base="${LOCALAPPDATA:-}"
  if [ -n "$base" ] && command -v cygpath >/dev/null 2>&1; then base="$(cygpath -u "$base")"; fi
  [ -n "$base" ] || base="$HOME/AppData/Local"
  printf '%s/oshal' "$base"
}
STATE_DIR="${MONITORING_WATCH_STATE_DIR:-$(resolve_state_dir)}"
LOG_FILE="$STATE_DIR/monitoring-liveness-watch.log"
STATE_FILE="$STATE_DIR/monitoring-liveness-watch.state"
mkdir -p "$STATE_DIR" 2>/dev/null || true

log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
}

state_get() {
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | tail -n 1
}

state_write() {
  printf 'consecutive=%s\nalerted=%s\nlast_alert_epoch=%s\n' "$1" "$2" "$3" >"$STATE_FILE" 2>/dev/null \
    || log "state: could not write $STATE_FILE - the streak restarts next run"
}

# `timeout` keeps a wedged engine from pinning the scheduled task until the next run
# overlaps it; without coreutils the call still runs, just unbounded.
run_bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# Observation only. A failure here means "the engine is not answering", which is a
# different fault with a different owner - it is not evidence about the overlay.
engine_is_up() {
  run_bounded "$ENGINE_TIMEOUT" docker ps --format '{{.Names}}' >/dev/null 2>&1
}

# The one alert rail this repo already has: Telegram first, then Gmail, both inside
# the api container. Returns non-zero when nothing was delivered.
deliver_alert() {
  local subject="$1" body="$2"
  if ! run_bounded "$ENGINE_TIMEOUT" docker exec "$API_CONTAINER" true >/dev/null 2>&1; then
    log "alert: $API_CONTAINER is not answering - failure recorded in $LOG_FILE only"
    return 1
  fi
  if run_bounded "$ALERT_TIMEOUT" docker exec "$API_CONTAINER" node "$ALERT_SCRIPT" "$subject" "$body" >>"$LOG_FILE" 2>&1; then
    log "alert: delivered - $subject"
    return 0
  fi
  log "alert: delivery FAILED - $subject"
  return 1
}

# The check names the fault on its own banner or on its targets line; fall back to the
# exit status rather than inventing a cause.
failure_headline() {
  local line
  line="$(printf '%s\n' "$CHECK_OUTPUT" | grep -m 1 -e 'MONITORING IS NOT WATCHING' -e '^Monitoring: ' 2>/dev/null)"
  [ -n "$line" ] || line="monitoring-liveness-check.sh --strict exited $CHECK_STATUS"
  printf '%s' "$line"
}

alert_body() {
  printf '%s\n\n%s\n\n%s\n\n%s\n' \
    "$1" \
    "Consecutive failing runs: $CONSECUTIVE on $HOST_LABEL. The swarm may be running perfectly; nothing would tell you if it were not." \
    "Reproduce: bash scripts/monitoring-liveness-check.sh --strict   Recover: bash scripts/oshal-up.sh" \
    "Full output of this run is in $LOG_FILE."
}

handle_pass() {
  log "monitoring liveness OK - $(printf '%s\n' "$CHECK_OUTPUT" | tail -n 1)"
  if [ "$ALERTED" = "1" ]; then
    deliver_alert "oshal monitoring is watching again on $HOST_LABEL" \
      "$(printf '%s\n\n%s\n' "The overlay answers again and every discovered target is up." "Log: $LOG_FILE")" || true
  fi
  state_write 0 0 "$LAST_ALERT"
}

handle_fail() {
  CONSECUTIVE=$((CONSECUTIVE + 1))
  local headline now
  headline="$(failure_headline)"
  log "monitoring liveness FAILED (exit $CHECK_STATUS, consecutive $CONSECUTIVE/$CONFIRM_RUNS): $headline"
  if [ "$CONSECUTIVE" -lt "$CONFIRM_RUNS" ]; then
    log "not alerting yet - one miss during a deploy or a container recreate is not evidence the observers are gone"
    state_write "$CONSECUTIVE" "$ALERTED" "$LAST_ALERT"
    return
  fi
  now="$(date -u +%s)"
  if [ "$ALERTED" = "1" ] && [ "$((now - LAST_ALERT))" -lt "$((REALERT_MINUTES * 60))" ]; then
    log "alert suppressed - already alerted $(((now - LAST_ALERT) / 60))m ago, re-alert window is ${REALERT_MINUTES}m (BUG-22: an identical mail every run is wallpaper)"
    state_write "$CONSECUTIVE" "$ALERTED" "$LAST_ALERT"
    return
  fi
  if deliver_alert "oshal monitoring is NOT watching on $HOST_LABEL" "$(alert_body "$headline")"; then
    state_write "$CONSECUTIVE" 1 "$now"
  else
    state_write "$CONSECUTIVE" "$ALERTED" "$LAST_ALERT"
  fi
}

if ! engine_is_up; then
  log "docker engine is not answering - observing only, it is not this task's job to start it; no alert rail without $API_CONTAINER"
  exit 0
fi

CHECK_OUTPUT="$(run_bounded "$CHECK_TIMEOUT" bash "$CHECK_SCRIPT" --strict 2>&1)"
CHECK_STATUS=$?
CONSECUTIVE="$(state_get consecutive)"; CONSECUTIVE="${CONSECUTIVE:-0}"
ALERTED="$(state_get alerted)"; ALERTED="${ALERTED:-0}"
LAST_ALERT="$(state_get last_alert_epoch)"; LAST_ALERT="${LAST_ALERT:-0}"

if [ "$CHECK_STATUS" -eq 0 ]; then
  handle_pass
  exit 0
fi
handle_fail
exit "$CHECK_STATUS"
