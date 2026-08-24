#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Guarded CRM managed-Postgres Compose launcher: root-owned 0600 env, immutable image reference, dedicated-host marker, CA trust-anchor validation, hostile parent-shell DSN scrubbing, and the pinned CRM-only service set.
# -----------------------------------------------------------------------------
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Guarded CRM deployment wrapper. It deliberately has no generic pass-through
# `up`: the managed database connection budget is sized for exactly this set.
# Install an authenticated commit into a root-owned, non-group/world-writable
# release directory before invoking this script. Never sudo a user-writable
# checkout: a root launcher cannot protect itself after its source is replaced.
readonly MIN_COMPOSE_VERSION="2.24.4"
readonly LAUNCHER_INPUT="${BASH_SOURCE[0]}"
if [[ "$LAUNCHER_INPUT" = /* ]]; then
  launcher_candidate="$LAUNCHER_INPUT"
else
  launcher_candidate="$(pwd -P)/$LAUNCHER_INPUT"
fi
launcher_resolved="$(realpath "$launcher_candidate")"
[[ "$launcher_candidate" = "$launcher_resolved" && ! -L "$launcher_candidate" ]] || {
  echo "Managed launcher path must not contain symlinks" >&2
  exit 66
}
readonly LAUNCHER_PATH="$launcher_resolved"
readonly REPO_ROOT="$(dirname -- "$(dirname -- "$LAUNCHER_PATH")")"
readonly BASE_FILE="$REPO_ROOT/docker-compose.oshal-local.yml"
readonly MANAGED_FILE="$REPO_ROOT/docker-compose.managed-postgres.yml"
readonly POSTGRES_CA_HOST_FILE="$REPO_ROOT/config-seed/do-postgres-ca.pem"
readonly BOOTSTRAP_SCRIPT="$REPO_ROOT/scripts/governance/bootstrap-managed-postgres.mjs"
readonly PROVISION_SCRIPT="$REPO_ROOT/scripts/governance/provision-app-role.mjs"
readonly PROVISION_SQL="$REPO_ROOT/docs/governance/app-role-provisioning.sql"
readonly MIGRATIONS_DIR="$REPO_ROOT/scripts/migrations"
readonly -a CRM_SERVICES=(
  oshal-db
  oshal-redis
  oshal-chromadb
  oshal-api
  jarvis-bot
  sales-bot
)
readonly -a DIAGNOSTIC_SERVICES=(oshal-db-init "${CRM_SERVICES[@]}")
readonly DEFAULT_DEPLOYMENT_MARKER_FILE="/etc/oshal/deployment-id"
declare -a ENV_FILE_KEYS=()
declare -A ENV_FILE_KEY_SEEN=()

usage() {
  echo "Usage: $0 <crm-env-file> {up|validate|ps|logs|down}" >&2
  exit 64
}

fail() {
  echo "$1" >&2
  exit "${2:-64}"
}

validate_trusted_path_components() {
  local target="$1" label="$2" resolved component part owner mode
  local -a trusted_parts=()
  [[ "$target" = /* ]] || fail "$label must use an absolute path" 66
  resolved="$(realpath "$target")" || fail "$label does not exist: $target" 66
  [[ "$resolved" = "$target" ]] || {
    fail "$label path must be normalized and must not traverse symlinks: $target" 66
  }
  component=""
  IFS='/' read -r -a trusted_parts <<<"${target#/}"
  for part in "${trusted_parts[@]}"; do
    [[ -n "$part" ]] || continue
    component="${component}/$part"
    [[ -e "$component" && ! -L "$component" ]] || {
      fail "$label path contains a missing or symlinked component: $component" 66
    }
    owner="$(stat -c '%u' -- "$component")"
    mode="$(stat -c '%a' -- "$component")"
    [[ "$owner" = "0" ]] || fail "$label path component must be owned by root: $component" 66
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || fail "Could not validate $label path permissions" 66
    (( (8#$mode & 8#022) == 0 )) || {
      fail "$label path component must not be group/world writable: $component" 66
    }
  done
}

validate_trusted_regular_file() {
  local file="$1" label="$2"
  validate_trusted_path_components "$file" "$label"
  [[ -f "$file" && ! -L "$file" ]] || fail "$label must be a regular, non-symlink file: $file" 66
}

validate_trusted_directory() {
  local directory="$1" label="$2"
  validate_trusted_path_components "$directory" "$label"
  [[ -d "$directory" && ! -L "$directory" ]] || fail "$label must be a non-symlink directory: $directory" 66
}

validate_release_assets() {
  local migration migration_count=0
  validate_trusted_directory "$REPO_ROOT" "Managed release root"
  validate_trusted_regular_file "$LAUNCHER_PATH" "Managed launcher"
  validate_trusted_regular_file "$BASE_FILE" "Base Compose file"
  validate_trusted_regular_file "$MANAGED_FILE" "Managed Compose file"
  validate_trusted_regular_file "$BOOTSTRAP_SCRIPT" "Managed bootstrap script"
  validate_trusted_regular_file "$PROVISION_SCRIPT" "Role provisioning script"
  validate_trusted_regular_file "$PROVISION_SQL" "Role provisioning SQL"
  validate_trusted_directory "$MIGRATIONS_DIR" "Migration directory"
  while IFS= read -r -d '' migration; do
    validate_trusted_regular_file "$migration" "Migration SQL"
    migration_count=$((migration_count + 1))
  done < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -name '*.sql' -print0)
  (( migration_count > 0 )) || fail "Migration directory contains no SQL migrations" 66
}

read_required_env_value() {
  local key="$1" file="$2" line
  local -a matches=()
  mapfile -t matches < <(grep -E "^[[:space:]]*${key}[[:space:]]*=" -- "$file" || true)
  [[ "${#matches[@]}" -eq 1 ]] || fail "CRM env file must define ${key} exactly once"
  line="${matches[0]}"
  line="${line#*=}"
  [[ -n "$line" && "$line" != *[$' \t\r\n\"\047#']* ]] || {
    fail "${key} must be a non-empty, unquoted value without whitespace or comments"
  }
  printf '%s' "$line"
}

validate_env_file_keys() {
  local file="$1" line key line_number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      fail "CRM env file has malformed syntax at line $line_number" 66
    fi
    key="${BASH_REMATCH[1]}"
    [[ -z "${ENV_FILE_KEY_SEEN[$key]+x}" ]] || fail "CRM env file defines $key more than once" 66
    ENV_FILE_KEY_SEEN[$key]=1
    ENV_FILE_KEYS+=("$key")
  done <"$file"
}

require_env_key() {
  local key="$1"
  [[ -n "${ENV_FILE_KEY_SEEN[$key]+x}" ]] || fail "CRM env file must define $key exactly once"
}

validate_deployment_identity() {
  local marker_file="$1" deployment_id="$2" marker_mode
  [[ "$deployment_id" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || {
    fail "OSHAL_MANAGED_DEPLOYMENT_ID must be a lowercase safe slug (3-63 characters)"
  }
  [[ "$deployment_id" != "oshal-local" ]] || fail "The managed deployment project must not be oshal-local"
  validate_trusted_path_components "$marker_file" "Dedicated-host marker"
  [[ "$marker_file" = /* && -f "$marker_file" && ! -L "$marker_file" ]] || {
    fail "Dedicated-host marker must be an absolute, regular, non-symlink file: $marker_file" 66
  }
  [[ "$(stat -c '%u' -- "$marker_file")" = "0" ]] || fail "Dedicated-host marker must be owned by root" 66
  marker_mode="$(stat -c '%a' -- "$marker_file")"
  [[ "$marker_mode" =~ ^[0-7]{3,4}$ ]] || fail "Could not validate dedicated-host marker permissions" 66
  (( (8#$marker_mode & 8#022) == 0 )) || fail "Dedicated-host marker must not be group/world writable" 66
  cmp -s -- "$marker_file" <(printf '%s\n' "$deployment_id") || {
    fail "Dedicated-host marker does not exactly match OSHAL_MANAGED_DEPLOYMENT_ID" 66
  }
}

validate_bot_image() {
  local image="$1"
  [[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]+$ ]] || fail "OSHAL_BOT_IMAGE is not a safe image reference"
  [[ "$image" != *":latest" ]] || fail "OSHAL_BOT_IMAGE must not use the mutable latest tag"
  if [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
    return 0
  fi
  if [[ "$image" =~ :sha-[0-9a-f]{7,64}$ ]]; then
    return 0
  fi
  fail "OSHAL_BOT_IMAGE must use an immutable digest or sha-<git-sha> tag"
}

validate_ca_trust_anchor() {
  local ca_file="$1" ca_mode resolved_ca_file
  validate_trusted_path_components "$ca_file" "PostgreSQL CA trust anchor"
  [[ -f "$ca_file" && ! -L "$ca_file" && -s "$ca_file" ]] || {
    fail "PostgreSQL CA trust anchor must be a non-empty regular, non-symlink file: $ca_file" 66
  }
  [[ "$(stat -c '%u' -- "$ca_file")" = "0" ]] || {
    fail "PostgreSQL CA trust anchor must be owned by root" 66
  }
  ca_mode="$(stat -c '%a' -- "$ca_file")"
  [[ "$ca_mode" = "600" || "$ca_mode" = "644" ]] || {
    fail "PostgreSQL CA trust anchor must have mode 0600 or 0644" 66
  }
  resolved_ca_file="$(realpath "$ca_file")" || {
    fail "Could not resolve PostgreSQL CA trust anchor" 66
  }
  [[ "$resolved_ca_file" = "$ca_file" ]] || {
    fail "PostgreSQL CA trust anchor path must not traverse a symlink" 66
  }
  grep -Fqx -- '-----BEGIN CERTIFICATE-----' "$ca_file" &&
    grep -Fqx -- '-----END CERTIFICATE-----' "$ca_file" || {
      fail "PostgreSQL CA trust anchor must contain a PEM certificate" 66
    }
  command -v openssl >/dev/null 2>&1 || fail "openssl is required to validate the PostgreSQL CA trust anchor" 69
  openssl x509 -in "$ca_file" -noout >/dev/null 2>&1 || {
    fail "PostgreSQL CA trust anchor is not a parseable X.509 certificate" 66
  }
}

prepare_evidence_dir() {
  local evidence_dir="$1"
  [[ "$(id -u)" = "0" ]] || {
    echo "Managed production deployment must run as root so bootstrap evidence stays root-only" >&2
    return 1
  }
  [[ "$evidence_dir" = /* && ! -L "$evidence_dir" ]] || {
    echo "Bootstrap evidence directory must be an absolute, non-symlink path" >&2
    return 1
  }
  install -d -m 700 -- "$evidence_dir"
  validate_trusted_path_components "$evidence_dir" "Bootstrap evidence directory"
  [[ "$(stat -c '%u' "$evidence_dir")" = "0" ]] || {
    echo "Bootstrap evidence directory must be owned by root" >&2
    return 1
  }
  chmod 700 -- "$evidence_dir"
}

wait_for_init() {
  local deadline="$1" container_id state exit_code
  while (( SECONDS < deadline )); do
    container_id="$("${COMPOSE[@]}" ps -a -q oshal-db-init)"
    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
      if [[ "$state" = "exited" || "$state" = "dead" ]]; then
        exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
        [[ "$state" = "exited" && "$exit_code" = "0" ]]
        return
      fi
    fi
    sleep 2
  done
  echo "Timed out waiting for managed PostgreSQL initialization" >&2
  return 1
}

wait_for_runtime_health() {
  local deadline="$1" service container_id health all_healthy
  while (( SECONDS < deadline )); do
    all_healthy=true
    for service in "${CRM_SERVICES[@]}"; do
      container_id="$("${COMPOSE[@]}" ps -q "$service")"
      if [[ -z "$container_id" ]]; then
        all_healthy=false
        break
      fi
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
      if [[ "$health" != "healthy" && "$health" != "running" ]]; then
        all_healthy=false
        break
      fi
    done
    [[ "$all_healthy" = true ]] && return 0
    sleep 2
  done
  echo "Timed out waiting for the CRM runtime service set to become healthy" >&2
  return 1
}

assert_exact_running_topology() {
  local mode="${1:-pre}" service allowed candidate
  local -a unexpected=() missing=() running_services=() allowed_services=()
  declare -A seen=()
  case "$mode" in
    pre) allowed_services=("${DIAGNOSTIC_SERVICES[@]}") ;;
    post) allowed_services=("${CRM_SERVICES[@]}") ;;
    *) fail "Unknown topology assertion mode: $mode" ;;
  esac
  mapfile -t running_services < <(
    docker ps \
      --filter "label=com.docker.compose.project=$OSHAL_MANAGED_DEPLOYMENT_ID" \
      --format '{{.Label "com.docker.compose.service"}}'
  )
  for service in "${running_services[@]}"; do
    allowed=false
    for candidate in "${allowed_services[@]}"; do
      [[ "$service" = "$candidate" ]] && allowed=true && break
    done
    if [[ "$allowed" != true || -z "$service" || -n "${seen[$service]+x}" ]]; then
      unexpected+=("${service:-<missing-service-label>}")
    fi
    seen[$service]=1
  done
  if [[ "$mode" = "post" ]]; then
    for service in "${CRM_SERVICES[@]}"; do
      [[ -n "${seen[$service]+x}" ]] || missing+=("$service")
    done
  fi
  [[ "${#unexpected[@]}" -eq 0 ]] || {
    echo "Unexpected running service(s) in managed CRM project: ${unexpected[*]}" >&2
    echo "Stop them deliberately before deploy; the managed connection budget permits only the CRM service set." >&2
    return 1
  }
  [[ "${#missing[@]}" -eq 0 ]] || {
    echo "Missing running service(s) from managed CRM project: ${missing[*]}" >&2
    return 1
  }
}

version_at_least() {
  local actual="${1#v}" required="$2"
  local a_major a_minor a_patch r_major r_minor r_patch
  IFS=. read -r a_major a_minor a_patch <<<"$actual"
  IFS=. read -r r_major r_minor r_patch <<<"$required"
  a_patch="${a_patch%%[^0-9]*}"; a_patch="${a_patch:-0}"
  r_patch="${r_patch%%[^0-9]*}"; r_patch="${r_patch:-0}"
  (( a_major > r_major )) ||
    (( a_major == r_major && a_minor > r_minor )) ||
    (( a_major == r_major && a_minor == r_minor && a_patch >= r_patch ))
}

[[ $# -eq 2 ]] || usage
[[ "$(id -u)" = "0" ]] || fail "Managed production deployment must run as root" 77
readonly CRM_ENV_FILE="$1"
readonly ACTION="$2"
validate_trusted_path_components "$CRM_ENV_FILE" "CRM env file"
[[ "$CRM_ENV_FILE" = /* && -f "$CRM_ENV_FILE" && ! -L "$CRM_ENV_FILE" && -r "$CRM_ENV_FILE" ]] || {
  fail "CRM env file must be an absolute, readable, regular, non-symlink file" 66
}
[[ "$(stat -c '%u' -- "$CRM_ENV_FILE")" = "0" ]] || fail "CRM env file must be owned by root" 66
[[ "$(stat -c '%a' -- "$CRM_ENV_FILE")" = "600" ]] || fail "CRM env file must have mode 0600" 66
validate_release_assets
validate_ca_trust_anchor "$POSTGRES_CA_HOST_FILE"
cd "$REPO_ROOT"

validate_env_file_keys "$CRM_ENV_FILE"
for required_key in \
  OSHAL_MANAGED_DEPLOYMENT_ID OSHAL_BOT_IMAGE \
  BOOTSTRAP_DATABASE_URL DATABASE_URL BOT_DATABASE_URL \
  OSHAL_DELEGATION_SIGNING_KID OSHAL_DELEGATION_SIGNING_PRIVATE_KEY \
  OSHAL_DELEGATION_PUBLIC_KEYS; do
  require_env_key "$required_key"
done
file_deployment_id="$(read_required_env_value OSHAL_MANAGED_DEPLOYMENT_ID "$CRM_ENV_FILE")"
file_bot_image="$(read_required_env_value OSHAL_BOT_IMAGE "$CRM_ENV_FILE")"
if [[ -n "${OSHAL_MANAGED_DEPLOYMENT_ID+x}" && "$OSHAL_MANAGED_DEPLOYMENT_ID" != "$file_deployment_id" ]]; then
  fail "Exported OSHAL_MANAGED_DEPLOYMENT_ID conflicts with the CRM env file"
fi
if [[ -n "${OSHAL_BOT_IMAGE+x}" && "$OSHAL_BOT_IMAGE" != "$file_bot_image" ]]; then
  fail "Exported OSHAL_BOT_IMAGE conflicts with the CRM env file"
fi
export OSHAL_MANAGED_DEPLOYMENT_ID="$file_deployment_id"
export OSHAL_BOT_IMAGE="$file_bot_image"
readonly OSHAL_MANAGED_DEPLOYMENT_ID OSHAL_BOT_IMAGE
validate_bot_image "$OSHAL_BOT_IMAGE"

# Docker Compose gives the parent shell higher interpolation precedence than
# --env-file. Prefix every Compose invocation with env -u for every env-file key
# and every Compose interpolation key. This makes the audited file authoritative
# without sourcing/evaluating it or ever reading secret values into shell vars.
mapfile -t compose_interpolation_keys < <(
  grep -hEo '\$\{[A-Za-z_][A-Za-z0-9_]*' -- "$BASE_FILE" "$MANAGED_FILE" |
    sed 's/^${//' |
    sort -u
)
declare -a COMPOSE_ENV_PREFIX=(env)
declare -A compose_unset_seen=()
for interpolation_key in "${ENV_FILE_KEYS[@]}" "${compose_interpolation_keys[@]}"; do
  [[ -z "${compose_unset_seen[$interpolation_key]+x}" ]] || continue
  compose_unset_seen[$interpolation_key]=1
  COMPOSE_ENV_PREFIX+=(-u "$interpolation_key")
done

deployment_marker_file="$DEFAULT_DEPLOYMENT_MARKER_FILE"
if [[ -n "${OSHAL_DEPLOYMENT_MARKER_FILE:-}" ]]; then
  [[ "${OSHAL_ALLOW_TEST_MARKER_OVERRIDE:-}" = "1" ]] || {
    fail "OSHAL_DEPLOYMENT_MARKER_FILE override is restricted to explicit test runs"
  }
  deployment_marker_file="$OSHAL_DEPLOYMENT_MARKER_FILE"
fi
validate_deployment_identity "$deployment_marker_file" "$OSHAL_MANAGED_DEPLOYMENT_ID"

compose_version="$(docker compose version --short)"
version_at_least "$compose_version" "$MIN_COMPOSE_VERSION" || {
  echo "Docker Compose >= $MIN_COMPOSE_VERSION is required (found $compose_version)" >&2
  exit 69
}

readonly -a COMPOSE=(
  "${COMPOSE_ENV_PREFIX[@]}"
  docker compose
  --project-name "$OSHAL_MANAGED_DEPLOYMENT_ID"
  --env-file "$CRM_ENV_FILE"
  -f "$BASE_FILE"
  -f "$MANAGED_FILE"
  --profile sales-node
)

# Interpolation, required URL variables, merge tags, and the complete topology
# must validate before any service is created.
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" config --images | grep -Fqx -- "$OSHAL_BOT_IMAGE" || {
  fail "Effective Compose configuration does not use the approved OSHAL_BOT_IMAGE"
}

case "$ACTION" in
  up)
    # --remove-orphans does not stop declared but unrequested base services.
    # Refuse the deploy before any mutation when this dedicated project already
    # runs anything outside the exact CRM topology or has a scaled duplicate.
    assert_exact_running_topology pre
    readonly EVIDENCE_DIR="${OSHAL_BOOTSTRAP_EVIDENCE_DIR:-/var/log/oshal/managed-postgres}"
    readonly WAIT_SECONDS="${OSHAL_DEPLOY_WAIT_SECONDS:-600}"
    [[ "$WAIT_SECONDS" =~ ^[0-9]+$ && "$WAIT_SECONDS" -ge 30 ]] || {
      echo "OSHAL_DEPLOY_WAIT_SECONDS must be an integer >= 30" >&2
      exit 64
    }
    prepare_evidence_dir "$EVIDENCE_DIR"
    umask 077
    evidence_file="$EVIDENCE_DIR/bootstrap-$(date -u +%Y%m%dT%H%M%SZ).log"
    finalize_init() {
      "${COMPOSE[@]}" logs --no-color oshal-db-init >"$evidence_file" 2>&1 || true
      chmod 600 -- "$evidence_file" 2>/dev/null || true
      "${COMPOSE[@]}" rm -f -s oshal-db-init >/dev/null 2>&1 || true
    }
    trap finalize_init EXIT
    "${COMPOSE[@]}" up -d --remove-orphans "${CRM_SERVICES[@]}"
    deadline=$((SECONDS + WAIT_SECONDS))
    wait_for_init "$deadline" || exit 1
    wait_for_runtime_health "$deadline" || exit 1
    assert_exact_running_topology post || exit 1
    finalize_init
    trap - EXIT
    echo "CRM runtime is healthy; bootstrap evidence saved with mode 0600 and the credential-bearing init container removed."
    ;;
  validate)
    echo "Managed PostgreSQL CRM compose configuration is valid."
    ;;
  ps)
    exec "${COMPOSE[@]}" ps -a "${DIAGNOSTIC_SERVICES[@]}"
    ;;
  logs)
    exec "${COMPOSE[@]}" logs --tail=200 "${DIAGNOSTIC_SERVICES[@]}"
    ;;
  down)
    # This is intentionally project-wide. The root-owned dedicated-host marker
    # and pinned project name above are mandatory before this destructive scope.
    exec "${COMPOSE[@]}" down
    ;;
  *)
    usage
    ;;
esac
