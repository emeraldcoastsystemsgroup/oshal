#!/bin/bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added OSHAL Kubernetes setup helper for final deployment rendering, secret generation, and optional apply flow
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE=""
OUTPUT_DIR="${REPO_ROOT}/output/k8/oshal"
IMAGE_TAG="${IMAGE_TAG:-oshal-api-server:latest}"
APPLY_MANIFESTS="${APPLY_MANIFESTS:-false}"
SKIP_BUILD="${SKIP_IMAGE_BUILD:-false}"

usage() {
  cat <<'EOF_USAGE'
Usage: bash scripts/setup-oshal-k8s.sh [options]

Options:
  --env-file <path>     Load deployment values from an env file
  --output-dir <path>   Directory for rendered setup artifacts
  --image-tag <tag>     Image tag to build/render (default: oshal-api-server:latest)
  --apply               Apply the generated manifests to the current kubectl context
  --skip-build          Do not build the API image
  --help                Show this help message

Required environment values:
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  KEYCLOAK_ADMIN_USER
  KEYCLOAK_ADMIN_PASSWORD
  KEYCLOAK_CLIENT_SECRET
  APP_URL
  KEYCLOAK_EXTERNAL_URL

Optional environment values:
  ANTHROPIC_API_KEY
  PRESENTRON_API_KEY
  MOCK_OIDC (default: false)
  KEYCLOAK_REALM (default: oshal)
  KEYCLOAK_CLIENT_ID (default: oshal-swarm)
  LLM_MODEL (default: claude-sonnet-4-5-20250929)
  LOG_LEVEL (default: info)
  OPENAI_CODEX_CALLBACK_PORT (default: 1455)
  PRESENTRON_ENDPOINT (default: http://presentron:8080)
  RAG_INGESTION_ENDPOINT (default: empty)
  SWARM_MODE (default: single)
  IMAGE_PULL_POLICY (default: IfNotPresent)
  INCLUDE_BOOTSTRAP_DEV_USERS (default: false)

Example:
  bash scripts/setup-oshal-k8s.sh --env-file ops/deployment/oshal-k8s.env
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

  python3 - \
    "${REPO_ROOT}/ops/deployment/kubernetes/oshal-stack.yaml" \
    "${rendered_file}" \
    "${IMAGE_TAG}" \
    "${APP_URL}" \
    "${KEYCLOAK_EXTERNAL_URL}" \
    "${MOCK_OIDC}" \
    "${KEYCLOAK_REALM}" \
    "${KEYCLOAK_CLIENT_ID}" \
    "${KEYCLOAK_CLIENT_SECRET}" \
    "${LLM_MODEL}" \
    "${LOG_LEVEL}" \
    "${OPENAI_CODEX_CALLBACK_PORT}" \
    "${PRESENTRON_ENDPOINT}" \
    "${RAG_INGESTION_ENDPOINT}" \
    "${SWARM_MODE}" \
    "${IMAGE_PULL_POLICY}" \
    "${INCLUDE_BOOTSTRAP_DEV_USERS}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlparse

base_path = Path(sys.argv[1])
rendered_path = Path(sys.argv[2])
image_tag = sys.argv[3]
app_url = sys.argv[4]
keycloak_external_url = sys.argv[5]
mock_oidc = sys.argv[6].strip().lower()
keycloak_realm = sys.argv[7]
keycloak_client_id = sys.argv[8]
keycloak_client_secret = sys.argv[9]
llm_model = sys.argv[10]
log_level = sys.argv[11]
callback_port = sys.argv[12]
presentron_endpoint = sys.argv[13]
rag_ingestion_endpoint = sys.argv[14]
swarm_mode = sys.argv[15]
image_pull_policy = sys.argv[16]
include_bootstrap_dev_users = sys.argv[17].strip().lower() == "true"

content = base_path.read_text()

plain_replacements = {
    'KEYCLOAK_EXTERNAL_URL: "http://localhost:8080"': f'KEYCLOAK_EXTERNAL_URL: "{keycloak_external_url}"',
    'KEYCLOAK_REALM: "oshal"': f'KEYCLOAK_REALM: "{keycloak_realm}"',
    'KEYCLOAK_CLIENT_ID: "oshal-swarm"': f'KEYCLOAK_CLIENT_ID: "{keycloak_client_id}"',
    'APP_URL: "http://localhost:3456"': f'APP_URL: "{app_url}"',
    'MOCK_OIDC: "false"': f'MOCK_OIDC: "{mock_oidc}"',
    'LLM_MODEL: "claude-sonnet-4-5-20250929"': f'LLM_MODEL: "{llm_model}"',
    'LOG_LEVEL: "info"': f'LOG_LEVEL: "{log_level}"',
    'OPENAI_CODEX_CALLBACK_PORT: "1455"': f'OPENAI_CODEX_CALLBACK_PORT: "{callback_port}"',
    'PRESENTRON_ENDPOINT: "http://presentron:8080"': f'PRESENTRON_ENDPOINT: "{presentron_endpoint}"',
    'RAG_INGESTION_ENDPOINT: ""': f'RAG_INGESTION_ENDPOINT: "{rag_ingestion_endpoint}"',
    'SWARM_MODE: "single"': f'SWARM_MODE: "{swarm_mode}"',
    'image: oshal-api-server:latest': f'image: {image_tag}',
    'imagePullPolicy: IfNotPresent': f'imagePullPolicy: {image_pull_policy}',
}

for needle, replacement in plain_replacements.items():
    content = content.replace(needle, replacement)

keycloak_hostname = urlparse(keycloak_external_url).hostname
if not keycloak_hostname:
    raise SystemExit(f"Failed to derive hostname from KEYCLOAK_EXTERNAL_URL: {keycloak_external_url}")

content = content.replace('value: localhost', f'value: {keycloak_hostname}', 1)

realm_key = "  realm-export.json: |\n"
realm_start = content.find(realm_key)
if realm_start < 0:
    raise SystemExit("Failed to locate embedded Keycloak realm JSON in oshal-stack.yaml")

realm_json_start = realm_start + len(realm_key)
realm_doc_end = content.find("\n---\n", realm_json_start)
if realm_doc_end < 0:
    raise SystemExit("Failed to locate the end of the embedded Keycloak realm JSON block")

realm_block = content[realm_json_start:realm_doc_end]
realm_json = json.loads("\n".join(line[4:] for line in realm_block.splitlines()))
realm_json["realm"] = keycloak_realm

clients = realm_json.get("clients", [])
if not clients:
    raise SystemExit("Expected at least one Keycloak client in the embedded realm JSON")

primary_client = clients[0]
primary_client["clientId"] = keycloak_client_id
primary_client["secret"] = keycloak_client_secret
primary_client["rootUrl"] = app_url
primary_client["redirectUris"] = [f"{app_url}/*"]
primary_client["webOrigins"] = [app_url]

default_role_name = f"default-roles-{keycloak_realm}"
if include_bootstrap_dev_users:
    for user in realm_json.get("users", []):
        realm_roles = []
        for role in user.get("realmRoles", []):
            realm_roles.append(default_role_name if role.startswith("default-roles-") else role)
        user["realmRoles"] = realm_roles
else:
    realm_json["users"] = []

rendered_realm = json.dumps(realm_json, indent=2)
indented_realm = "\n".join(f"    {line}" for line in rendered_realm.splitlines())
content = content[:realm_json_start] + indented_realm + content[realm_doc_end:]

docs = content.split("\n---\n")
filtered_docs = []
for doc in docs:
    if "kind: Secret" in doc and "name: oshal-secrets" in doc:
        continue
    filtered_docs.append(doc)

rendered_path.write_text("\n---\n".join(filtered_docs).rstrip() + "\n")
PY
}

generate_secrets() {
  local secret_file="${OUTPUT_DIR}/generated-secrets.yaml"

  kubectl create secret generic oshal-secrets \
    --namespace oshal \
    --from-literal=POSTGRES_DB="${POSTGRES_DB}" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    --from-literal=KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER}" \
    --from-literal=KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD}" \
    --from-literal=KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET}" \
    --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    --from-literal=PRESENTRON_API_KEY="${PRESENTRON_API_KEY:-}" \
    --dry-run=client \
    -o yaml > "${secret_file}"
}

