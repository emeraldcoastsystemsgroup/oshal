#!/usr/bin/env bash
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the compose/self-host release push: tag + push the three OSHAL images (oshal-bot + the two sidecars) to GHCR as :latest, :<package.json version>, and :sha-<HEAD12>. Refuses to publish an oshal-bot whose baked commit label is not origin/main HEAD (you publish what LANDED, not what happens to be tagged locally). The k8s/Gardener release path stays scripts/oshal-harbor-build-push.sh — different artifact, different pipeline.
# =============================================================================
#
# Usage:
#   bash scripts/publish-images.sh [--skip-login] [--dry-run]
#
# Auth: reads GITHUB_ADMIN_TOKEN (or GHCR_TOKEN) from the operator-local .env,
# logs in as ${GHCR_USER:-emeraldcoastsystemsgroup}. Token needs write:packages.
# First push creates each package PRIVATE — flipping public is the deliberate
# launch-day step in the GitHub UI, never a side effect of this script.

set -euo pipefail

ORG="${OSHAL_REGISTRY:-ghcr.io/emeraldcoastsystemsgroup}"
DRY=0; SKIP_LOGIN=0
for a in "$@"; do case "$a" in
  --dry-run) DRY=1 ;;
  --skip-login) SKIP_LOGIN=1 ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

VER=$(node -e "console.log(require('./package.json').version)")
SHA=$(git rev-parse --short=12 HEAD)
say() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

# ── Publish-what-landed guard ────────────────────────────────────────────────
git fetch --quiet origin main 2>/dev/null || true
ORIGIN_SHA=$(git rev-parse origin/main)
LABEL=$(docker image inspect --format '{{index .Config.Labels "oshal.git.commit"}}' oshal-bot:latest 2>/dev/null || echo "")
if [ "$LABEL" != "$ORIGIN_SHA" ]; then
  echo "REFUSED: oshal-bot:latest carries commit label '${LABEL:-none}' but origin/main is $ORIGIN_SHA."
  echo "Build the release image first (it stamps the label): bash scripts/oshal-deploy.sh"
  exit 1
fi

# ── Auth ─────────────────────────────────────────────────────────────────────
if [ "$SKIP_LOGIN" -ne 1 ]; then
  TOK="${GHCR_TOKEN:-$(grep -E '^(GITHUB_ADMIN_TOKEN|GHCR_TOKEN)=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')}"
  [ -n "$TOK" ] || { echo "no GITHUB_ADMIN_TOKEN/GHCR_TOKEN in .env and GHCR_TOKEN unset"; exit 1; }
  printf '%s' "$TOK" | docker login ghcr.io -u "${GHCR_USER:-emeraldcoastsystemsgroup}" --password-stdin >/dev/null
  say "ghcr login ok"
fi

# local source image => published basename
PAIRS=(
  "oshal-bot:latest=oshal-bot"
  "oshal-local-speaker-diarization:latest=oshal-speaker-diarization"
)

for pair in "${PAIRS[@]}"; do
  SRC="${pair%%=*}"; NAME="${pair##*=}"
  if ! docker image inspect "$SRC" >/dev/null 2>&1; then
    say "SKIP $NAME — local image $SRC not present (build it first: compose build / oshal-deploy)"
    continue
  fi
  for TAG in "$VER" "sha-$SHA" latest; do
    say "push $ORG/$NAME:$TAG"
    if [ "$DRY" -eq 0 ]; then
      docker tag "$SRC" "$ORG/$NAME:$TAG"
      docker push "$ORG/$NAME:$TAG" >/dev/null
    fi
  done
done
SUFFIX=""; [ "$DRY" -eq 1 ] && SUFFIX=" (dry run)"
say "done — version $VER, sha-$SHA$SUFFIX"
