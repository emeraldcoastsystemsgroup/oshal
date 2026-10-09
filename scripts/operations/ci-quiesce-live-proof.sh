#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | New. Live acceptance for the nightly gate's worker quiesce and resource check (BACKLOG "The nightly gate runs against a saturated box"). The specs prove the shipped shell over stand-ins; this proves the two boundaries they double, on the real box: --resource checks that the probe reads THIS host's available memory (against Windows' own counter), --plan asks the real engine about every running container and requires the operator's protections to hold by compose identity (db, redis, chromadb, tsdb, vault, arangodb, the api, the routing-critical bots and the trading bot are refused), and --cycle stops the named workers through the shipped functions and restores them twice - once normally and once after the process that stopped them is killed outright, restored from the state file the way the next nightly would. Every check prints PASS or FAIL; the workers are restored on any exit.
# 2 | maintainer@emeraldcoastsystemsgroup.com | The default state directory comes from scripts/ci/ci-host-path.sh (ci_state_dir), the helper ci-local.sh uses, instead of an unguarded `cygpath` that Linux lacks - so --cycle reads and writes the same ci-quiesce.state the nightly does on either host. OSHAL_CI_STATE_DIR still wins. The --resource check still compares against Windows' memory counter.
#
# Run from the checkout the scheduled task runs (C:\Projects\oshal), with Docker up:
#   bash scripts/operations/ci-quiesce-live-proof.sh                      read-only: --resource and --plan
#   bash scripts/operations/ci-quiesce-live-proof.sh --cycle [name ...]   STOPS and restores the named workers
#                                                                         (default: OSHAL_CI_QUIESCE_WORKERS)
# Exit 0 = every check passed, 1 = a check failed (the workers are restored regardless), 2 = refused.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The state directory ci-local.sh uses, so --cycle restores from the same state file a run would.
. "$REPO_DIR/scripts/ci/ci-host-path.sh"
STATE_DIR="${OSHAL_CI_STATE_DIR:-$(ci_state_dir)}"
log() { printf '[%s] %s\n' "$(date +%FT%T)" "$*"; }
if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi
. "$REPO_DIR/scripts/ci/ci-resource.sh"
. "$REPO_DIR/scripts/ci/ci-quiesce.sh"

FAILURES=0
CHECKS=0
# Record one check. $1 = what it proves, $2 = 0 for pass.
check() {
  CHECKS=$((CHECKS + 1))
  if [ "$2" = 0 ]; then log "PASS: $1"; else log "FAIL: $1"; FAILURES=$((FAILURES + 1)); fi
}

# The probe must read THIS host - the Windows memory the unit gate's node workers draw on - and not,
# say, the Docker VM. MemTotal is stable, so it identifies the host to 2%. Available memory moves
# while PowerShell itself starts, so Windows' reading is bracketed by a probe read on each side.
proof_resource() {
  local key value unit total='' before after win_total win_free low high slack
  ci_resource_init
  while read -r key value unit; do [ "$key" = MemTotal: ] && total=$(( value / 1024 )); done < "$CI_RESOURCE_MEMINFO"
  ci_resource_read_free && before="$CI_RESOURCE_FREE_MB" || { check "the probe can read $CI_RESOURCE_MEMINFO" 1; return; }
  read -r win_total win_free < <(timeout 60 powershell.exe -NoProfile -Command '$o = Get-CimInstance Win32_OperatingSystem; "{0} {1}" -f [int]($o.TotalVisibleMemorySize / 1024), [int]($o.FreePhysicalMemory / 1024)' 2>/dev/null | tr -d '\r')
  ci_resource_read_free && after="$CI_RESOURCE_FREE_MB" || after="$before"
  case "${win_total-}${win_free-}" in ''|*[!0-9]*) check "Windows reported its memory" 1; return ;; esac
  log "resource: probe MemTotal ${total}MB free ${before}MB..${after}MB; Windows total ${win_total}MB free ${win_free}MB"
  [ $(( (total > win_total ? total - win_total : win_total - total) * 50 )) -le "$win_total" ]
  check "the probe reads this host (MemTotal ${total}MB against Windows ${win_total}MB)" $?
  low=$(( before < after ? before : after )); high=$(( before > after ? before : after ))
  slack=$(( win_free / 4 > 500 ? win_free / 4 : 500 ))
  [ "$win_free" -ge $(( low - slack )) ] && [ "$win_free" -le $(( high + slack )) ]
  check "its free memory agrees with Windows (${win_free}MB within ${low}..${high}MB +/- ${slack}MB)" $?
}

# Ask the real engine about every running container, then hold the protections by compose identity:
# the selection is computed from labels and AGENT_ID, the expectation from the compose service name.
proof_plan() {
  local names=() name service eligible refused=0
  mapfile -t names < <(timeout 60 docker ps --format '{{.Names}}' 2>/dev/null)
  [ "${#names[@]}" -gt 0 ] || { check "docker lists running containers" 1; return; }
  ci_quiesce_settings
  ci_quiesce_load_critical || { check "the routing-critical list is readable" 1; return; }
  for name in "${names[@]}"; do
    name="${name%$'\r'}"
    service=$(MSYS_NO_PATHCONV=1 timeout 30 docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$name" 2>/dev/null)
    if ci_quiesce_eligible "$name"; then eligible=1; log "plan: $name ($service) WOULD STOP - worker, agent ${CI_QUIESCE_AGENT:-none}"
    else eligible=0; refused=$((refused + 1)); log "plan: $name ($service) REFUSED - $CI_QUIESCE_REFUSAL"; fi
    case "$service" in
      oshal-db|oshal-redis|oshal-chromadb|oshal-tsdb|oshal-vault|oshal-arangodb|oshal-api|trading-bot)
        check "$name ($service) is never stopped" "$eligible" ;;
    esac
    case " ${CI_QUIESCE_CRITICAL[*]} " in
      *" ${CI_QUIESCE_AGENT:-none} "*) check "$name is routing-critical and never stopped" "$eligible" ;;
    esac
  done
  log "plan: ${#names[@]} running, $refused refused"
}

