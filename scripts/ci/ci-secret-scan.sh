#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Count the paths gitleaks skips and refuse PASS on a partial scan. `gitleaks detect` exits 0 when it cannot read part of the tree (2026-09-10: 5 of 5077 exported files logged a cannot-allocate-memory read failure and secret-scan still PASSED), so the exit code alone is not evidence the tree was scanned. The scanner's stderr names every unread path; this keeps that stderr, counts it, and writes the count into the gate's one verdict line.

# Sourced by scripts/ci-local.sh (and by tests/unit/ci-local-secret-scan.spec.ts, which runs the
# production gate body in Git Bash with a stand-in scanner that replays the real wording).

# Every wording the installed scanner uses when it passes over a path instead of scanning it.
# Reproduced in zricethezav/gitleaks v8.30.1 on 2026-09-14: `WRN skipping file: permission denied
# path=...` and `WRN skipping directory error="permission denied" path=...`, both with exit 0.
# `could not read file` + `cannot allocate memory` is the mid-read failure the 2026-09-10 nightly
# recorded. Matching is case-insensitive on the color-stripped stderr.
GITLEAKS_UNREAD_PATTERN='could not read file|skipping file|skipping directory|permission denied|cannot allocate memory'

ci_secret_say() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else printf '%s\n' "$*"; fi
}

# count_gitleaks_unread <scanner-stderr-file>: number of stderr lines that report a path the scanner
# did not read. ANSI color is stripped first - the image writes it even without a tty.
count_gitleaks_unread() {
  local n
  n=$(sed -e 's/\x1b\[[0-9;]*m//g' "$1" 2>/dev/null | grep -ciE "$GITLEAKS_UNREAD_PATTERN") || true
  printf '%s\n' "${n:-0}"
}

# run_secret_scan <export-dir> <scanner-command...>: run the scanner over the export, replay its
# stderr into the run log, and write ONE verdict line carrying the scanner's exit code and the
# unread-path count. Returns non-zero on findings, on a scanner error, and on any unread path -
# a partial scan is not a clean scan.
run_secret_scan() {
  local exp="$1"; shift
  local errfile rc=0 unread files
  errfile="$(mktemp)" || return 1
  "$@" 2>"$errfile" || rc=$?
  cat "$errfile" >&2
  unread=$(count_gitleaks_unread "$errfile")
  files=$(find "$exp" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  rm -f "$errfile"
  if [ "$rc" -ne 0 ]; then
    ci_secret_say "secret-scan: FAIL scanner rc=$rc unread=$unread of $files exported files (findings or scanner error above)"
    return 1
  fi
  if [ "$unread" -gt 0 ]; then
    ci_secret_say "secret-scan: FAIL unread=$unread of $files exported files (scanner rc=0) - gitleaks skipped paths it could not read; a partial scan is not a clean scan"
    return 1
  fi
  ci_secret_say "secret-scan: PASS unread=0 of $files exported files (scanner rc=0)"
}
