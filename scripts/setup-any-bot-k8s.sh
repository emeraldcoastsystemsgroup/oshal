#!/bin/bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added any-bot Kubernetes setup helper for rendering secrets, building the API image, and optionally applying manifests
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched secret rendering to kubectl-generated YAML and improved bundle assembly for npm CLI usage
# 3 | maintainer@emeraldcoastsystemsgroup.com   | Repointed the setup flow to the converted OSHAL root runtime image build and secret schema
# 4 | maintainer@emeraldcoastsystemsgroup.com   | Added Google Search MCP URL and optional image override support for the any-bot k8s setup flow
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE=""
OUTPUT_DIR="${REPO_ROOT}/output/k8/any-bot"
IMAGE_TAG="${IMAGE_TAG:-oshal-api-server:latest}"
APPLY_MANIFESTS="${APPLY_MANIFESTS:-false}"
SKIP_BUILD="${SKIP_IMAGE_BUILD:-false}"

usage() {
  cat <<EOF_USAGE
Usage: bash scripts/setup-any-bot-k8s.sh [options]

Options:
  --env-file <path>     Load required values from an env file
  --output-dir <path>   Directory for rendered setup artifacts
  --image-tag <tag>     Image tag to build/render (default: oshal-api-server:latest)
  --apply               Apply the generated manifests to the current kubectl context
  --skip-build          Do not build the converted OSHAL API image
  --help                Show this help message

Required environment values:
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  REDIS_URL
  TS_AUTHKEY
  HEADSCALE_LOGIN_SERVER

Optional environment values:
  ANTHROPIC_API_KEY
  PRESENTRON_API_KEY
  KEYCLOAK_CLIENT_SECRET
  APP_URL (default: http://localhost:3456)
  MOCK_OIDC (default: true)
  GOOGLE_SEARCH_MCP_URL (default: http://google-search-mcp:8080/mcp)
  GOOGLE_SEARCH_MCP_IMAGE (default: supercorp/supergateway:latest)

Example:
  bash scripts/setup-any-bot-k8s.sh --env-file ops/any-bot-k8s/setup.env --skip-build
EOF_USAGE
}

load_env_file() {
  if [ -z "${ENV_FILE}" ]; then
    return
  fi

  if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: Env file not found: ${ENV_FILE}" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Required command not found: $1" >&2
    exit 1
  fi
}

require_value() {
  local name="$1"
  local value="${!name:-}"

  if [ -z "${value}" ]; then
    echo "ERROR: Required value is missing: ${name}" >&2
    exit 1
  fi
}

render_stack() {
  local rendered_file="${OUTPUT_DIR}/rendered-stack.yaml"

  kubectl kustomize "${REPO_ROOT}/ops/any-bot-k8s" > "${rendered_file}"

  python3 - "${rendered_file}" "${HEADSCALE_LOGIN_SERVER}" "${IMAGE_TAG}" "${APP_URL}" "${MOCK_OIDC}" "${GOOGLE_SEARCH_MCP_URL}" "${GOOGLE_SEARCH_MCP_IMAGE}" <<'PY'
from pathlib import Path
import sys

rendered_path = Path(sys.argv[1])
headscale_login_server = sys.argv[2]
image_tag = sys.argv[3]
app_url = sys.argv[4]
mock_oidc = sys.argv[5].strip().lower()
google_search_mcp_url = sys.argv[6]
google_search_mcp_image = sys.argv[7]

content = rendered_path.read_text()
content = content.replace('https://headscale.example.com', headscale_login_server)
content = content.replace('oshal-api-server:latest', image_tag)
content = content.replace('APP_URL: "http://localhost:3456"', f'APP_URL: "{app_url}"')
content = content.replace('MOCK_OIDC: "true"', f'MOCK_OIDC: "{mock_oidc}"')
content = content.replace('GOOGLE_SEARCH_MCP_URL: "http://google-search-mcp:8080/mcp"', f'GOOGLE_SEARCH_MCP_URL: "{google_search_mcp_url}"')
content = content.replace('supercorp/supergateway:latest', google_search_mcp_image)
rendered_path.write_text(content)
PY
}

generate_secrets() {
  local secret_file="${OUTPUT_DIR}/generated-secrets.yaml"

  kubectl create secret generic any-bot-secrets \
    --namespace any-bot \
    --from-literal=POSTGRES_DB="${POSTGRES_DB}" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    --from-literal=REDIS_URL="${REDIS_URL}" \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    --from-literal=PRESENTRON_API_KEY="${PRESENTRON_API_KEY:-}" \
    --from-literal=KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-}" \
    --dry-run=client \
    -o yaml > "${secret_file}"

  printf '\n---\n' >> "${secret_file}"

  kubectl create secret generic headscale-gateway-secrets \
    --namespace any-bot \
    --from-literal=TS_AUTHKEY="${TS_AUTHKEY}" \
    --dry-run=client \
    -o yaml >> "${secret_file}"
}

write_bundle() {
  python3 - \
    "${REPO_ROOT}/ops/any-bot-k8s/namespace.yaml" \
    "${OUTPUT_DIR}/generated-secrets.yaml" \
    "${OUTPUT_DIR}/rendered-stack.yaml" \
    "${OUTPUT_DIR}/bundle.yaml" <<'PY'
from pathlib import Path
import sys

namespace_path = Path(sys.argv[1])
secrets_path = Path(sys.argv[2])
rendered_path = Path(sys.argv[3])
bundle_path = Path(sys.argv[4])

namespace_text = namespace_path.read_text().rstrip() + "\n"
secrets_text = secrets_path.read_text().strip() + "\n"
rendered_text = rendered_path.read_text()

parts = rendered_text.split("\n---\n", 1)
remaining_docs = parts[1] if len(parts) == 2 else rendered_text

bundle_path.write_text(
    namespace_text
    + "---\n"
    + secrets_text
    + "---\n"
    + remaining_docs.lstrip()
)
PY
}

cluster_available() {
  kubectl version --request-timeout='5s' >/dev/null 2>&1
}

apply_manifests() {
  kubectl apply -f "${REPO_ROOT}/ops/any-bot-k8s/namespace.yaml"
  kubectl apply -f "${OUTPUT_DIR}/generated-secrets.yaml"
  kubectl apply -f "${OUTPUT_DIR}/rendered-stack.yaml"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-file)
        ENV_FILE="$2"
        shift 2
        ;;
      --output-dir)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      --image-tag)
        IMAGE_TAG="$2"
        shift 2
        ;;
      --apply)
        APPLY_MANIFESTS="true"
        shift
        ;;
      --skip-build)
        SKIP_BUILD="true"
        shift
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

