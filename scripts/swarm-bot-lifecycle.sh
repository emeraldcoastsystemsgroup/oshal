#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added governance header for the checked-in swarm bot lifecycle helper used by compatibility bot controls

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.swarm-local.yml"
BOT_IMAGE="${OSHAL_SWARM_BOT_IMAGE:-oshal-bot:latest}"
ROLLBACK_IMAGE="${OSHAL_SWARM_BOT_ROLLBACK_IMAGE:-oshal-bot:rollback-latest}"
WAIT_SECONDS="${OSHAL_SWARM_BOT_WAIT_SECONDS:-90}"

usage() {
  cat <<'EOF'
Usage: bash scripts/swarm-bot-lifecycle.sh <status|restart|rebuild|rollback> <bot-service-or-container>
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

normalize_service() {
  local raw="$1"
  local stripped="${raw#swarm-}"
  case "${stripped}" in
    project-manager|task-manager|code-developer|code-reviewer|documentation-writer|rca-specialist|presentation-bot|agent-factory|devops-bot|incident-response-bot|research-bot|security-auditor-bot|test-engineer|architect-bot|business-plan-bot|tester-bot)
      printf '%s\n' "${stripped}"
      ;;
    *)
      echo "ERROR: unsupported bot service '${raw}'" >&2
      exit 1
      ;;
  esac
}

resolve_container_name() {
  local service="$1"
  printf 'swarm-%s\n' "${service}"
}

wait_for_service_health() {
  local service="$1"
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  local container_id=""

  while [ "$(date +%s)" -le "${deadline}" ]; do
    container_id="$(compose ps -q "${service}" 2>/dev/null | head -n 1 || true)"
    if [ -z "${container_id}" ]; then
      sleep 2
      continue
    fi

    local state
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
    case "${state}" in
      healthy|running)
        return 0
        ;;
      unhealthy|exited|dead)
        return 1
        ;;
      *)
        sleep 2
        ;;
    esac
  done

  return 1
}

save_rollback_image() {
  if docker image inspect "${BOT_IMAGE}" >/dev/null 2>&1; then
    docker image tag "${BOT_IMAGE}" "${ROLLBACK_IMAGE}"
  fi
}

perform_restart() {
  local service="$1"
  compose restart "${service}" >/dev/null
  wait_for_service_health "${service}"
}

perform_rebuild() {
  local service="$1"
  save_rollback_image
  if ! compose up -d --build "${service}" >/dev/null; then
    perform_rollback "${service}"
    return 1
  fi

  if ! wait_for_service_health "${service}"; then
    perform_rollback "${service}"
    return 1
  fi
}

perform_rollback() {
  local service="$1"
  if ! docker image inspect "${ROLLBACK_IMAGE}" >/dev/null 2>&1; then
    echo "ERROR: rollback image '${ROLLBACK_IMAGE}' not found" >&2
    return 1
  fi

  docker image tag "${ROLLBACK_IMAGE}" "${BOT_IMAGE}"
  compose up -d --no-build "${service}" >/dev/null
  wait_for_service_health "${service}"
}

main() {
  require_command docker
  require_command bash
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: docker compose is required." >&2
    exit 1
  fi

  local action="${1:-}"
  local target="${2:-}"
  if [ -z "${action}" ] || [ -z "${target}" ]; then
    usage
    exit 1
  fi

  local service
  service="$(normalize_service "${target}")"

  case "${action}" in
    status)
      docker ps -a --filter "name=^/$(resolve_container_name "${service}")$" --format '{{.Names}} {{.Status}}'
      ;;
    restart)
      perform_restart "${service}"
      ;;
    rebuild)
      perform_rebuild "${service}"
      ;;
    rollback)
      perform_rollback "${service}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac

  printf '{"success":true,"action":"%s","service":"%s"}\n' "${action}" "${service}"
}

main "$@"
