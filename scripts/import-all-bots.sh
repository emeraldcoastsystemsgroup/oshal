#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required." >&2
  exit 1
fi

if [ ! -d "${REPO_ROOT}/node_modules" ]; then
  echo "ERROR: node_modules is missing. Run 'npm install' first." >&2
  exit 1
fi

# Resolve the running OSHAL Postgres as "<host-port> <user> <pass>" so a single
# invocation works against whichever stack is up (swarm / core / local-compose).
detect_db() {
  local names
  names="$(docker ps --format '{{.Names}}' 2>/dev/null || true)"

  if echo "$names" | grep -qx 'oshal-swarm-db'; then
    echo "5432 oshal oshalpass"; return
  fi

  if echo "$names" | grep -qx 'oshal-core-oshal-db-1'; then
    echo "55432 oshal oshalpass"; return
  fi

  if echo "$names" | grep -qx 'oshal-local-db'; then
    # docker-compose.oshal-local.yml: POSTGRES_USER/PASSWORD/DB = oshal, host port ${OSHAL_PG_PORT:-55433}
    echo "${OSHAL_PG_PORT:-55433} oshal oshal"; return
  fi

  echo "${OSHAL_POSTGRES_PORT:-5432} oshal oshalpass"
}

read -r PG_PORT PG_USER PG_PASS <<< "$(detect_db)"
export DATABASE_URL="${DATABASE_URL:-postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/oshal}"

cd "${REPO_ROOT}"
exec npm run import:legacy-bots -- --apply "$@"
