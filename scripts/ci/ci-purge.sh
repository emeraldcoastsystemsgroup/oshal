#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Timeout-bounded, fail-loud purge for the nightly's disposable exports. The 2026-09-09 23:30 run sat nine hours inside `rm -rf` of the previous night's ci-src export (a full node_modules: 16 CPU-seconds in total, no file lock, no progress across a 20 s sample), held ci-local.lock all night and wrote no outcome line; robocopy mirror-from-empty cleared the same tree in 39 s. Every purge now runs under a watchdog and ends in exactly one `purge: OK|FAIL|REFUSED` line, and on Windows it is robocopy-then-rm rather than MSYS rm over a deep tree.

# Sourced by scripts/ci-local.sh (and by tests/unit/ci-local-purge.spec.ts, which runs it in Git
# Bash against a synthetic tree). Needs only coreutils, plus robocopy + cygpath on Windows.
# Writes through the caller's `log` when one is defined so the outcome line reaches the summary log.

# Seconds a single purge may take before the watchdog abandons it. The measured Windows purge of a
# node_modules export is well under a minute; ten minutes is the "something is wrong" threshold.
CI_PURGE_TIMEOUT_SECONDS="${CI_PURGE_TIMEOUT_SECONDS:-600}"

ci_purge_say() {
  if declare -F log >/dev/null 2>&1; then log "$@"; else printf '%s\n' "$*"; fi
}

# A mirror-from-empty is a wipe, so the target has to look like a disposable export path: absolute,
# at least three components deep, and never the filesystem root or the operator's home.
purge_tree_refused() {
  local target="$1"
  case "$target" in
    ''|/|//|/?|/?/) return 0 ;;
    "${HOME:-/nonexistent}"|"${HOME:-/nonexistent}/") return 0 ;;
    /*/*/*) return 1 ;;
    *) return 0 ;;
  esac
}

# The delete primitive. purge_tree runs it in the background so the watchdog can abandon it, and
# tests override it to prove the timeout path. Windows: robocopy /MIR from an empty directory
# removes the tree's contents natively (39 s for a node_modules export on 2026-09-09, where MSYS rm
# on the same tree had made no progress in nine hours); rm -rf then drops the emptied shell and
# anything robocopy could not delete (read-only files). Elsewhere: rm -rf. Each native call is
# itself bounded so a hung primitive cannot outlive the watchdog by much.
purge_tree_delete() {
  local target="$1" limit="$2" empty
  if command -v robocopy >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    empty="$(mktemp -d)" || return 1
    MSYS_NO_PATHCONV=1 timeout "$limit" robocopy "$(cygpath -w "$empty")" "$(cygpath -w "$target")" \
      /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 /W:0 >/dev/null 2>&1
    rmdir "$empty" 2>/dev/null
  fi
  timeout "$limit" rm -rf -- "$target"
}

# purge_tree <path> [limit-seconds]: remove a disposable export tree, or say loudly that it could
# not. Returns 0 only when the path is gone. Never blocks past the limit: a delete that is still
# running when the limit passes is abandoned and reported as FAIL with the tree left in place.
purge_tree() {
  local target="${1-}" limit="${2:-$CI_PURGE_TIMEOUT_SECONDS}" t0=$SECONDS pid rc=0
  # The guard below reads POSIX form; a Windows-form path (C:/...) is normalized, not refused.
  if [ -n "$target" ] && command -v cygpath >/dev/null 2>&1; then target="$(cygpath -u "$target")"; fi
  if purge_tree_refused "$target"; then
    ci_purge_say "purge: REFUSED '$target' (not a disposable export path)"; return 1
  fi
  if [ ! -e "$target" ]; then ci_purge_say "purge: OK $target (already absent)"; return 0; fi
  purge_tree_delete "$target" "$limit" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - t0)) -ge "$limit" ]; then
      kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
      ci_purge_say "purge: FAIL $target (timeout after ${limit}s; the tree is still present - remove it by hand before the next run)"
      return 1
    fi
    sleep 1
  done
  wait "$pid" || rc=$?
  if [ -e "$target" ]; then
    ci_purge_say "purge: FAIL $target (delete rc=$rc after $((SECONDS - t0))s; the tree is still present)"
    return 1
  fi
  ci_purge_say "purge: OK $target ($((SECONDS - t0))s)"
}
