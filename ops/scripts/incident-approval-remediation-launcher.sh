#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# =============================================================================
# incident-approval-remediation-launcher.sh
# -----------------------------------------------------------------------------
# Launchctl entrypoint for the incident approval/remediation loop.
# Sets the minimal PATH we need in the launchd environment, moves into the repo,
# and keeps the loop alive by relaunching it if it exits.
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
LOOP_OUT="${LOG_DIR}/incident-approval-remediation-loop.out"
WRAPPER_OUT="${LOG_DIR}/incident-approval-remediation-launcher.out"

mkdir -p "${LOG_DIR}"

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Docker.app/Contents/Resources/bin:/Users/SAPUSER/.homebrew/bin:/Users/SAPUSER/.homebrew/sbin:/Users/SAPUSER/bin"

ts() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log_wrapper() {
  printf '[%s] %s\n' "$(ts)" "$*" >> "${WRAPPER_OUT}"
}

trap 'log_wrapper "launcher stopping"; exit 0' SIGINT SIGTERM
trap '' SIGHUP

cd "${ROOT_DIR}"

while true; do
  bash ops/scripts/incident-approval-remediation-loop.sh >> "${LOOP_OUT}" 2>&1
  log_wrapper "loop exited with code=$?; restarting in 5s"
  sleep 5
done
