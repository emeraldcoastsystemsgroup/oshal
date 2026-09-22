#!/usr/bin/env bash
# =============================================================================
# LEGACY — DO NOT DEPLOY
# Part of the quarantined pre-chart Kubernetes generation. It wraps
# scripts/setup-oshal-k8s.sh, which renders ops/deployment/kubernetes/oshal-stack.yaml
# (image oshal-api-server:latest, built by nothing in this repo). The current
# Kubernetes path is the Helm chart at deploy/helm/oshal: read docs/k8/README.md and
# docs/adr/129-codeless-k8s-install-path.md. The script refuses to run unless
# OSHAL_ALLOW_LEGACY_K8S=1 is set, so nothing is lost while delete-vs-quarantine is
# still open (docs/k8/remote-cluster-work-package.md, item 9).
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Quarantined as legacy (remote-cluster work package item 9): a LEGACY banner, and a refusal of its own that runs before the exec into setup-oshal-k8s.sh unless OSHAL_ALLOW_LEGACY_K8S=1. It refuses in its own name rather than relying on the script it wraps, so the guard can tell the two gates apart. Guard: tests/unit/k8s-legacy-quarantine.spec.ts.

set -euo pipefail

# Quarantine gate. It runs first, so nothing is rendered, built or applied before it.
if [ "${OSHAL_ALLOW_LEGACY_K8S:-}" != "1" ]; then
  printf '%s\n' \
    "REFUSED: scripts/install-k8s.sh is part of the quarantined legacy Kubernetes generation." \
    "It wraps scripts/setup-oshal-k8s.sh, which renders the oshal-api-server:latest stack (an image nothing in this repo builds)." \
    "" \
    "The current Kubernetes path is the Helm chart at deploy/helm/oshal:" \
    "  bash scripts/oshal-install.sh --mode 4 --admin-email you@example.com" \
    "Read docs/k8/README.md and docs/adr/129-codeless-k8s-install-path.md." \
    "" \
    "To run this legacy script anyway, set OSHAL_ALLOW_LEGACY_K8S=1." >&2
  exit 2
fi

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