write_bundle() {
  python3 - \
    "${OUTPUT_DIR}/rendered-stack.yaml" \
    "${OUTPUT_DIR}/generated-secrets.yaml" \
    "${OUTPUT_DIR}/bundle.yaml" <<'PY'
from pathlib import Path
import sys

rendered_path = Path(sys.argv[1])
secret_path = Path(sys.argv[2])
bundle_path = Path(sys.argv[3])

docs = rendered_path.read_text().strip().split("\n---\n")
if not docs:
    raise SystemExit("Rendered stack is empty")

namespace_doc = docs[0].strip() + "\n"
remaining_docs = "\n---\n".join(doc.strip() for doc in docs[1:] if doc.strip())
secret_doc = secret_path.read_text().strip() + "\n"

bundle_path.write_text(
    namespace_doc
    + "---\n"
    + secret_doc
    + "---\n"
    + remaining_docs
    + ("\n" if remaining_docs else "")
)
PY
}

validate_manifests() {
  kubectl apply --dry-run=client -f "${OUTPUT_DIR}/generated-secrets.yaml" >/dev/null
  kubectl apply --dry-run=client -f "${OUTPUT_DIR}/rendered-stack.yaml" >/dev/null
}

cluster_available() {
  kubectl version --request-timeout='5s' >/dev/null 2>&1
}

