#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — BUG-21 prevention: assert the observer is actually observing. A running Prometheus that scrapes nothing is indistinguishable from a healthy one in `docker ps`, and that is how the overlay sat Exited(255) for eleven days (2026-08-02 → 08-13) while every bring-up printed a healthy census. Checks reachability, that targets were DISCOVERED (they come from container labels now, not a list), and that every discovered target is actually up — then names the ones that are not.
set -uo pipefail

# -----------------------------------------------------------------------------
# Is monitoring actually monitoring?
#
#   bash scripts/monitoring-liveness-check.sh
#
# ADVISORY by default: prints loudly, exits 0, so it can sit in oshal-up.sh without
# turning a monitoring problem into a failed bring-up. Pass --strict to exit non-zero
# (for ci-local.sh / a scheduled check, where silence should cost something).
#
# Why this is a separate boundary from the config guard: the unit spec
# tests/unit/swarm-container-health-signal.spec.ts proves the scrape CONFIG is coherent —
# it cannot tell you the process reading that config has been dead for a week. Different
# boundary, different guard (CLAUDE.md integration-boundary corollary).
# -----------------------------------------------------------------------------

STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

PROM_PORT="${PROMETHEUS_PORT:-9091}"
PROM="http://127.0.0.1:${PROM_PORT}"

fail() {
  echo "############################################################################"
  echo "## MONITORING IS NOT WATCHING — $1"
  shift
  for line in "$@"; do echo "##   $line"; done
  echo "## The swarm may be running perfectly; nothing would tell you if it were not."
  echo "############################################################################"
  [ "$STRICT" -eq 1 ] && exit 1
  exit 0
}

# 1. Is Prometheus answering at all?
if ! curl -sf -m 5 "${PROM}/-/healthy" >/dev/null 2>&1; then
  fail "Prometheus is not answering on ${PROM}." \
       "Start it: bash scripts/monitoring-up.sh" \
       "If it is 'Up' in docker ps but not answering, check: docker logs oshal-local-prometheus"
fi

# 2. Did it DISCOVER the fleet? Targets come from container labels (oshal.tier) via the
#    docker-socket-proxy, so zero here means the label or the proxy broke — not a missing
#    list entry. Anything that silently empties discovery unmonitors the whole swarm at once,
#    which is a strictly worse failure than the single missing target this replaced.
TARGETS_JSON="$(curl -sf -m 10 "${PROM}/api/v1/targets?state=active" 2>/dev/null || true)"
if [ -z "$TARGETS_JSON" ]; then
  fail "Prometheus is up but its targets API did not answer." "Check: docker logs oshal-local-prometheus"
fi

read -r TOTAL UP DOWN DOWN_NAMES <<<"$(printf '%s' "$TARGETS_JSON" | python -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("0 0 0 -"); raise SystemExit
ts = [t for t in d.get("data", {}).get("activeTargets", [])
      if t.get("labels", {}).get("job") in ("oshal-core", "oshal-swarm-bots")]
up = [t for t in ts if t.get("health") == "up"]
down = [t for t in ts if t.get("health") == "down"]
names = ",".join(sorted(t["labels"].get("container", "?") for t in down)) or "-"
print(len(ts), len(up), len(down), names)
' 2>/dev/null || echo "0 0 0 -")"

if [ "${TOTAL:-0}" -eq 0 ]; then
  fail "Prometheus discovered ZERO oshal targets." \
       "Discovery is by container label. Check, in order:" \
       "  docker inspect oshal-local-api --format '{{index .Config.Labels \"oshal.tier\"}}'   (expect: core)" \
       "  docker logs oshal-local-docker-proxy --tail 20                                     (403 = a denied endpoint)" \
       "  docker logs oshal-local-prometheus | grep -i 'discovery manager'"
fi

if [ "${DOWN:-0}" -gt 0 ]; then
  echo "Monitoring: ${UP}/${TOTAL} oshal targets up — DOWN: ${DOWN_NAMES}"
  echo "  (a target discovered but not scrapeable is a real bot that cannot be seen)"
else
  echo "Monitoring: watching ${TOTAL} oshal targets, all up."
fi
exit 0
