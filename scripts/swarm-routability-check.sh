#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — LOUD routing-liveness guard. The recurring "Jarvis can't answer / trading tickets don't reach the concierge" is a LIVENESS failure (a wedged Docker engine / dead bot), not a routing-logic bug: the ADR-083 call-out only routes to bots with a live Redis heartbeat, and when one is dead the ticket silently falls to general-bot. Unit tests mock the online set so they never see it, and the old verify-bot-health.sh checks stale swarm-* names on dead HTTP ports. This probes the EXACT signal routing uses (oshal:runtime-agent:{id}, status=online) for the routing-critical bots and fails loud, naming what breaks for the user.
#
# Verifies the routing-critical bots (scripts/routability-critical-bots.txt) each have a
# live runtime heartbeat in Redis — the same signal agent-runtime-registry-service.ts uses
# to build the call-out's online set. Exit 0 = all routable; exit 1 = a critical bot is
# down (routing to it is silently degrading right now).
#
# Usage:
#   bash scripts/swarm-routability-check.sh            # one-shot
#   bash scripts/swarm-routability-check.sh --wait 60  # poll up to 60s (fresh bring-up)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="${ROUTABILITY_LIST:-$HERE/routability-critical-bots.txt}"
REDIS_CONTAINER="${REDIS_CONTAINER:-oshal-local-redis}"
API_HEALTH="${API_URL:-http://localhost:35457/api/health}"
KEY_PREFIX="oshal:runtime-agent"
WAIT_SECS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT_SECS="${2:-0}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -f "$LIST" ] || { echo "routability list not found: $LIST" >&2; exit 2; }

# Is one bot online RIGHT NOW? Faithful to listOnlineAgentIds: the runtime key must exist
# (a TTL-expired heartbeat is already gone) AND its payload status must be "online".
is_online() {
  local id="$1" payload
  payload="$(docker exec "$REDIS_CONTAINER" redis-cli GET "$KEY_PREFIX:$id" 2>/dev/null)"
  [ -n "$payload" ] && printf '%s' "$payload" | grep -q '"status":"online"'
}

# Read the list into parallel arrays (skip comments/blanks). Fields: id|name|reach|breaks.
IDS=(); NAMES=(); BREAKS=()
while IFS='|' read -r id name reach breaks; do
  id="$(printf '%s' "$id" | tr -d '[:space:]')"
  [ -z "$id" ] && continue
  case "$id" in \#*) continue ;; esac
  IDS+=("$id")
  NAMES+=("$(printf '%s' "$name" | sed 's/^ *//; s/ *$//')")
  BREAKS+=("$(printf '%s' "$breaks" | sed 's/^ *//; s/ *$//')")
done < "$LIST"

[ "${#IDS[@]}" -gt 0 ] || { echo "no critical bots parsed from $LIST" >&2; exit 2; }

# Engine + API are the structural preconditions — if these are down, EVERY bot is unroutable
# and it's the wedge, not one bot. Report them first (fast, non-fatal to the per-bot loop).
engine_ok=1; api_ok=1
docker version >/dev/null 2>&1 || engine_ok=0
curl -sf -m 4 "$API_HEALTH" >/dev/null 2>&1 || api_ok=0

# Poll until all critical bots are online or the wait budget is spent (fresh bring-up grace).
deadline=$(( SECONDS + WAIT_SECS ))
while :; do
  down=0
  for i in "${!IDS[@]}"; do is_online "${IDS[$i]}" || down=$((down + 1)); done
  { [ "$down" -eq 0 ] && [ "$engine_ok" -eq 1 ] && [ "$api_ok" -eq 1 ]; } && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 3
  docker version >/dev/null 2>&1 && engine_ok=1 || engine_ok=0
  curl -sf -m 4 "$API_HEALTH" >/dev/null 2>&1 && api_ok=1 || api_ok=0
done

echo "=== OSHAL routing-liveness guard ==="
[ "$engine_ok" -eq 1 ] && echo "  [ok]   docker engine reachable" || echo "  [DOWN] docker engine NOT reachable — the whole stack is wedged"
[ "$api_ok" -eq 1 ] && echo "  [ok]   api answering ($API_HEALTH)" || echo "  [DOWN] api NOT answering ($API_HEALTH)"
echo

down=0
for i in "${!IDS[@]}"; do
  if is_online "${IDS[$i]}"; then
    printf "  [ok]   %-20s heartbeat live\n" "${NAMES[$i]}"
  else
    down=$((down + 1))
    printf "  [DOWN] %-20s (%s)\n         -> %s\n" "${NAMES[$i]}" "${IDS[$i]}" "${BREAKS[$i]}"
  fi
done

echo
if [ "$down" -eq 0 ] && [ "$engine_ok" -eq 1 ] && [ "$api_ok" -eq 1 ]; then
  echo "RESULT: PASS — all ${#IDS[@]} routing-critical bots are live; the swarm can route."
  exit 0
fi
echo "RESULT: FAIL — $down/${#IDS[@]} routing-critical bot(s) down. Routing to them is degrading NOW."
echo "Recover: bash scripts/oshal-up.sh   (if the engine is wedged, the stack watchdog auto-recovers, or run it by hand: powershell scripts/oshal-stack-watchdog.ps1 -Force)"
exit 1
