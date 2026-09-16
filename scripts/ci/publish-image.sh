#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Nothing has ever published this trunk's container image: the only pusher is the workflow_dispatch-only image job in .github/workflows/ci.yml, whose run count on this repository is zero, so ghcr.io .../oshal-bot:latest is still the pre-cutover 2026-07-26 artifact and `--mode 1` - the DEFAULT documented install - hands it to every new user. A stale image does not look stale: the remote box that installed it reported MISSING FEATURES and cost a day of misdirected configuration work. This publishes from the nightly local gate instead of hosted runners, which spends none of the constrained resource and puts the build, the kernel-skills image probe, the smoke boot and the Trivy scan in front of the push. It is fail-closed on every input: a red run, an unpinned sha, or an absent credential publishes nothing.
#
# Usage:  publish-image.sh --sha <short-sha> --local <local-tag> --remote <repo> [--failed "<gate names>"]
#
# Reads OSHAL_GHCR_TOKEN and OSHAL_GHCR_USER from the environment. The token is never echoed,
# never passed on a command line (it goes in on stdin, so it stays off the process table), and
# only its LENGTH is ever reported.

set -uo pipefail

SHORT_SHA=""; LOCAL_TAG=""; REMOTE=""; FAILED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sha)    SHORT_SHA="${2:-}"; shift 2 ;;
    --local)  LOCAL_TAG="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --failed) FAILED="${2:-}"; shift 2 ;;
    *) echo "publish-image: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

# A red run must never publish. This is the whole reason the step lives behind the gates rather
# than beside them: the value of publishing from the local gate is that the build, the image
# probes and the scan have already run, and that value is zero if a failure can still push.
if [ -n "${FAILED//[[:space:]]/}" ]; then
  echo "publish-image: REFUSED - the run is red ($FAILED); only an all-green run may publish" >&2
  exit 2
fi

# The tag has to name the commit the image was built from, or a later reader cannot tell which
# code is in it - which is the exact failure this whole entry is about.
if ! printf '%s' "$SHORT_SHA" | grep -Eq '^[0-9a-f]{7,40}$'; then
  echo "publish-image: REFUSED - --sha must be the run's pinned commit, got '${SHORT_SHA:-<empty>}'" >&2
  exit 4
fi

if [ -z "$LOCAL_TAG" ] || [ -z "$REMOTE" ]; then
  echo "publish-image: REFUSED - --local and --remote are both required" >&2
  exit 64
fi

TOKEN="${OSHAL_GHCR_TOKEN:-}"
GHCR_USER="${OSHAL_GHCR_USER:-}"
if [ -z "$TOKEN" ] || [ -z "$GHCR_USER" ]; then
  echo "publish-image: REFUSED - OSHAL_GHCR_TOKEN and OSHAL_GHCR_USER must both be set; nothing was pushed" >&2
  exit 3
fi

REGISTRY="${REMOTE%%/*}"

if ! printf '%s' "$TOKEN" | timeout 120 docker login "$REGISTRY" --username "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  echo "publish-image: REFUSED - $REGISTRY rejected the credential (token length ${#TOKEN}); nothing was pushed" >&2
  exit 5
fi

# The immutable sha- tag goes first. If the run dies between the two pushes, the registry holds a
# record of WHAT was published before `latest` starts pointing at it - never the reverse.
rc=0
docker tag "$LOCAL_TAG" "$REMOTE:sha-$SHORT_SHA" || rc=$?
if [ $rc -eq 0 ]; then docker tag "$LOCAL_TAG" "$REMOTE:latest" || rc=$?; fi
if [ $rc -eq 0 ]; then timeout 3600 docker push "$REMOTE:sha-$SHORT_SHA" || rc=$?; fi
if [ $rc -eq 0 ]; then timeout 3600 docker push "$REMOTE:latest" || rc=$?; fi

timeout 60 docker logout "$REGISTRY" >/dev/null 2>&1 || true

if [ $rc -ne 0 ]; then
  echo "publish-image: FAILED - the push did not complete (exit $rc); the registry may hold sha-$SHORT_SHA without latest" >&2
  exit $rc
fi

DIGEST="$(docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$REMOTE:latest" 2>/dev/null || true)"
echo "publish-image: pushed $REMOTE:sha-$SHORT_SHA and $REMOTE:latest${DIGEST:+ ($DIGEST)}"
