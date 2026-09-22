#!/bin/bash
# =============================================================================
# LEGACY — DO NOT DEPLOY
# Part of the quarantined pre-chart Kubernetes generation. It builds a Docker image
# that runs the legacy any-bot installer (scripts/setup-any-bot-k8s-cli.js), which
# renders ops/any-bot-k8s with oshal-api-server:latest (an image nothing in this repo
# builds). The current Kubernetes path is the Helm chart at deploy/helm/oshal: read
# docs/k8/README.md and docs/adr/129-codeless-k8s-install-path.md. The script
# refuses to run unless OSHAL_ALLOW_LEGACY_K8S=1 is set, so nothing is lost while
# delete-vs-quarantine is still open (docs/k8/remote-cluster-work-package.md, item 9).
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Docker image build/export helper for the any-bot Kubernetes installer so it can be distributed without a Docker registry
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Quarantined as legacy (remote-cluster work package item 9): a LEGACY banner, and a refusal that runs before any node or docker call unless OSHAL_ALLOW_LEGACY_K8S=1. The printed docker run hint now passes the override, because the image's entrypoint is the installer CLI, which refuses without it. Guard: tests/unit/k8s-legacy-quarantine.spec.ts.
# =============================================================================

set -euo pipefail

# Quarantine gate. It runs first, so no node or docker call happens before it.
if [ "${OSHAL_ALLOW_LEGACY_K8S:-}" != "1" ]; then
  printf '%s\n' \
    "REFUSED: scripts/build-any-bot-k8s-installer-image.sh is part of the quarantined legacy Kubernetes generation." \
    "It builds an image that runs the legacy any-bot installer (ops/any-bot-k8s, image oshal-api-server:latest, which nothing in this repo builds)." \
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
OUTPUT_DIR="${REPO_ROOT}/output/docker"
PACKAGE_VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
IMAGE_NAME="${IMAGE_NAME:-oshal-any-bot-k8s-installer}"
IMAGE_TAG="${IMAGE_TAG:-${IMAGE_NAME}:${PACKAGE_VERSION}}"
SAVE_ARCHIVE="false"

usage() {
  cat <<EOF_USAGE
Usage: bash scripts/build-any-bot-k8s-installer-image.sh [options]

Options:
  --save                Also export the built image as a tar.gz archive
  --output-dir <path>   Directory for saved Docker archives (default: output/docker)
  --image-tag <tag>     Override the Docker image tag (default: ${IMAGE_TAG})
  --help                Show this help message

Examples:
  bash scripts/build-any-bot-k8s-installer-image.sh
  bash scripts/build-any-bot-k8s-installer-image.sh --save
EOF_USAGE
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --save)
        SAVE_ARCHIVE="true"
        shift
        ;;
      --output-dir)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --image-tag)
        IMAGE_TAG="$2"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "ERROR: Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done
}

parse_args "$@"

mkdir -p "${OUTPUT_DIR}"

echo "[any-bot-k8s] Building Docker installer image: ${IMAGE_TAG}"
docker build \
  -f "${REPO_ROOT}/scripts/any-bot-k8s-installer.Dockerfile" \
  -t "${IMAGE_TAG}" \
  "${REPO_ROOT}"

if [ "${SAVE_ARCHIVE}" = "true" ]; then
  ARCHIVE_PATH="${OUTPUT_DIR}/${IMAGE_NAME}-${PACKAGE_VERSION}.tar.gz"
  echo "[any-bot-k8s] Saving Docker installer image to ${ARCHIVE_PATH}"
  docker save "${IMAGE_TAG}" | gzip > "${ARCHIVE_PATH}"
  echo "[any-bot-k8s] Load on another computer with:"
  echo "  gunzip -c ${ARCHIVE_PATH} | docker load"
fi

echo "[any-bot-k8s] Run installer container with something like:"
echo "  docker run --rm -it \\
    -e OSHAL_ALLOW_LEGACY_K8S=1 \\
    -v \"\$PWD/ops/any-bot-k8s/setup.env:/workspace/setup.env:ro\" \\
    -v \"\$PWD/output:/workspace/output\" \\
    -v \"\$HOME/.kube:/root/.kube:ro\" \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    ${IMAGE_TAG} --env-file /workspace/setup.env --output-dir /workspace/output/k8/any-bot"