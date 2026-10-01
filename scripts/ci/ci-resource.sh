#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | New. The resource check behind run_gate's `resource-exhausted` outcome (BACKLOG "The nightly gate runs against a saturated box"). On 2026-09-08 the run started with 0.4 GB free of 15.7 GB: head-src took 2144 s and failed, secret-scan logged `cannot allocate memory`, and every one of those reds looked exactly like a code regression. This measures the host instead of guessing from words: a gate is not started while host free memory stays below the operator's floor (OSHAL_CI_MIN_FREE_MB), and a gate that fails while the host was measured below it is classified resource-exhausted rather than FAIL. Text is deliberately NOT evidence - the unit gate's own output carries ENOMEM and `cannot allocate memory` from specs that inject those faults (catalog-load-readiness, readiness-report, ci-local-secret-scan), so a word match would turn real failures into exhaustion. There is no default floor: what counts as saturated is the operator's setting, and an unset floor is logged at the start of every run rather than assumed.
#
# Sourced by scripts/ci-local.sh after `log` is defined, and by tests/unit/ci-local-resource-exhausted.spec.ts.

. "$(dirname "${BASH_SOURCE[0]}")/ci-config.sh"

# Where host memory is read. Under Git Bash (MSYS) /proc/meminfo describes the WINDOWS host, and
# its MemFree is the host's available physical memory - the memory the `unit` gate's node workers,
# which run on Windows and not inside the Docker VM, actually draw on. On Linux MemAvailable is the
# same quantity and is preferred. Read with shell builtins: on a host so starved that fork itself
# fails, the probe must not need a process. The spec points this at a scripted host.
CI_RESOURCE_MEMINFO="${CI_RESOURCE_MEMINFO:-/proc/meminfo}"
# Mechanical bounds, each overridable by name (OSHAL_CI_RESOURCE_WAIT_SECONDS,
# OSHAL_CI_RESOURCE_SAMPLE_SECONDS). They decide how long and how often to look, never what
# counts as starved - that is OSHAL_CI_MIN_FREE_MB alone, and it has no default.
CI_RESOURCE_DEFAULT_WAIT_SECONDS=120
CI_RESOURCE_DEFAULT_SAMPLE_SECONDS=5

CI_RESOURCE_FLOOR_MB=''
CI_RESOURCE_WAIT_SECONDS="$CI_RESOURCE_DEFAULT_WAIT_SECONDS"
CI_RESOURCE_SAMPLE_SECONDS="$CI_RESOURCE_DEFAULT_SAMPLE_SECONDS"
CI_RESOURCE_FREE_MB=''
CI_RESOURCE_MIN_FREE_MB=''
CI_RESOURCE_REASON=''
CI_RESOURCE_SAMPLER_PID=''
CI_RESOURCE_MIN_FILE=''

# Read host free memory into CI_RESOURCE_FREE_MB (whole MB). Builtins only, no subshell.
# Returns 1, leaving it empty, when the file is unreadable or carries neither field - the
# caller must then claim nothing about the host.
ci_resource_read_free() {
  local key value unit avail='' free=''
  CI_RESOURCE_FREE_MB=''
  [ -r "$CI_RESOURCE_MEMINFO" ] || return 1
  while read -r key value unit; do
    case "$key" in
      MemAvailable:) avail="$value" ;;
      MemFree:) free="$value" ;;
    esac
  done < "$CI_RESOURCE_MEMINFO"
  value="${avail:-$free}"
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  CI_RESOURCE_FREE_MB=$(( value / 1024 ))
}

# Load the settings once per run and say, in the run's own log, what tonight can and cannot judge.
ci_resource_init() {
  local name now='unreadable'
  for name in OSHAL_CI_MIN_FREE_MB OSHAL_CI_RESOURCE_WAIT_SECONDS OSHAL_CI_RESOURCE_SAMPLE_SECONDS; do
    ci_config_load "$name"
    ci_config_whole_number "$name" || printf -v "$name" '%s' ''
  done
  CI_RESOURCE_FLOOR_MB="${OSHAL_CI_MIN_FREE_MB-}"
  CI_RESOURCE_WAIT_SECONDS="${OSHAL_CI_RESOURCE_WAIT_SECONDS:-$CI_RESOURCE_DEFAULT_WAIT_SECONDS}"
  CI_RESOURCE_SAMPLE_SECONDS="${OSHAL_CI_RESOURCE_SAMPLE_SECONDS:-$CI_RESOURCE_DEFAULT_SAMPLE_SECONDS}"
  [ "$CI_RESOURCE_SAMPLE_SECONDS" -ge 1 ] || CI_RESOURCE_SAMPLE_SECONDS=1
  ci_resource_read_free && now="${CI_RESOURCE_FREE_MB}MB"
  if [ -z "$CI_RESOURCE_FLOOR_MB" ]; then
    log "resource-check: NOT CONFIGURED - OSHAL_CI_MIN_FREE_MB is unset, so no gate can be classified resource-exhausted in this run (host free now $now)"
  else
    log "resource-check: floor ${CI_RESOURCE_FLOOR_MB}MB free, wait up to ${CI_RESOURCE_WAIT_SECONDS}s, sample every ${CI_RESOURCE_SAMPLE_SECONDS}s (host free now $now)"
  fi
}

