#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (ADR-129) — operator-triggered OCI publish of the Helm chart to ghcr.io/<owner>/charts/oshal, sibling of publish-images.sh (same .env token pattern, same publish-what-LANDED refusal: the chart dir must be byte-identical to origin/main). helm package + helm registry login + helm push, then a same-session pull-back verification. Prints the one-time UI step (GHCR packages start PRIVATE) — the installer's OCI-first path stays on repo fallback until the package is flipped public.
# =============================================================================
#
# Usage: bash scripts/publish-chart.sh [--skip-login] [--dry-run]
#
# Publish cadence is OPERATOR-TRIGGERED ONLY (no auto-release). Auth: reads
# GITHUB_ADMIN_TOKEN (or GHCR_TOKEN) from the operator-local .env, logs in as
# ${GHCR_USER:-emeraldcoastsystemsgroup}. Token needs write:packages.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OWNER="${GHCR_USER:-emeraldcoastsystemsgroup}"
CHART_DIR="deploy/helm/oshal"
OCI_REPO="oci://ghcr.io/${OWNER}/charts"
SKIP_LOGIN=0; DRY=0
for a in "$@"; do case "$a" in
  --skip-login) SKIP_LOGIN=1 ;;
  --dry-run) DRY=1 ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

command -v helm >/dev/null 2>&1 || { echo "helm is required (winget install Helm.Helm / brew install helm)"; exit 1; }

# Publish what LANDED, not what happens to be in the tree: the chart dir must be
# byte-identical to origin/main (same rule as publish-images.sh's commit label).
git fetch origin --quiet
if ! git diff --quiet origin/main -- "$CHART_DIR"; then
  echo "REFUSING: $CHART_DIR differs from origin/main — land the change first, then publish."
  git diff --stat origin/main -- "$CHART_DIR"
  exit 1
fi

VER=$(grep -E '^version:' "$CHART_DIR/Chart.yaml" | awk '{print $2}')
[ -n "$VER" ] || { echo "could not read chart version from $CHART_DIR/Chart.yaml"; exit 1; }
echo "chart: oshal $VER -> ${OCI_REPO}/oshal:$VER"
[ "$DRY" -eq 1 ] && { echo "DRY RUN — nothing packaged or pushed."; exit 0; }

if [ "$SKIP_LOGIN" -eq 0 ]; then
  TOK="${GHCR_TOKEN:-$(grep -E '^(GITHUB_ADMIN_TOKEN|GHCR_TOKEN)=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')}"
  [ -n "$TOK" ] || { echo "no GITHUB_ADMIN_TOKEN/GHCR_TOKEN in .env and GHCR_TOKEN unset"; exit 1; }
  printf '%s' "$TOK" | helm registry login ghcr.io -u "$OWNER" --password-stdin >/dev/null
fi

PKG_DIR=$(mktemp -d)
trap 'rm -rf "$PKG_DIR"' EXIT
helm package "$CHART_DIR" --destination "$PKG_DIR" >/dev/null
helm push "$PKG_DIR/oshal-${VER}.tgz" "$OCI_REPO"

# Pull-back verification in this session (still authenticated — an anonymous
# check only means something after the UI visibility flip below).
helm show chart "${OCI_REPO}/oshal" --version "$VER" | head -4

echo
echo "PUBLISHED ${OCI_REPO}/oshal:$VER"
echo "ONE-TIME UI STEP if this was the first chart push: GHCR packages start PRIVATE."
echo "Flip 'charts/oshal' public at https://github.com/users/${OWNER}/packages"
echo "(or the org packages page) — until then, anonymous installers keep using the"
echo "repo fallback, and 'helm install oci://…' only works for logged-in users."
