#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added root-level runtime helper for OSHAL status, refresh, and stack control
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Clarified helper messaging so 3456 remains the historical/default runtime and 35456 is treated as a standalone convenience stack
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Reclaimed the default callback port before swarm startup so project-manager can take ownership of auth redirect handling

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"
CORE_COMPOSE_FILE="${ROOT_DIR}/docker-compose.core.yml"
SWARM_COMPOSE_FILE="${ROOT_DIR}/docker-compose.swarm-local.yml"

usage() {
  cat <<'EOF'
OSHAL runtime helper

Usage:
  bash oshal.sh help
  bash oshal.sh status
  bash oshal.sh refresh-api
  bash oshal.sh refresh-core
  bash oshal.sh refresh-all
  bash oshal.sh main-logs [service]
  bash oshal.sh core-up
  bash oshal.sh core-down
  bash oshal.sh core-logs [service]
  bash oshal.sh swarm-up
  bash oshal.sh swarm-down
  bash oshal.sh swarm-logs [service]

Hot-swap summary:
  - docker-compose.yml api-server (:3456) is the historical/default runtime and is NOT hot-swapped.
  - docker-compose.core.yml api-server (:35456) is the standalone convenience stack and is NOT hot-swapped.
  - docker-compose.swarm-local.yml bot services (:3010-3025) ARE hot-swapped through source bind mounts.
EOF
}

ensure_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is required." >&2
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: docker compose is required." >&2
    exit 1
  fi
}

ensure_env() {
  if [ ! -f "${ROOT_DIR}/.env" ]; then
    cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
    echo "Created .env from .env.example"
  fi

  mkdir -p \
    "${ROOT_DIR}/output" \
    "${ROOT_DIR}/workspace" \
    "${ROOT_DIR}/workspace-shared"
}

compose_main() {
  docker compose -f "${MAIN_COMPOSE_FILE}" "$@"
}

compose_core() {
  docker compose -f "${CORE_COMPOSE_FILE}" "$@"
}

compose_swarm() {
  docker compose -f "${SWARM_COMPOSE_FILE}" "$@"
}

reclaim_port_if_needed() {
  local port="$1"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "WARN: lsof not available; skipping reclaim check for port ${port}." >&2
    return 0
  fi

  local pids
  pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "${pids}" ]; then
    return 0
  fi

  echo "Reclaiming callback port ${port} from existing listener(s): ${pids}"
  kill ${pids} 2>/dev/null || true
  sleep 1

  local remaining
  remaining="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${remaining}" ]; then
    echo "Force-killing remaining listener(s) on port ${port}: ${remaining}"
    kill -9 ${remaining} 2>/dev/null || true
  fi
}

ACTION="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi

if [ "${ACTION}" = "help" ] || [ "${ACTION}" = "--help" ] || [ "${ACTION}" = "-h" ]; then
  usage
  exit 0
fi

ensure_prereqs
ensure_env

case "${ACTION}" in
  status)
    echo '=== Main runtime (:3456, historical/default) ==='
    compose_main ps
    echo
    echo '=== Core runtime (:35456, standalone convenience stack) ==='
    compose_core ps
    echo
    echo '=== Swarm runtime (:3010-3025) ==='
    compose_swarm ps
    echo
    usage
    ;;
  refresh-api)
    compose_main up -d --build api-server
    ;;
  refresh-core)
    compose_core up -d --build api-server
    ;;
  refresh-all)
    compose_main up -d --build api-server
    compose_core up -d --build api-server
    ;;
  main-logs)
    compose_main logs -f "$@"
    ;;
  core-up)
    compose_core up -d --build "$@"
    ;;
  core-down)
    compose_core down "$@"
    ;;
  core-logs)
    compose_core logs -f "$@"
    ;;
  swarm-up)
    reclaim_port_if_needed "${OPENAI_CODEX_CALLBACK_PORT:-1455}"
    compose_swarm up -d --build "$@"
    ;;
  swarm-down)
    compose_swarm down "$@"
    ;;
  swarm-logs)
    if [ "$#" -eq 0 ]; then
      compose_swarm logs -f project-manager
    else
      compose_swarm logs -f "$@"
    fi
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac