#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR                                  | DESCRIPTION
# -----------------------------------------------------------------------------
# 1   | maintainer@emeraldcoastsystemsgroup.com | Initial deploy drift detection: compare release-dir SHA vs running image SHA vs origin/main. Support human and --json output with exit 0 (parity), 1 (drift), 2 (error).
# =============================================================================
#
# USAGE:
#   bash scripts/oshal-deploy-drift.sh [--json] [--quiet] [--container <name>]
#
# EXIT CODES:
#   0 = all in parity (release == running == main)
#   1 = drift detected
#   2 = environment/inspection error
#

set -uo pipefail

JSON_MODE=0
QUIET_MODE=0
TARGET_CONTAINER="${OSHAL_API_CONTAINER:-oshal-local-api}"

for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
    --quiet) QUIET_MODE=1 ;;
    --container) shift; TARGET_CONTAINER="${1:-}" ;;
    -h|--help)
      echo "Usage: bash scripts/oshal-deploy-drift.sh [--json] [--quiet] [--container <name>]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. Release directory HEAD SHA
if ! command -v git >/dev/null 2>&1; then
  echo "deploy-drift: git CLI not available" >&2
  exit 2
fi

RELEASE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null | tr -d '\r\n' || true)"
if [ -z "$RELEASE_SHA" ]; then
  echo "deploy-drift: failed to resolve release-dir git HEAD" >&2
  exit 2
fi

# 2. Main branch SHA (prefer origin/main, fall back to refs/remotes/origin/main, then local main)
MAIN_SHA="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null | tr -d '\r\n' || true)"
if [ -z "$MAIN_SHA" ]; then
  MAIN_SHA="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main 2>/dev/null | tr -d '\r\n' || true)"
fi
if [ -z "$MAIN_SHA" ]; then
  MAIN_SHA="$(git -C "$REPO_ROOT" rev-parse main 2>/dev/null | tr -d '\r\n' || true)"
fi
if [ -z "$MAIN_SHA" ]; then
  MAIN_SHA="$RELEASE_SHA"
fi

# 3. Running image commit SHA
RUNNING_SHA="${OSHAL_MOCK_RUNNING_SHA:-}"
if [ -z "$RUNNING_SHA" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Try label org.opencontainers.image.revision
    RUNNING_SHA="$(docker inspect "$TARGET_CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null | tr -d '\r\n' || true)"
    if [ -z "$RUNNING_SHA" ] || [ "$RUNNING_SHA" = "<no value>" ]; then
      # Try environment variable GIT_SHA
      RUNNING_SHA="$(docker inspect "$TARGET_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E '^GIT_SHA=' | head -1 | cut -d= -f2 | tr -d '\r\n' || true)"
    fi
  fi
fi

# If running SHA could not be read, treat as unverified/missing unless mock is provided
INSPECTION_ERROR=0
if [ -z "$RUNNING_SHA" ] || [ "$RUNNING_SHA" = "<no value>" ]; then
  RUNNING_SHA="unavailable"
  INSPECTION_ERROR=1
fi

# Check parity
DRIFT_ITEMS=()
if [ "$RELEASE_SHA" != "$MAIN_SHA" ]; then
  DRIFT_ITEMS+=("release-dir differs from main (${RELEASE_SHA:0:12} vs ${MAIN_SHA:0:12})")
fi

if [ "$RUNNING_SHA" != "unavailable" ] && [ "${RUNNING_SHA:0:12}" != "${RELEASE_SHA:0:12}" ]; then
  DRIFT_ITEMS+=("running container differs from release-dir (${RUNNING_SHA:0:12} vs ${RELEASE_SHA:0:12})")
fi

IS_PARITY=1
if [ ${#DRIFT_ITEMS[@]} -gt 0 ] || [ "$INSPECTION_ERROR" -eq 1 ]; then
  IS_PARITY=0
fi

if [ "$JSON_MODE" -eq 1 ]; then
  DRIFT_JSON="[]"
  if [ ${#DRIFT_ITEMS[@]} -gt 0 ]; then
    DRIFT_JSON="$(printf '%s\n' "${DRIFT_ITEMS[@]}" | awk 'BEGIN{printf "["} NR>1{printf ", "} {printf "\"%s\"", $0} END{printf "]"}')"
  fi
  cat <<EOF
{
  "releaseSha": "$RELEASE_SHA",
  "mainSha": "$MAIN_SHA",
  "runningSha": "$RUNNING_SHA",
  "inParity": $([ "$IS_PARITY" -eq 1 ] && echo "true" || echo "false"),
  "error": $([ "$INSPECTION_ERROR" -eq 1 ] && echo "true" || echo "false"),
  "drift": $DRIFT_JSON
}
EOF
  if [ "$INSPECTION_ERROR" -eq 1 ]; then exit 2; fi
  if [ "$IS_PARITY" -eq 1 ]; then exit 0; else exit 1; fi
fi

if [ "$QUIET_MODE" -eq 0 ]; then
  echo "OSHAL Core Deploy Drift Check"
  echo "  Release dir HEAD : ${RELEASE_SHA:0:12} ($RELEASE_SHA)"
  echo "  origin/main HEAD : ${MAIN_SHA:0:12} ($MAIN_SHA)"
  echo "  Running container: ${RUNNING_SHA:0:12} ($RUNNING_SHA)"
  echo ""
  if [ "$INSPECTION_ERROR" -eq 1 ]; then
    echo "  UNVERIFIED — running container $TARGET_CONTAINER could not be inspected."
  elif [ "$IS_PARITY" -eq 1 ]; then
    echo "  OK — release-dir, running container, and main branch are in complete parity."
  else
    echo "  DRIFT DETECTED:"
    for item in "${DRIFT_ITEMS[@]}"; do
      echo "    - $item"
    done
  fi
fi

if [ "$INSPECTION_ERROR" -eq 1 ]; then
  exit 2
fi

if [ "$IS_PARITY" -eq 1 ]; then
  exit 0
else
  exit 1
fi
