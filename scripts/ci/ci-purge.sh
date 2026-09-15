#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | Timeout-bounded, fail-loud purge for the nightly's disposable exports. The 2026-09-09 23:30 run sat nine hours inside `rm -rf` of the previous night's ci-src export (a full node_modules: 16 CPU-seconds in total, no file lock, no progress across a 20 s sample), held ci-local.lock all night and wrote no outcome line; robocopy mirror-from-empty cleared the same tree in 39 s. Every purge now runs under a watchdog and ends in exactly one `purge: OK|FAIL|REFUSED` line, and on Windows it is robocopy-then-rm rather than MSYS rm over a deep tree.
# 2 | maintainer@emeraldcoastsystemsgroup.com | Abandon the NATIVE delete, not just its bash wrapper. purge_tree runs purge_tree_delete in a background subshell whose real work is robocopy.exe / rm.exe under `timeout`; the watchdog's `kill` reached only the wrapper, so on a 26,180-file export with a 2 s limit purge_tree printed `purge: FAIL ... the tree is still present` and returned while Robocopy.exe was still in tasklist and the tree was still shrinking (24,121 files at return, 23,058 eight seconds later) - an unsupervised delete that can race a manual cleanup or the next run's purge of the same well-known path, with no pid recorded anywhere. The watchdog now kills the whole process tree (taskkill /T on the wrapper's Windows pid under Git Bash, descendants-then-parent elsewhere, plain kill as the last resort) and the outcome line names what it killed.
# 3 | maintainer@emeraldcoastsystemsgroup.com | Stop reporting an inability to look as a checked absence. The abandon printed `pid <pid> (no descendant processes found)` for two different facts: an enumeration that ran and found nothing, and an enumeration that could not run at all. On this box it can never run - Git Bash's ps rejects `-eo` outright - so every Windows abandon that fell past taskkill claimed a checked absence it had not earned, and a taskkill refused against a still-live delete was reported as a successful kill. The enumeration now carries three outcomes and the abandon a distinct UNCHECKED exit that the FAIL line names, in the shape scripts/ci/check-alert-residue.sh and scripts/ci/check-spec-database-default.sh already use. The fail-closed contract is unchanged: a timed-out purge was and remains FAIL.

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

# The delete primitive. purge_tree runs it in the background so the watchdog can abandon it (see
# purge_tree_abandon: the abandon has to end these native children, not the bash wrapper), and
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

# The Windows pid behind an MSYS pid. `taskkill` speaks Windows pids and bash's `$!` is an MSYS pid;
# they are different numbers. Absent outside Git Bash/MSYS, which is what the POSIX path below is for.
purge_tree_winpid() {
  local pid="$1"
  [ -r "/proc/$pid/winpid" ] || return 1
  tr -d '\r\n' < "/proc/$pid/winpid"
}

# One snapshot of the process table, as "<pid> <ppid>" rows on stdout. It is its own function for
# two reasons: it is the single step of the enumeration below that can fail to answer at all, and a
# test can replace it with a fixture table to drive the walk on a box whose ps cannot produce one.
#   0  stdout is a usable table
#   2  no table could be produced, so nothing about descendants is knowable from it
# Git Bash's ps does not implement POSIX `-eo`: it answers `ps: unknown option -- o` on stderr,
# exits 1 and prints nothing. That is the case this return code exists to keep separate from "the
# table came back and there were no children in it" - on Windows the taskkill branch does the work.
purge_tree_process_table() {
  local table status
  table="$(ps -eo pid=,ppid= 2>/dev/null)"
  status=$?
  [ "$status" -ne 0 ] && return 2
  # A table carrying no pid/ppid row is a refusal too: a running machine always has processes. The
  # status consulted here is awk's - the last stage, and the one being asked - never printf's.
  printf '%s\n' "$table" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { rows++ } END { exit rows ? 0 : 1 }' || return 2
  printf '%s\n' "$table"
}