apply_manifests() {
  kubectl apply -f "${OUTPUT_DIR}/bundle.yaml"
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

  MOCK_OIDC="${MOCK_OIDC:-false}"
  KEYCLOAK_REALM="${KEYCLOAK_REALM:-oshal}"
  KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-oshal-swarm}"
  LLM_MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"
  LOG_LEVEL="${LOG_LEVEL:-info}"
  OPENAI_CODEX_CALLBACK_PORT="${OPENAI_CODEX_CALLBACK_PORT:-1455}"
  PRESENTRON_ENDPOINT="${PRESENTRON_ENDPOINT:-http://presentron:8080}"
  RAG_INGESTION_ENDPOINT="${RAG_INGESTION_ENDPOINT:-}"
  SWARM_MODE="${SWARM_MODE:-single}"
  IMAGE_PULL_POLICY="${IMAGE_PULL_POLICY:-IfNotPresent}"
  INCLUDE_BOOTSTRAP_DEV_USERS="${INCLUDE_BOOTSTRAP_DEV_USERS:-false}"

  require_value POSTGRES_DB
  require_value POSTGRES_USER
  require_value POSTGRES_PASSWORD
  require_value KEYCLOAK_ADMIN_USER
  require_value KEYCLOAK_ADMIN_PASSWORD
  require_value KEYCLOAK_CLIENT_SECRET
  require_value APP_URL
  require_value KEYCLOAK_EXTERNAL_URL

  mkdir -p "${OUTPUT_DIR}"

  if [ "${SKIP_BUILD}" != "true" ]; then
    require_command docker
    echo "[oshal-k8s] Building API image from the repository root: ${IMAGE_TAG}"
    docker build -t "${IMAGE_TAG}" -f "${REPO_ROOT}/Dockerfile" "${REPO_ROOT}"
  else
    echo "[oshal-k8s] Skipping image build"
  fi

  echo "[oshal-k8s] Rendering Kubernetes manifests into ${OUTPUT_DIR}"
  render_stack
  generate_secrets
  write_bundle
  validate_manifests

  echo "[oshal-k8s] Generated files:"
  echo "  - ${OUTPUT_DIR}/generated-secrets.yaml"
  echo "  - ${OUTPUT_DIR}/rendered-stack.yaml"
  echo "  - ${OUTPUT_DIR}/bundle.yaml"

  if [ "${APPLY_MANIFESTS}" = "true" ]; then
    if ! cluster_available; then
      echo "ERROR: kubectl cannot reach a Kubernetes API server. Rendered files are available in ${OUTPUT_DIR}." >&2
      exit 1
    fi

    echo "[oshal-k8s] Applying bundle.yaml"
    apply_manifests
    echo "[oshal-k8s] Apply complete"
  else
    echo "[oshal-k8s] Dry-run mode complete. To apply later:"
    echo "  kubectl apply -f ${OUTPUT_DIR}/bundle.yaml"
  fi
}

main "$@"
