#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Deploy — the api process exits during the bot-recreate storm": the probe that turns the entry's done-when into a gate. On the 2026-09-05 deploy the api died and came back inside the bot recreate, and the only record was the container's RestartCount - the deploy printed DEPLOYED. `begin` snapshots the api container's RestartCount and the clock before the recreate; `verify` reads them back after it and counts the api log's `idle-in-transaction` lines inside that window. Either changing is exit 1, so scripts/oshal-deploy.sh can refuse to print DEPLOYED over a mid-deploy api restart. Standalone use (any container, any window) is how the real-boundary audit's evidence is taken.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | The log read is taken separately from the count, because `grep -c` exits 1 on zero matches and a piped read hid a FAILED read as "0 lines" - the deploy then reported that the api lived through a window nobody could read. A log driver that cannot be read is exit 2, the same fact as a container that cannot be inspected. The two failure shapes also now name themselves - FAIL(restarted) vs FAIL(terminated) - because a terminated transaction the process SURVIVED is not a restart.
#
# usage:
#   scripts/api-storm-probe.sh begin  [container]                      -> "restarts=<n> since=<rfc3339>"
#   scripts/api-storm-probe.sh verify <restarts> <since> [container]   -> exit 0 unchanged + 0 lines, 1 otherwise, 2 cannot inspect
#
# container defaults to oshal-local-api. `since` is the value `begin` printed (docker logs --since).

set -uo pipefail

DEFAULT_CONTAINER=oshal-local-api
PATTERN='idle-in-transaction'

usage() {
  sed -n '/^# usage:/,/^# container/p' "$0" | sed 's/^# \{0,1\}//'
}

restart_count() {
  docker inspect --format '{{.RestartCount}}' "$1" 2>/dev/null
}

MODE="${1:-}"
case "$MODE" in
  begin)
    CONTAINER="${2:-$DEFAULT_CONTAINER}"
    RESTARTS=$(restart_count "$CONTAINER") || { echo "api-storm-probe: cannot inspect container '$CONTAINER'" >&2; exit 2; }
    [ -n "$RESTARTS" ] || { echo "api-storm-probe: cannot inspect container '$CONTAINER'" >&2; exit 2; }
    echo "restarts=$RESTARTS since=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
  verify)
    BEFORE="${2:-}"; SINCE="${3:-}"; CONTAINER="${4:-$DEFAULT_CONTAINER}"
    if [ -z "$BEFORE" ] || [ -z "$SINCE" ]; then usage >&2; exit 2; fi
    NOW=$(restart_count "$CONTAINER") || { echo "api-storm-probe: cannot inspect container '$CONTAINER'" >&2; exit 2; }
    [ -n "$NOW" ] || { echo "api-storm-probe: cannot inspect container '$CONTAINER'" >&2; exit 2; }
    # Take the read and the count separately. `grep -c` exits 1 on zero matches, so piping the
    # read straight into it hides a failed read as "0 lines" - and the deploy then reports that
    # the api lived through the recreate on a window nobody could see. A log driver that cannot
    # be read is the same fact as a container that cannot be inspected: exit 2, not a PASS.
    LOG=$(docker logs --since "$SINCE" "$CONTAINER" 2>&1) || { echo "api-storm-probe: cannot read the logs of '$CONTAINER'" >&2; exit 2; }
    LINES=$(printf '%s\n' "$LOG" | grep -c -i -- "$PATTERN" || true)
    echo "api-storm-probe: $CONTAINER RestartCount $BEFORE -> $NOW; '$PATTERN' log lines since $SINCE: $LINES"
    if [ "$NOW" != "$BEFORE" ]; then
      echo "api-storm-probe: FAIL(restarted) - RestartCount moved $BEFORE -> $NOW inside the window"
      exit 1
    fi
    if [ "$LINES" != "0" ]; then
      # The process is still the one that started: a terminated transaction it SURVIVED. Saying
      # "it restarted" here would send the operator after a restart that never happened.
      echo "api-storm-probe: FAIL(terminated) - RestartCount unchanged, but $LINES '$PATTERN' line(s) inside the window"
      exit 1
    fi
    echo "api-storm-probe: PASS - RestartCount unchanged and no '$PATTERN' line in the window"
    ;;
  *)
    usage >&2; exit 2
    ;;
esac
