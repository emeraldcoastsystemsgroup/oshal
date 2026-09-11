#!/usr/bin/env bash
# CHANGE LOG
# 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve every local CI run while retaining the legacy latest-log alias.

# Called after argument parsing. Unique directories avoid overwrites even when an invocation
# loses the main CI lock; the already-running process retains its own report path.
init_run_log() {
  mkdir -p "$STATE_DIR/ci-runs" || return 1
  RUN_DIR="$(mktemp -d "$STATE_DIR/ci-runs/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")" || return 1
  RUN_LOG="$RUN_DIR/full.log"
  printf '%s\n' "$RUN_LOG" >"$STATE_DIR/ci-local-latest-run.txt"
  if [ "$SCHEDULED" = "1" ]; then exec >"$RUN_LOG" 2>&1
  else exec > >(tee -a "$RUN_LOG") 2>&1; fi
}

# The dated file is authoritative; the compatibility copy is useful for old operator tooling.
finish_run_log() {
  [ -f "$RUN_LOG" ] && cp "$RUN_LOG" "$STATE_DIR/ci-local-last-run.log"
}