# Every still-running descendant of <pid>, deepest first, walked over one snapshot of the table.
# The answer is published through PURGE_DESCENDANTS rather than stdout precisely so that "there are
# none" and "the question could not be asked" are not both the empty string a caller reads back.
#   0, PURGE_DESCENDANTS non-empty  enumerated, and these are the descendants
#   0, PURGE_DESCENDANTS empty      enumerated, and there are genuinely none
#   2                               the table could not be read, so nothing was determined
PURGE_DESCENDANTS=''
purge_tree_descendants() {
  local pid="$1" table
  PURGE_DESCENDANTS=''
  table="$(purge_tree_process_table)" || return 2
  PURGE_DESCENDANTS="$(printf '%s\n' "$table" | awk -v root="$pid" '
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { seen[++n] = $1; parent[$1] = $2 }
    END {
      depth[root] = 0
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= n; i++) {
          p = seen[i]
          if (p == root || (p in depth) || !(parent[p] in depth)) continue
          depth[p] = depth[parent[p]] + 1
          if (depth[p] > deepest) deepest = depth[p]
          changed = 1
        }
      }
      for (d = deepest; d >= 1; d--)
        for (i = 1; i <= n; i++)
          if (seen[i] != root && (seen[i] in depth) && depth[seen[i]] == d) print seen[i]
    }')"
  return 0
}

# Abandon a running delete and say which of three things happened, because they are three different
# facts and only two of them are evidence:
#   ended      the native process tree was ended, and/or N enumerated descendants were killed
#   none       the descendants were enumerated and there genuinely were none left to end
#   UNCHECKED  it could not be determined whether a native delete is still running
# The third is why this function has this shape. It used to print "pid <pid> (no descendant
# processes found)" for both of the last two, so on this box - where `ps -eo` cannot run at all -
# an inability to look read as a checked absence, and a taskkill refused against a still-live
# delete read as a successful kill. The orphaned native delete the watchdog exists to prevent could
# then recur unreported. A check that cannot tell "looked and found nothing" from "could not look"
# is worse than no check, because it manufactures confidence.
# Returns 0 when the outcome is determined, 2 when it is UNCHECKED. Either way the caller still
# fails the purge: this changes what is reported, never whether the watchdog is fail-closed.
purge_tree_abandon() {
  local pid="$1" winpid='' killed='' unknown='' count=0
  if command -v taskkill >/dev/null 2>&1 && winpid="$(purge_tree_winpid "$pid")" && [ -n "$winpid" ]; then
    if taskkill //F //T //PID "$winpid" >/dev/null 2>&1; then
      killed="the delete process tree under windows pid $winpid (taskkill /T)"
    elif kill -0 "$pid" 2>/dev/null; then
      # Refused while the delete was still running. On Windows this is the only branch that reaches
      # the native children, so it is a failure to abandon - not something to print as a kill.
      unknown="taskkill /T was refused for live windows pid $winpid, so the native delete children were never reached"
    fi
  fi
  if purge_tree_descendants "$pid"; then
    if [ -n "$PURGE_DESCENDANTS" ]; then
      count="$(printf '%s\n' "$PURGE_DESCENDANTS" | wc -l | tr -d ' ')"
      # shellcheck disable=SC2086 # deliberate word split: one kill for the whole descendant list
      kill -KILL $PURGE_DESCENDANTS 2>/dev/null
      killed="${killed:+$killed and }$count descendant process(es) of pid $pid"
    elif [ -z "$killed" ]; then
      killed="pid $pid (enumerated its descendants and found none)"
    fi
  elif [ -z "$killed" ]; then
    unknown="${unknown:+$unknown; }the descendants of pid $pid could not be enumerated (this ps does not implement -eo), so whether a native delete is still running is unknown"
  fi
  kill -KILL "$pid" 2>/dev/null
  if [ -n "$unknown" ]; then
    printf 'UNCHECKED - %s' "${killed:+$killed, but }$unknown"
    return 2
  fi
  printf '%s' "$killed"
  return 0
}

# purge_tree <path> [limit-seconds]: remove a disposable export tree, or say loudly that it could
# not. Returns 0 only when the path is gone. Never blocks past the limit: a delete that is still
# running when the limit passes is abandoned and reported as FAIL with the tree left in place.
purge_tree() {
  local target="${1-}" limit="${2:-$CI_PURGE_TIMEOUT_SECONDS}" t0=$SECONDS pid rc=0 killed='' abandon_rc=0
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
      # A plain assignment from a command substitution, so the status read next is the function's
      # own and not some later stage of a pipeline.
      killed="$(purge_tree_abandon "$pid")"
      abandon_rc=$?
      wait "$pid" 2>/dev/null
      if [ "$abandon_rc" -ne 0 ]; then
        ci_purge_say "purge: FAIL $target (timeout after ${limit}s; abandon $killed; the tree is still present AND a native delete may still be running - look for robocopy.exe / rm.exe against this path before the next run)"
      else
        ci_purge_say "purge: FAIL $target (timeout after ${limit}s; killed $killed; the tree is still present - remove it by hand before the next run)"
      fi
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
