#!/bin/bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Docker image build/export helper for the any-bot Kubernetes installer so it can be distributed without a Docker registry
# =============================================================================

set -euo pipefail

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
    -v \"\$PWD/ops/any-bot-k8s/setup.env:/workspace/setup.env:ro\" \\
    -v \"\$PWD/output:/workspace/output\" \\
    -v \"\$HOME/.kube:/root/.kube:ro\" \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    ${IMAGE_TAG} --env-file /workspace/setup.env --output-dir /workspace/output/k8/any-bot"