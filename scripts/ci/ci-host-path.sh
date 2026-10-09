#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | New. The local CI runner was written for Git Bash on Windows and called `cygpath` unguarded in three places: the state directory (scripts/ci-local.sh), the gitleaks volume mount (gitleaks_container_scan) and the standalone quiesce restore (scripts/ci/ci-quiesce.sh, and the same line in scripts/operations/ci-quiesce-live-proof.sh). Linux has no cygpath, so on the Spark the state directory became `/oshal`, its mkdir was refused, the lock mkdir under it failed silently and the run exited 2 saying another run was in progress - every night since the host job was installed (logs/ci-local/2026-10-06.log and 2026-10-07.log). These helpers keep the Windows translation exactly where cygpath exists and use the path as it is everywhere else.
# -----------------------------------------------------------------------------
#
# Sourced by scripts/ci-local.sh, by scripts/ci/ci-quiesce.sh when it runs on its own, and by
# scripts/operations/ci-quiesce-live-proof.sh. Guarded by tests/unit/ci-local-host-path.spec.ts.

# The form of a local path that the Docker engine and other host-native tools accept. Git Bash
# hands out MSYS paths (/c/Users/...), which Docker Desktop cannot mount, so it gets the mixed
# Windows form (C:/Users/...); a POSIX host's paths are already what its engine expects.
# $1 = the path. Prints it in the host's form, without a trailing newline.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# Where the runner keeps its lock, logs, exports and quiesce state: %LOCALAPPDATA%\oshal under Git
# Bash (the directory every Windows-era tool and doc names). Elsewhere LOCALAPPDATA still wins when
# it is set - the Spark's host units set it to ~/.local/state so its jobs share one directory - and
# otherwise the XDG state home. Prints the directory, without a trailing newline.
ci_state_dir() {
  if command -v cygpath >/dev/null 2>&1; then
    printf '%s/oshal' "$(cygpath -u "${LOCALAPPDATA:-$HOME/AppData/Local}")"
  else
    printf '%s/oshal' "${LOCALAPPDATA:-${XDG_STATE_HOME:-$HOME/.local/state}}"
  fi
}

# Create the state directory and prove it is writable, or say why not on stderr. The runner's lock
# lives inside it, and a lock that cannot be created must never be reported as a run in progress.
# $1 = the directory. Returns 0 when it is usable, 1 otherwise (the caller decides the exit code).
ci_state_dir_ready() {
  local err
  if ! err="$(mkdir -p "$1" 2>&1)"; then
    printf 'ci-local: cannot create the state directory %s: %s\n' "$1" "${err:-mkdir failed}" >&2
  elif [ ! -w "$1" ]; then
    printf 'ci-local: the state directory %s is not writable\n' "$1" >&2
  else
    return 0
  fi
  printf 'ci-local: set LOCALAPPDATA or XDG_STATE_HOME to a writable directory; nothing ran.\n' >&2
  return 1
}