main() {
  parse_args "$@"
  require_command kubectl
  require_command python3
  load_env_file

  APP_URL="${APP_URL:-http://localhost:3456}"
  MOCK_OIDC="${MOCK_OIDC:-true}"
  GOOGLE_SEARCH_MCP_URL="${GOOGLE_SEARCH_MCP_URL:-http://google-search-mcp:8080/mcp}"
  GOOGLE_SEARCH_MCP_IMAGE="${GOOGLE_SEARCH_MCP_IMAGE:-supercorp/supergateway:latest}"

  require_value POSTGRES_DB
  require_value POSTGRES_USER
  require_value POSTGRES_PASSWORD
  require_value REDIS_URL
  require_value TS_AUTHKEY
  require_value HEADSCALE_LOGIN_SERVER

  mkdir -p "${OUTPUT_DIR}"

  if [ "${SKIP_BUILD}" != "true" ]; then
    require_command docker
    echo "[any-bot-k8s] Building converted OSHAL API image from the repository root: ${IMAGE_TAG}"
    docker build -t "${IMAGE_TAG}" -f "${REPO_ROOT}/Dockerfile" "${REPO_ROOT}"
  else
    echo "[any-bot-k8s] Skipping image build"
  fi

  echo "[any-bot-k8s] Rendering Kubernetes manifests into ${OUTPUT_DIR}"
  render_stack
  generate_secrets
  write_bundle

  echo "[any-bot-k8s] Generated files:"
  echo "  - ${OUTPUT_DIR}/generated-secrets.yaml"
  echo "  - ${OUTPUT_DIR}/rendered-stack.yaml"
  echo "  - ${OUTPUT_DIR}/bundle.yaml"

  if [ "${APPLY_MANIFESTS}" = "true" ]; then
    if ! cluster_available; then
      echo "ERROR: kubectl cannot reach a Kubernetes API server. Rendered files are available in ${OUTPUT_DIR}." >&2
      exit 1
    fi

    echo "[any-bot-k8s] Applying namespace, secrets, and rendered stack"
    apply_manifests
    echo "[any-bot-k8s] Apply complete"
  else
    echo "[any-bot-k8s] Dry-run mode complete. To apply later:"
    echo "  kubectl apply -f ${REPO_ROOT}/ops/any-bot-k8s/namespace.yaml"
    echo "  kubectl apply -f ${OUTPUT_DIR}/generated-secrets.yaml"
    echo "  kubectl apply -f ${OUTPUT_DIR}/rendered-stack.yaml"
  fi
}

main "$@"
