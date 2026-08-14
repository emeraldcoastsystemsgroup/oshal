#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ordered, verified OSHAL local bring-up: infra → API (fully up) → bots. Recovers the recurring Docker-Desktop-restart half-broken state (Postgres/Chroma exit 255, API "healthy" but DB-less).
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Run app-store-drift-check.sh after the parity check: warn when a deployed-apps package in the volume is stale vs the oshal-applications store checkout (little-monsters ran a pre-D10 v1.0.6 build for a week — every education asset 404'd from another app's package dir with nothing flagging it).
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Batch the bots step (5 at a time, 18s settle, OSHAL_UP_BATCH_SIZE/OSHAL_UP_BATCH_SETTLE knobs; 0 = old single-shot): the mass `up -d` cold-start spike OOM-crashed the 6 GB engine twice on 2026-07-23, and the Stack Watchdog re-running this script made it a crash loop.
#
# Why this exists: when the Docker engine restarts on this host, containers auto-start
# out of order — Postgres/Chroma sometimes crash (exit 255) and the API comes up
# DB-less but reporting "healthy" (its healthcheck is shallow HTTP liveness). Bots must
# not come up before the API is FULLY ready or the swarm thrashes. This script enforces:
#   1) infra (postgres, redis, chroma) healthy   2) API healthy AND swarm-app auto-load
#   complete   3) bots last.
#
# Usage:
#   bash scripts/oshal-up.sh
set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.oshal-local.yml}"
DC=(docker compose -f "$COMPOSE_FILE")
API_HEALTH="${API_URL:-http://localhost:35457/api/health}"

# Wait until a container reports healthy (or just running, if it has no healthcheck).
wait_ready() {
  local name="$1" max="${2:-60}" i s
  for ((i = 1; i <= max; i++)); do
    s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)
    case "$s" in
      healthy|running) echo "  $name: $s"; return 0 ;;
    esac
    sleep 3
  done
  echo "  $name: still '$s' after $((max * 3))s — check: docker logs $name" >&2
  return 1
}

docker version >/dev/null 2>&1 || { echo "Docker engine not reachable — start Docker Desktop first, then rerun." >&2; exit 1; }

echo "[1/3] Infra (postgres, redis, chroma)"
"${DC[@]}" up -d oshal-db oshal-redis oshal-chromadb >/dev/null
wait_ready oshal-local-db
wait_ready oshal-local-redis
wait_ready oshal-local-chromadb

# Recreate the API so it reconnects to the now-healthy DB (a DB-less API survives the
# host restart in a half-broken state). A fresh container also means its logs contain
# only this boot, so the auto-load grep below can't match a stale line.
echo "[2/3] API — must be FULLY up before bots"
"${DC[@]}" up -d --force-recreate --no-deps oshal-api >/dev/null
wait_ready oshal-local-api
echo -n "  waiting for swarm-app auto-load "
loaded=no
for _ in $(seq 1 50); do
  if docker logs oshal-local-api 2>&1 | grep -q "Swarm app auto-load complete"; then loaded=yes; echo "done."; break; fi
  echo -n "."; sleep 3
done
[ "$loaded" = yes ] || echo " (timed out — check: docker logs oshal-local-api)"

echo "[3/3] Bots + remaining services — batched"
# A bare `up -d` here cold-starts every remaining container at once. On a ~6 GB engine the
# simultaneous startup spike (each bot spawning its harness process) OOM-crashes the whole
# Docker engine — it happened twice on 2026-07-23, and the Stack Watchdog re-running this
# script turned it into a crash LOOP. Idle footprint fits; the concurrent cold-start peak
# does not. Start the remainder in small batches with a settle pause: peak memory stays
# bounded and the end state is identical. OSHAL_UP_BATCH_SIZE=0 restores the single-shot
# start for hosts with 10-12 GB+ engines where the spike fits.
BATCH_SIZE="${OSHAL_UP_BATCH_SIZE:-5}"
BATCH_SETTLE="${OSHAL_UP_BATCH_SETTLE:-18}"
if [ "$BATCH_SIZE" = "0" ]; then
  "${DC[@]}" up -d >/dev/null
