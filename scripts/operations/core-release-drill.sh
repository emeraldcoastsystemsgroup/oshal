#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 acceptance drill as one command with asserted outcomes, so the live proof of the core release pipeline is a run and a verdict, not a checklist: promote a cut release to staging, check it, roll staging back and forward again, then promote the same image to production and check it. Every step must exit 0 and the drill stops at the first that does not, naming it. Production is never rolled back by the drill: the rollback is exercised on staging.
# -----------------------------------------------------------------------------
#
# Usage:  bash scripts/operations/core-release-drill.sh --release <core-...> --staging <target> --production <target> [--bootstrap]
#   --bootstrap  the boxes' release dirs predate the helper: every promote step passes --bootstrap
#
# Steps (scripts/core-promote/promote.sh, targets from ~/.oshal-core-release/targets/):
#   1 promote staging   2 status staging   3 rollback staging   4 promote staging again
#   5 status staging    6 promote production                     7 status production
# EXIT: 0 every step passed; 1 a step failed (named, with its exit code); 2 usage
# Runbook: docs/runbooks/core-release-promotion.md

set -uo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROMOTE="$SELF_DIR/../core-promote/promote.sh"
RELEASE=''; STAGING=''; PRODUCTION=''
declare -a BOOT=()

usage() { echo "core-release-drill: $1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --release) [ $# -ge 2 ] || usage "--release needs a value"; RELEASE="$2"; shift 2 ;;
    --staging) [ $# -ge 2 ] || usage "--staging needs a value"; STAGING="$2"; shift 2 ;;
    --production) [ $# -ge 2 ] || usage "--production needs a value"; PRODUCTION="$2"; shift 2 ;;
    --bootstrap) BOOT=(--bootstrap); shift ;;
    *) usage "unknown argument '$1'" ;;
  esac
done
[ -n "$RELEASE" ] && [ -n "$STAGING" ] && [ -n "$PRODUCTION" ] || usage "--release, --staging and --production are required"
[ "$STAGING" != "$PRODUCTION" ] || usage "staging and production must be different targets"
[ -f "$PROMOTE" ] || usage "promote.sh not found beside this script ($PROMOTE)"

STEP=0
# Run one step; stop the drill at the first non-zero exit, naming the step.
step() {
  local label="$1" rc
  shift
  STEP=$((STEP + 1))
  printf '[drill] step %s: %s\n' "$STEP" "$label"
  bash "$PROMOTE" "$@"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '[drill] FAILED at step %s (%s): promote.sh exited %s - see its output above\n' "$STEP" "$label" "$rc"
    exit 1
  fi
}

step "promote $RELEASE to staging ($STAGING)" --target "$STAGING" --release "$RELEASE" "${BOOT[@]}"
step "staging in sync" --target "$STAGING" --status
step "roll staging back" --target "$STAGING" --rollback
step "promote $RELEASE to staging again" --target "$STAGING" --release "$RELEASE" "${BOOT[@]}"
step "staging in sync again" --target "$STAGING" --status
step "promote $RELEASE to production ($PRODUCTION)" --target "$PRODUCTION" --release "$RELEASE" "${BOOT[@]}"
step "production in sync" --target "$PRODUCTION" --status
printf '[drill] PASSED: %s promoted to staging, rolled back and forward, promoted to production; both boxes in sync\n' "$RELEASE"
exit 0
