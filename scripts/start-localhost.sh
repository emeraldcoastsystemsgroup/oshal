#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Restored localhost hybrid mode to the historical/default 3456 app port instead of the standalone convenience-stack port
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Prefer swarm-local Postgres/Redis/Chroma when present so localhost 3456 shares the active swarm data plane instead of drifting onto the core convenience stack
# 3 | maintainer@emeraldcoastsystemsgroup.com   | BF-031: Added NODE_OPTIONS --max-old-space-size=4096 to prevent silent OOM on ts-node control plane with 49 agents + Redis mesh + Postgres pools
# 4 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Set BOT_NAME=api-controller and SWARM_MODE=single so host API server has a proper identity instead of unknown-agent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

require_command node
require_command npm
require_command docker

container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -qx 'true'
}

if [ ! -f "${REPO_ROOT}/.env" ]; then
  cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
  echo "Created .env from .env.example"
fi

mkdir -p \
  "${REPO_ROOT}/output" \
  "${REPO_ROOT}/workspace" \
  "${REPO_ROOT}/workspace-shared"

USE_SWARM_LOCAL_DATA_PLANE=false
if container_running oshal-swarm-db && container_running oshal-swarm-redis && container_running oshal-swarm-chromadb; then
  USE_SWARM_LOCAL_DATA_PLANE=true
  DEFAULT_POSTGRES_PORT="${OSHAL_SWARM_POSTGRES_PORT:-5432}"
  DEFAULT_REDIS_PORT="${OSHAL_SWARM_REDIS_PORT:-6379}"
  DEFAULT_CHROMA_PORT="${OSHAL_SWARM_CHROMA_PORT:-8000}"
  echo "Detected swarm-local dependencies; localhost runtime will attach to ports ${DEFAULT_POSTGRES_PORT}/${DEFAULT_REDIS_PORT}/${DEFAULT_CHROMA_PORT}."
else
  docker compose -f "${REPO_ROOT}/docker-compose.core.yml" up -d oshal-db oshal-redis oshal-chromadb
  DEFAULT_POSTGRES_PORT="${OSHAL_POSTGRES_PORT:-55432}"
  DEFAULT_REDIS_PORT="${OSHAL_REDIS_PORT:-56379}"
  DEFAULT_CHROMA_PORT="${OSHAL_CHROMA_PORT:-58000}"
  echo "Using core convenience dependencies for localhost runtime on ports ${DEFAULT_POSTGRES_PORT}/${DEFAULT_REDIS_PORT}/${DEFAULT_CHROMA_PORT}."
fi

if [ ! -d "${REPO_ROOT}/node_modules" ]; then
  (cd "${REPO_ROOT}" && npm install --legacy-peer-deps)
fi

export PORT="${PORT:-3456}"
export APP_URL="${APP_URL:-http://localhost:${PORT}}"
export MOCK_OIDC="${MOCK_OIDC:-true}"
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-${DEFAULT_POSTGRES_PORT}}"
export POSTGRES_DB="${POSTGRES_DB:-oshal}"
export POSTGRES_USER="${POSTGRES_USER:-oshal}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-oshalpass}"
export DATABASE_URL="${DATABASE_URL:-postgresql://oshal:oshalpass@localhost:${POSTGRES_PORT}/oshal}"
export REDIS_URL="${REDIS_URL:-redis://localhost:${DEFAULT_REDIS_PORT}}"
export CHROMADB_URL="${CHROMADB_URL:-http://localhost:${DEFAULT_CHROMA_PORT}}"
export ENABLE_AGENT_SCHEDULER="${ENABLE_AGENT_SCHEDULER:-false}"
export BOT_NAME="${BOT_NAME:-api-controller}"
export SWARM_MODE="${SWARM_MODE:-single}"
export KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
export KEYCLOAK_EXTERNAL_URL="${KEYCLOAK_EXTERNAL_URL:-http://localhost:8080}"

cd "${REPO_ROOT}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
exec npx ts-node --project tsconfig.json -r tsconfig-paths/register src/app/server.ts
