#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Bring-up for the ADR-119 monitoring overlay. Three things went wrong by hand on the 2026-08-01 drill and are now mechanical: (1) the Alertmanager bearer token had to be pasted into a TRACKED config file — it is now written from .env into the gitignored .env.alertmanager-token and mounted, so the secret never approaches git; (2) Prometheus defaulted to 9090, which oshal-headscale already holds on this box, so the stack came up half-bound; (3) the receiver is fail-closed, so a missing ALERT_WEBHOOK_TOKEN made the whole ladder silently unreachable — this script refuses to start rather than bring up a monitoring stack that cannot deliver.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | SIGHUP prometheus + alertmanager after `compose up -d`. Editing a bind-mounted prometheus.yml / alert-rules.yml / alertmanager.yml does not change the SERVICE DEFINITION, so compose recreates nothing and the running process keeps the config it parsed at startup — the container then holds the new file and the old config at once. That silently wasted the first run of the 2026-08-01 drill (rules debugged that were never loaded). SIGHUP is the documented reload for both and preserves Prometheus's TSDB.
set -euo pipefail

# -----------------------------------------------------------------------------
# Brings up the Prometheus + Alertmanager + cAdvisor overlay that feeds the
# ADR-119 alert-triage ladder, with the webhook secret handled correctly.
#
#   bash scripts/monitoring-up.sh              # up -d
#   bash scripts/monitoring-up.sh down         # tear the overlay down
#
# Requires the main stack to be up first (the overlay joins its network):
#   bash scripts/oshal-up.sh
# -----------------------------------------------------------------------------

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

COMPOSE_FILE=docker-compose.monitoring.yml
TOKEN_FILE=.env.alertmanager-token

# 9090 is taken by oshal-headscale on the reference dev box. Overridable, but the
# default must not collide or Prometheus silently fails to publish its port.
export PROMETHEUS_PORT="${PROMETHEUS_PORT:-9091}"
export ALERTMANAGER_PORT="${ALERTMANAGER_PORT:-9093}"
export CADVISOR_PORT="${CADVISOR_PORT:-8080}"

if [ "${1:-up}" = "down" ]; then
  docker compose -f "$COMPOSE_FILE" down
  exit 0
fi

# Read ALERT_WEBHOOK_TOKEN from the environment, else from .env. Deliberately does
# NOT source .env (it carries live credentials and shell-hostile values); just the
# one key, last assignment wins, surrounding quotes stripped.
TOKEN="${ALERT_WEBHOOK_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .env ]; then
  TOKEN="$(grep -E '^[[:space:]]*ALERT_WEBHOOK_TOKEN[[:space:]]*=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/')"
fi

if [ -z "$TOKEN" ]; then
  echo "ERROR: ALERT_WEBHOOK_TOKEN is not set (env or .env)." >&2
  echo "       The /api/alerts receiver is FAIL-CLOSED: without it every alert POST is" >&2
  echo "       rejected 401 and the whole triage ladder is silently unreachable." >&2
  echo "       Generate one:  openssl rand -hex 24" >&2
  echo "       Then set it in .env AND make sure oshal-api has it (it is forwarded by" >&2
  echo "       docker-compose.oshal-local.yml; restart the api after adding it)." >&2
  exit 1
fi

# The mounted credentials_file. printf (not echo) so no trailing newline surprises,
# and 0600 so the token is not world-readable in the working tree.
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE" 2>/dev/null || true

# Fail loudly if it ever became tracked — this file is a secret and the publish gate
# is the only thing standing between the working tree and a public repo.
if git ls-files --error-unmatch "$TOKEN_FILE" >/dev/null 2>&1; then
  echo "ERROR: $TOKEN_FILE is TRACKED by git. Remove it from the index before continuing:" >&2
  echo "       git rm --cached $TOKEN_FILE" >&2
  exit 1
fi

echo "monitoring: prometheus :$PROMETHEUS_PORT  alertmanager :$ALERTMANAGER_PORT  cadvisor :$CADVISOR_PORT"
docker compose -f "$COMPOSE_FILE" up -d

# Reload the two config-driven services. `compose up -d` recreates only when the SERVICE
# DEFINITION changes — editing a bind-mounted prometheus.yml / alert-rules.yml / alertmanager.yml
# changes the file inside the container but NOT the config the process already parsed, so
# `up -d` is a silent no-op and you debug rules that were never loaded. (Cost me the first run of
# the 2026-08-01 drill: the container held the new file and the old config simultaneously.)
# SIGHUP is the documented reload for both and keeps Prometheus's TSDB, unlike a restart.
for svc in oshal-local-prometheus oshal-local-alertmanager; do
  if docker ps --format '{{.Names}}' | grep -qx "$svc"; then
    docker kill -s HUP "$svc" >/dev/null 2>&1 && echo "  reloaded $svc (SIGHUP)"
  fi
done

echo
echo "Prometheus   http://127.0.0.1:${PROMETHEUS_PORT}/targets"
echo "Alertmanager http://127.0.0.1:${ALERTMANAGER_PORT}"
echo "Intake stats curl -H \"Authorization: Bearer \$ALERT_WEBHOOK_TOKEN\" http://127.0.0.1:35457/api/alerts/intake-stats"
