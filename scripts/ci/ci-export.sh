#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Timeout-bounded, fail-loud export for ci-local exports. git archive | tar -x has no timeout of its own; a hang there holds ci-local.lock indefinitely without writing an outcome line. export_tree bounds the operation under a watchdog, logs a named export: OK|FAIL line through log (or stdout), and cleans up any hung export processes on timeout so the run can continue to its outcome line.
# -----------------------------------------------------------------------------

# Sourced by scripts/ci-local.sh (and by tests/unit/ci-local-export.spec.ts).
# Default timeout for git archive | tar -x export. Usually completes in under 15 seconds.
CI_EXPORT_TIMEOUT_SECONDS="${CI_EXPORT_TIMEOUT_SECONDS:-300}"

ci_export_say() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else printf '%s\n' "$*"; fi
}

# The export primitive. Tests can override this function to simulate a hung export and prove the watchdog.
export_tree_archive() {
  local repo="$1" sha="$2" dest="$3"
  (cd "$repo" && git archive "$sha" | tar -x -C "$dest")
}

# export_tree <repo_dir> <source_sha> <dest_dir> [limit-seconds]
# Exports the git commit tree to dest_dir within limit seconds.
# Returns 0 on success, 1 on failure or timeout.
export_tree() {
  local repo="${1-}" sha="${2-}" dest="${3-}" limit="${4:-$CI_EXPORT_TIMEOUT_SECONDS}"
  local t0=$SECONDS pid rc=0

  if [ -z "$repo" ] || [ -z "$sha" ] || [ -z "$dest" ]; then
    ci_export_say "export: FAIL (missing arguments: repo='$repo' sha='$sha' dest='$dest')"
    return 1
  fi
  if [ ! -d "$repo" ]; then
    ci_export_say "export: FAIL $dest (repo directory does not exist: '$repo')"
    return 1
  fi
  mkdir -p "$dest" 2>/dev/null || {
    ci_export_say "export: FAIL $dest (cannot create destination directory)"
    return 1
  }

  export_tree_archive "$repo" "$sha" "$dest" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - t0)) -ge "$limit" ]; then
      kill -KILL "$pid" 2>/dev/null || true
      if command -v taskkill >/dev/null 2>&1; then
        local winpid
        winpid="$(tr -d '\r\n' < "/proc/$pid/winpid" 2>/dev/null || true)"
        [ -n "$winpid" ] && taskkill //F //T //PID "$winpid" >/dev/null 2>&1 || true
      fi
      wait "$pid" 2>/dev/null || true
      ci_export_say "export: FAIL $dest (timeout after ${limit}s; git archive | tar exceeded limit)"
      return 1
    fi
    sleep 1
  done
  wait "$pid" || rc=$?
  if [ "$rc" -ne 0 ]; then
    ci_export_say "export: FAIL $dest (git archive | tar exited rc=$rc after $((SECONDS - t0))s)"
    return 1
  fi
  ci_export_say "export: OK $dest ($((SECONDS - t0))s)"
  return 0
}
