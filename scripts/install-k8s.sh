#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_ENV_FILE="${REPO_ROOT}/ops/deployment/oshal-k8s.env.example"

ARGS=("$@")
HAS_ENV_FILE="false"

for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = "--env-file" ]; then
    HAS_ENV_FILE="true"
    break
  fi
done

if [ "${HAS_ENV_FILE}" != "true" ]; then
  ARGS=(--env-file "${DEFAULT_ENV_FILE}" "${ARGS[@]}")
fi

echo "Rendering OSHAL Kubernetes bundle..."
exec bash "${REPO_ROOT}/scripts/setup-oshal-k8s.sh" "${ARGS[@]}"