# Admit a gate only while the host is at or above the floor. A starved host gets a bounded chance
# to recover - the previous gate's processes may still be exiting - and if it does not, the gate is
# not started: on a host this short a gate measures the host, and on 2026-09-08 a starved run took
# the Docker engine, and with it the live swarm, down with it.
# $1 = gate name. Returns 0 to run it; 1 with CI_RESOURCE_REASON set when the host stayed starved.
ci_resource_admit() {
  local waited=0
  CI_RESOURCE_REASON=''
  [ -n "$CI_RESOURCE_FLOOR_MB" ] || return 0
  while :; do
    # An unreadable probe is not evidence of starvation: run the gate and claim nothing.
    ci_resource_read_free || return 0
    [ "$CI_RESOURCE_FREE_MB" -ge "$CI_RESOURCE_FLOOR_MB" ] && break
    if [ "$waited" -ge "$CI_RESOURCE_WAIT_SECONDS" ]; then
      CI_RESOURCE_REASON="host free ${CI_RESOURCE_FREE_MB}MB stayed below the ${CI_RESOURCE_FLOOR_MB}MB floor for ${waited}s"
      return 1
    fi
    # Counted, not timed: if sleep itself cannot fork, the budget still runs out instead of spinning.
    sleep "$CI_RESOURCE_SAMPLE_SECONDS" 2>/dev/null
    waited=$(( waited + CI_RESOURCE_SAMPLE_SECONDS ))
  done
  [ "$waited" -gt 0 ] && log "resource-check: $1 admitted after ${waited}s (host free ${CI_RESOURCE_FREE_MB}MB)"
  return 0
}

# Record one sample in the lowest-free file when it is lower than what the file already holds.
# The sampler is the only writer while it runs; the final read happens after it is stopped.
ci_resource_note_sample() {
  local file="$1" lowest=''
  ci_resource_read_free || return 0
  read -r lowest < "$file" 2>/dev/null || lowest=''
  case "$lowest" in ''|*[!0-9]*) lowest="$CI_RESOURCE_FREE_MB"; printf '%s\n' "$lowest" > "$file" ;; esac
  [ "$CI_RESOURCE_FREE_MB" -lt "$lowest" ] || return 0
  printf '%s\n' "$CI_RESOURCE_FREE_MB" > "$file"
}

# Track the lowest host free memory while a gate runs: a dip DURING a gate is the 2026-09-20
# shape (0.35 GB free inside `unit`, fine before and after). The sampler is a background loop with
# no hold on the caller's output streams, and it exits by itself once this shell is gone, so a run
# killed outright cannot leave it behind.
ci_resource_watch_start() {
  CI_RESOURCE_MIN_FREE_MB=''
  [ -n "$CI_RESOURCE_FLOOR_MB" ] || return 0
  ci_resource_read_free || return 0
  CI_RESOURCE_MIN_FILE="${STATE_DIR:-${TMPDIR:-/tmp}}/ci-resource-min.$$"
  printf '%s\n' "$CI_RESOURCE_FREE_MB" > "$CI_RESOURCE_MIN_FILE" 2>/dev/null || { CI_RESOURCE_MIN_FILE=''; return 0; }
  local parent=$$ every="$CI_RESOURCE_SAMPLE_SECONDS" file="$CI_RESOURCE_MIN_FILE"
  (
    # The run is re-checked AFTER each sleep and before each sample: a reading taken once the run
    # is gone is not a reading of that run.
    while :; do
      sleep "$every" || { kill -0 "$parent" 2>/dev/null && ci_resource_note_sample "$file"; break; }
      kill -0 "$parent" 2>/dev/null || break
      ci_resource_note_sample "$file"
    done
  ) </dev/null >/dev/null 2>&1 &
  CI_RESOURCE_SAMPLER_PID=$!
}

# Stop the sampler, take a closing sample, and leave the lowest reading in CI_RESOURCE_MIN_FREE_MB.
# Safe to call when nothing is being watched (on_exit calls it unconditionally).
ci_resource_watch_stop() {
  if [ -n "$CI_RESOURCE_SAMPLER_PID" ]; then
    kill "$CI_RESOURCE_SAMPLER_PID" 2>/dev/null
    wait "$CI_RESOURCE_SAMPLER_PID" 2>/dev/null
    CI_RESOURCE_SAMPLER_PID=''
  fi
  [ -n "$CI_RESOURCE_MIN_FILE" ] || return 0
  ci_resource_note_sample "$CI_RESOURCE_MIN_FILE"
  read -r CI_RESOURCE_MIN_FREE_MB < "$CI_RESOURCE_MIN_FILE" 2>/dev/null || CI_RESOURCE_MIN_FREE_MB=''
  rm -f "$CI_RESOURCE_MIN_FILE"
  CI_RESOURCE_MIN_FILE=''
  [ -n "$CI_RESOURCE_MIN_FREE_MB" ] && log "resource-check: lowest host free during the gate ${CI_RESOURCE_MIN_FREE_MB}MB"
  return 0
}

# A gate that FAILED is resource-exhausted when the host was measured below the floor while it
# ran. Returns 0 (exhausted) with CI_RESOURCE_REASON set; 1 when it was not, or nothing was measured.
ci_resource_starved() {
  CI_RESOURCE_REASON=''
  [ -n "$CI_RESOURCE_FLOOR_MB" ] && [ -n "$CI_RESOURCE_MIN_FREE_MB" ] || return 1
  [ "$CI_RESOURCE_MIN_FREE_MB" -lt "$CI_RESOURCE_FLOOR_MB" ] || return 1
  CI_RESOURCE_REASON="host free fell to ${CI_RESOURCE_MIN_FREE_MB}MB, below the ${CI_RESOURCE_FLOOR_MB}MB floor"
  return 0
}
