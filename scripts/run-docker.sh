#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.core.yml"

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
  if [ ! -f "${REPO_ROOT}/.env" ]; then
    cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
    echo "Created .env from .env.example"
  fi

  mkdir -p \
    "${REPO_ROOT}/output" \
    "${REPO_ROOT}/workspace" \
    "${REPO_ROOT}/workspace-shared"
}

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

ACTION="${1:-up}"
if [ "$#" -gt 0 ]; then
  shift
fi

ensure_prereqs
ensure_env

case "${ACTION}" in
  up)
    compose up -d --build "$@"
    ;;
  down)
    compose down "$@"
    ;;
  logs)
    compose logs -f "$@"
    ;;
  ps)
    compose ps
    ;;
  restart)
    compose restart "$@"
    ;;
  reset)
    compose down -v --remove-orphans
    ;;
  shell)
    compose exec api-server sh
    ;;
  *)
    echo "Usage: bash scripts/run-docker.sh [up|down|logs|ps|restart|reset|shell]" >&2
    exit 1
    ;;
esac
