#!/usr/bin/env bash
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — operator helper to bounce oshal-api when Docker Desktop port-forward wedges
#
# When http://localhost:35457 stops responding but `docker ps` shows the
# api healthy, that's Docker Desktop's vpnkit port-forward wedging on
# Windows. The container is fine; bouncing it forces Docker to rebuild
# the host port-forward.
#
# Usage:
#   bash scripts/api-bounce.sh
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.oshal-local.yml}"
API_URL="${API_URL:-http://localhost:35457/api/health}"

echo "Bouncing oshal-api (stop + start — compose restart isn't enough for vpnkit wedges)..."
docker stop oshal-local-api >/dev/null
docker start oshal-local-api >/dev/null

echo -n "Waiting for host port-forward "
for _ in $(seq 1 40); do
  if curl -sf -m 2 "$API_URL" 2>/dev/null | grep -q '"ok"'; then
    echo " — live."
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo
echo "ERR: api still not reachable at $API_URL after 80s." >&2
exit 1