else
  # Everything the compose file would start, minus what steps 1-2 already brought up.
  remaining=$("${DC[@]}" config --services 2>/dev/null | grep -vxE 'oshal-db|oshal-redis|oshal-chromadb|oshal-api')
  total=$(echo "$remaining" | grep -c .)
  started=0
  batch=()
  for svc in $remaining; do
    batch+=("$svc")
    if [ "${#batch[@]}" -ge "$BATCH_SIZE" ]; then
      "${DC[@]}" up -d --no-deps "${batch[@]}" >/dev/null
      started=$((started + ${#batch[@]}))
      echo "  started ${started}/${total}"
      batch=()
      [ "$started" -lt "$total" ] && sleep "$BATCH_SETTLE"
    fi
  done
  if [ "${#batch[@]}" -gt 0 ]; then
    "${DC[@]}" up -d --no-deps "${batch[@]}" >/dev/null
    started=$((started + ${#batch[@]}))
    echo "  started ${started}/${total}"
  fi
fi

echo
echo "=== status ==="
docker ps --format '{{.Names}}	{{.Status}}' | grep -i oshal | sort
echo

# Deploy parity: warn if the api and any bot-node ended up on different image builds (the
# split-image drift that ships two-half features broken). Advisory — never fails the bring-up.
if [ -f "$(dirname "$0")/deploy-parity-check.sh" ]; then
  bash "$(dirname "$0")/deploy-parity-check.sh" --quiet || true
fi

# App-store drift: warn if a deployed-apps package in the volume is a different version than
# the local oshal-applications store checkout (a stale volume copy runs OLD code/assets no
# matter what the store repo says). Advisory — never fails the bring-up.
if [ -f "$(dirname "$0")/app-store-drift-check.sh" ]; then
  bash "$(dirname "$0")/app-store-drift-check.sh" --quiet || true
fi

# Routing-liveness guard: the recurring "Jarvis can't answer / trading tickets don't reach the
# concierge" is a DEAD-BOT problem — the ADR-083 call-out only routes to bots with a live Redis
# heartbeat, and unit tests mock that set so they never catch it. The bots just came up (step 3);
# give them up to 60s to register, then verify the routing-critical set is live and fail LOUD if
# not (so a half-broken bring-up is visible here instead of surfacing as "routing broke" later).
if [ -f "$(dirname "$0")/swarm-routability-check.sh" ]; then
  echo
  if ! bash "$(dirname "$0")/swarm-routability-check.sh" --wait 60; then
    echo
    echo "############################################################################"
    echo "## ROUTING DEGRADED — a routing-critical bot is NOT heartbeating (see above)."
    echo "## Jarvis answers + trading/finance/email routing will strand or fall back."
    echo "## Re-run: bash scripts/oshal-up.sh   ·   inspect: docker logs <that bot>"
    echo "############################################################################"
  fi
fi

# App-bot integrity: after the apps auto-load, verify every ACTIVE app's primary bot is registered
# and active, and surface cross-wired bindings (the ADR-085 carve left agent_id collisions — e.g. a
# store package reusing a core bot id). Advisory: BROKEN bindings print loudly but never fail the
# bring-up (fixing them needs human intent on which app owns a shared id).
if [ -f "$(dirname "$0")/swarm-app-bot-integrity-check.sh" ]; then
  echo
  bash "$(dirname "$0")/swarm-app-bot-integrity-check.sh" || true
fi

# ── Monitoring overlay ───────────────────────────────────────────────────────────────────
# BUG-21: this script and oshal-deploy.sh referenced the monitoring compose file ZERO times,
# so the documented recovery path brought the swarm up monitored in name only. Prometheus sat
# Exited(255) from 2026-08-02 to 08-13 and nothing noticed, which made every alert rule and the
# whole ADR-119 self-healing ladder inert — while the bring-up cheerfully printed a healthy
# census. Docker healthchecks and the monitoring overlay are independent; one is not evidence
# of the other. The observer now comes up WITH the thing it observes.
#
# ADVISORY, never fatal: monitoring-up.sh is deliberately fail-closed on a missing
# ALERT_WEBHOOK_TOKEN (a receiver that cannot deliver is worse than none), but a swarm that is
# otherwise healthy must still finish coming up. A deployment that has not configured alerting
# gets a loud, specific line instead of a broken bring-up.
if [ -f "$(dirname "$0")/monitoring-up.sh" ]; then
  echo
  if bash "$(dirname "$0")/monitoring-up.sh" >/tmp/oshal-monitoring-up.log 2>&1; then
    echo "Monitoring: overlay up (Prometheus + Alertmanager + cAdvisor)."
  else
    echo "############################################################################"
    echo "## MONITORING DID NOT START — the swarm is running UNWATCHED."
    echo "## Every alert rule and the ADR-119 self-healing ladder are inert: nothing"
    echo "## will notice a container dying. The healthy census above says nothing"
    echo "## about this."
    echo "## Reason (tail of /tmp/oshal-monitoring-up.log):"
    tail -n 3 /tmp/oshal-monitoring-up.log 2>/dev/null | sed 's/^/##   /'
    echo "## Usually a missing ALERT_WEBHOOK_TOKEN in .env. Re-run: bash scripts/monitoring-up.sh"
    echo "############################################################################"
  fi
fi

# Is the observer actually observing? A running Prometheus that is scraping NOTHING looks
# identical to a healthy one from `docker ps` — and BUG-15 was exactly that shape for one bot.
# Targets are discovered by container label now, so "0 targets" means the label or the docker
# proxy broke, not that someone forgot a list entry.
if [ -f "$(dirname "$0")/monitoring-liveness-check.sh" ]; then
  bash "$(dirname "$0")/monitoring-liveness-check.sh" || true
fi

if curl -sf -m 3 "$API_HEALTH" >/dev/null 2>&1; then
  echo "Cockpit: http://localhost:35457/cockpit/  (live)"
else
  echo "API container up but not answering on the host port yet."
  echo "If docker shows it healthy, the Windows port-forward may be wedged — run: bash scripts/api-bounce.sh"
fi
