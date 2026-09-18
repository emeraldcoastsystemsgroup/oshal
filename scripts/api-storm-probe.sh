#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Deploy — the api process exits during the bot-recreate storm": the probe that turns the entry's done-when into a gate. On the 2026-09-05 deploy the api died and came back inside the bot recreate, and the only record was the container's RestartCount - the deploy printed DEPLOYED. `begin` snapshots the api container's RestartCount and the clock before the recreate; `verify` reads them back after it and counts the api log's `idle-in-transaction` lines inside that window. Either changing is exit 1, so scripts/oshal-deploy.sh can refuse to print DEPLOYED over a mid-deploy api restart. Standalone use (any container, any window) is how the real-boundary audit's evidence is taken.
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
    LINES=$(docker logs --since "$SINCE" "$CONTAINER" 2>&1 | grep -c -i -- "$PATTERN")
    echo "api-storm-probe: $CONTAINER RestartCount $BEFORE -> $NOW; '$PATTERN' log lines since $SINCE: $LINES"
    if [ "$NOW" != "$BEFORE" ] || [ "$LINES" != "0" ]; then
      echo "api-storm-probe: FAIL - the process restarted and/or a transaction was terminated inside the window"
      exit 1
    fi
    echo "api-storm-probe: PASS - RestartCount unchanged and no '$PATTERN' line in the window"
    ;;
  *)
    usage >&2; exit 2
    ;;
esac