# State of one container on the real engine.
container_status() { MSYS_NO_PATHCONV=1 timeout 30 docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null; }

# The silence the quiesce made, as Alertmanager reports it now (state and end), or nothing.
silence_state() {
  case "${OSHAL_CI_QUIESCE_ALERTMANAGER_URL:-none}" in none) return 1 ;; esac
  local body state ends
  body=$(timeout 30 curl -sS -f "${OSHAL_CI_QUIESCE_ALERTMANAGER_URL%/}/api/v2/silence/$1" 2>/dev/null) || return 1
  state=$(printf '%s' "$body" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p')
  ends=$(printf '%s' "$body" | sed -n 's/.*"endsAt":"\([^"]*\)".*/\1/p')
  printf '%s %s\n' "$state" "$ends"
}

# Every named container is in the given state.
all_in_state() {
  local want="$1" name; shift
  for name in "$@"; do [ "$(container_status "$name")" = "$want" ] || return 1; done
}

# A normal cycle: stop through the shipped begin, restore through the shipped resume.
proof_cycle_clean() {
  ci_quiesce_begin
  ci_quiesce_read_state; local silence="$CI_QUIESCE_SILENCE"
  all_in_state exited "$@"; check "the named workers are stopped (${*})" $?
  grep -q "^container=$1$" "$CI_QUIESCE_STATE" 2>/dev/null; check "the state file names them before anything is restored" $?
  if [ "$silence" != none ]; then
    [ "$(silence_state "$silence" | cut -d' ' -f1)" = active ]; check "Alertmanager holds silence $silence active while they are down" $?
  fi
  ci_quiesce_resume; check "the shipped resume restores them" $?
  all_in_state running "$@"; check "the named workers are running again" $?
  [ ! -f "$CI_QUIESCE_STATE" ]; check "the state file is gone after a complete restore" $?
  [ "$silence" = none ] || log "silence after restore: $(silence_state "$silence")"
}

# A run killed outright between the stop and the restore: no trap runs, so only the state file
# knows - and the next run's leftover recovery must restore from it and say it did.
proof_cycle_killed() {
  ( ci_quiesce_begin >/dev/null 2>&1; exec sleep 600 ) &
  local pid=$! i rc
  for i in $(seq 1 120); do all_in_state exited "$@" && [ -f "$CI_QUIESCE_STATE" ] && break; sleep 2; done
  kill -KILL "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  all_in_state exited "$@" && [ -f "$CI_QUIESCE_STATE" ]; check "a killed run leaves the workers stopped and the state file behind" $?
  ci_quiesce_recover_leftover; rc=$?
  [ "$rc" = 2 ]; check "the next run's leftover recovery restores them and reports it (returned $rc, want 2)" $?
  all_in_state running "$@"; check "the named workers are running again after the leftover recovery" $?
  [ ! -f "$CI_QUIESCE_STATE" ]; check "no state file is left" $?
}

# The real stop/restore cycle on the named workers, refused while a nightly could be affected.
proof_cycle() {
  local names=("$@") list
  ci_quiesce_settings
  if [ "${#names[@]}" -eq 0 ]; then list="${OSHAL_CI_QUIESCE_WORKERS-}"; read -r -a names <<< "${list//,/ }"; fi
  [ "${#names[@]}" -gt 0 ] || { log "REFUSED: name the workers to cycle, or set OSHAL_CI_QUIESCE_WORKERS"; return 2; }
  [ -d "$STATE_DIR/ci-local.lock" ] && { log "REFUSED: a ci-local run holds $STATE_DIR/ci-local.lock"; return 2; }
  [ -f "$STATE_DIR/ci-quiesce.state" ] && { log "REFUSED: $STATE_DIR/ci-quiesce.state is unresolved; run bash scripts/ci/ci-quiesce.sh --resume first"; return 2; }
  ci_quiesce_load_critical || { log "REFUSED: the routing-critical list is unreadable"; return 2; }
  local name
  for name in "${names[@]}"; do
    ci_quiesce_eligible "$name" || { log "REFUSED: $name may not be stopped ($CI_QUIESCE_REFUSAL)"; return 2; }
  done
  OSHAL_CI_QUIESCE_WORKERS="${names[*]}"
  # The proof's silence never outlives half an hour, whatever happens to this shell.
  CI_LOCK_STALE_SECONDS="${OSHAL_CI_PROOF_SILENCE_SECONDS:-1800}"
  trap 'ci_quiesce_resume >/dev/null 2>&1' EXIT
  trap 'ci_quiesce_resume; exit 130' INT TERM
  proof_cycle_clean "${names[@]}"
  proof_cycle_killed "${names[@]}"
}

main() {
  local mode="${1-}"
  case "$mode" in
    --cycle) shift; proof_cycle "$@" || return $? ;;
    --resource) proof_resource ;;
    --plan) proof_plan ;;
    '') proof_resource; proof_plan ;;
    *) printf 'usage: %s [--resource | --plan | --cycle [name ...]]\n' "$0" >&2; return 2 ;;
  esac
  log "LIVE PROOF: $((CHECKS - FAILURES)) of $CHECKS checks passed"
  [ "$FAILURES" -eq 0 ]
}

main "$@"
exit $?
