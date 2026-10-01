#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ | AUTHOR | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com | New. Worker quiesce for the nightly gate (operator decision 2026-09-21, BACKLOG "The nightly gate runs against a saturated box"): stop the workers the operator NAMED (OSHAL_CI_QUIESCE_WORKERS) for the run and always restore them. Nothing is stopped unless it is named, carries the `oshal.tier=worker` label (so the infrastructure tier, the api and the monitoring overlay can never qualify), is not a routing-critical agent in scripts/routability-critical-bots.txt (Jarvis's brain, the fallback owner, trading, finance and communications - the trading bot among them, and the bots whose absence makes the stack watchdog bounce the api), and is running. The state file is written BEFORE the first stop, so a run killed mid-way still names everything it may have stopped; every run that takes the lock restores a leftover first, on_exit restores on failure and interruption, and `--resume` restores by hand. A stopped worker fires SwarmContainerDown (intake: auto - one incident with unattended RCA analysis each, and with SELF_HEAL_AUTO_APPLY a restart of the container mid-run), so the run silences exactly that alert for exactly those containers and refuses to stop anything it cannot silence. Restore is `docker start` of exactly what was stopped, batched with oshal-up.sh's knobs: oshal-up.sh itself force-recreates the api and starts every compose service, which is neither "keep the api up" nor "resume what it paused".
# 2 | maintainer@emeraldcoastsystemsgroup.com | --plan splits its list with `read -r -a`, exactly as the run's selection does. It used an unquoted expansion, so `--plan '*'` globbed against the working directory and reported any file named like an eligible container as WOULD STOP, while the run refused `*` as a name. A plan must never disagree with the run it previews.
#
# Sourced by scripts/ci-local.sh after `log` is defined. Also runnable on its own:
#   bash scripts/ci/ci-quiesce.sh --plan [name ...]   which configured (or given) names WOULD be stopped,
#                                                      and why the rest would not. docker inspect only.
#   bash scripts/ci/ci-quiesce.sh --resume [--force]  start the workers an earlier run stopped and never
#                                                      restored. Refuses while a run holds the lock.

. "$(dirname "${BASH_SOURCE[0]}")/ci-config.sh"

# The alert a stopped worker trips (ops/monitoring/alert-rules.yml, critical, intake: auto).
CI_QUIESCE_ALERTNAME='SwarmContainerDown'
# Container names as compose writes them here. No dots: the name also becomes an Alertmanager regex.
CI_QUIESCE_NAME_RE='^[A-Za-z0-9][A-Za-z0-9_-]*$'
# Status, tier label and environment of one container in a single inspect call.
CI_QUIESCE_INSPECT_FORMAT='{{.State.Status}}{{"\n"}}{{index .Config.Labels "oshal.tier"}}{{"\n"}}{{range .Config.Env}}{{println .}}{{end}}'
# How long the silence outlives the restore, so a restarted bot is scraped up again before the
# alert that fired silently all night can notify. Overridable: OSHAL_CI_QUIESCE_RESUME_GRACE_SECONDS.
CI_QUIESCE_DEFAULT_GRACE_SECONDS=600

# Load the named settings (environment first, then .env) and derive the run's quiesce constants.
ci_quiesce_settings() {
  local name
  for name in OSHAL_CI_QUIESCE_WORKERS OSHAL_CI_QUIESCE_ALERTMANAGER_URL; do ci_config_load "$name"; done
  for name in OSHAL_CI_QUIESCE_RESUME_GRACE_SECONDS OSHAL_UP_BATCH_SIZE OSHAL_UP_BATCH_SETTLE; do
    ci_config_load "$name"
    ci_config_whole_number "$name" || printf -v "$name" '%s' ''
  done
  CI_QUIESCE_STATE="${STATE_DIR:-.}/ci-quiesce.state"
  CI_QUIESCE_GRACE_SECONDS="${OSHAL_CI_QUIESCE_RESUME_GRACE_SECONDS:-$CI_QUIESCE_DEFAULT_GRACE_SECONDS}"
  # oshal-up.sh's batching knobs and defaults: the same cold-start spike, the same engine.
  CI_QUIESCE_BATCH_SIZE="${OSHAL_UP_BATCH_SIZE:-5}"
  CI_QUIESCE_BATCH_SETTLE="${OSHAL_UP_BATCH_SETTLE:-18}"
  # The silence must outlive the longest legitimate run (ci-local.sh's stale-lock window) and no more.
  CI_QUIESCE_SILENCE_SECONDS="${CI_LOCK_STALE_SECONDS:-}"
}

# The routing-critical agent ids, read into CI_QUIESCE_CRITICAL. Returns 1 when the list is
# missing or yields nothing: then no protection can be checked, and nothing may be stopped.
ci_quiesce_load_critical() {
  local list="${CI_QUIESCE_CRITICAL_LIST:-${REPO_DIR:-.}/scripts/routability-critical-bots.txt}" id rest
  CI_QUIESCE_CRITICAL=()
  [ -r "$list" ] || return 1
  while IFS='|' read -r id rest; do
    id="${id//[[:space:]]/}"
    case "$id" in ''|\#*) continue ;; esac
    CI_QUIESCE_CRITICAL+=("$id")
  done < "$list"
  [ "${#CI_QUIESCE_CRITICAL[@]}" -gt 0 ]
}

# Read one container's status, tier label and AGENT_ID into CI_QUIESCE_STATUS/_TIER/_AGENT.
# Returns 1 when docker does not know the name.
ci_quiesce_inspect() {
  local out line n=0
  CI_QUIESCE_STATUS='' CI_QUIESCE_TIER='' CI_QUIESCE_AGENT=''
  out=$(MSYS_NO_PATHCONV=1 timeout 30 docker inspect --format "$CI_QUIESCE_INSPECT_FORMAT" "$1" 2>/dev/null) || return 1
  while IFS= read -r line; do
    line="${line%$'\r'}"
    n=$((n + 1))
    case "$n" in
      1) CI_QUIESCE_STATUS="$line" ;;
      2) [ "$line" = '<no value>' ] || CI_QUIESCE_TIER="$line" ;;
      *) case "$line" in AGENT_ID=*) CI_QUIESCE_AGENT="${line#AGENT_ID=}" ;; esac ;;
    esac
  done <<< "$out"
  [ -n "$CI_QUIESCE_STATUS" ]
}

# May this configured name be stopped? Every refusal carries its reason in CI_QUIESCE_REFUSAL.
ci_quiesce_eligible() {
  local name="$1" id
  CI_QUIESCE_REFUSAL='' CI_QUIESCE_STATUS='' CI_QUIESCE_TIER='' CI_QUIESCE_AGENT=''
  if ! [[ "$name" =~ $CI_QUIESCE_NAME_RE ]]; then CI_QUIESCE_REFUSAL='not a supported container name'; return 1; fi
  if ! ci_quiesce_inspect "$name"; then CI_QUIESCE_REFUSAL='no such container'; return 1; fi
  if [ "$CI_QUIESCE_TIER" != worker ]; then
    CI_QUIESCE_REFUSAL="tier '${CI_QUIESCE_TIER:-none}' is not worker; the infrastructure tier, the api and the monitoring overlay are never stopped"
    return 1
  fi
  for id in "${CI_QUIESCE_CRITICAL[@]}"; do
    if [ -n "$CI_QUIESCE_AGENT" ] && [ "$CI_QUIESCE_AGENT" = "$id" ]; then
      CI_QUIESCE_REFUSAL="routing-critical agent $id in scripts/routability-critical-bots.txt"
      return 1
    fi
  done
  if [ "$CI_QUIESCE_STATUS" != running ]; then
    CI_QUIESCE_REFUSAL="status $CI_QUIESCE_STATUS, not running; the restore never starts what was not running"
    return 1
  fi
  return 0
}

# ISO-8601 UTC timestamp $1 seconds from now.
ci_quiesce_iso_in() { date -u -d "@$(( $(date +%s) + $1 ))" +%Y-%m-%dT%H:%M:%SZ; }

# Never let a URL's userinfo reach the log through a curl message.
ci_quiesce_redact() { printf '%s' "$1" | sed -E 's#//[^/@[:space:]]*@#//#g' | head -c 200; }

# One silence body: alertname exact, container an anchored alternation of the (validated) names.
# $1 = existing id or '', $2 startsAt, $3 endsAt, rest = names.
ci_quiesce_silence_json() {
  local id="$1" starts="$2" ends="$3" IFS='|'
  shift 3
  printf '{%s"matchers":[{"name":"alertname","value":"%s","isRegex":false,"isEqual":true},{"name":"container","value":"%s","isRegex":true,"isEqual":true}],"startsAt":"%s","endsAt":"%s","createdBy":"scripts/ci-local.sh","comment":"nightly gate quiesce: workers stopped for the run by scripts/ci-local.sh"}' \
    "${id:+\"id\":\"$id\",}" "$CI_QUIESCE_ALERTNAME" "$*" "$starts" "$ends"
}

# POST a silence to Alertmanager. Sets CI_QUIESCE_POSTED_ID, or CI_QUIESCE_SILENCE_ERROR and returns 1.
ci_quiesce_silence_post() {
  local out
  CI_QUIESCE_POSTED_ID='' CI_QUIESCE_SILENCE_ERROR=''
  out=$(MSYS_NO_PATHCONV=1 timeout 30 curl -sS -f -X POST -H 'Content-Type: application/json' \
    --data-binary "$1" "${OSHAL_CI_QUIESCE_ALERTMANAGER_URL%/}/api/v2/silences" 2>&1) \
    || { CI_QUIESCE_SILENCE_ERROR="$(ci_quiesce_redact "$out")"; return 1; }
  CI_QUIESCE_POSTED_ID=$(printf '%s' "$out" | sed -n 's/.*"silenceID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$CI_QUIESCE_POSTED_ID" ] && return 0
  CI_QUIESCE_SILENCE_ERROR='no silenceID in the response'
  return 1
}

# Silence SwarmContainerDown for exactly these names, or refuse. Sets CI_QUIESCE_SILENCE (an id,
# or 'none' when the operator disabled silencing). $1 = startsAt, rest = names. Returns 1 to refuse.
ci_quiesce_silence_open() {
  local starts="$1"
  shift
  CI_QUIESCE_SILENCE='none'
  case "${OSHAL_CI_QUIESCE_ALERTMANAGER_URL-}" in
    none) log "quiesce: alert silence disabled (OSHAL_CI_QUIESCE_ALERTMANAGER_URL=none)"; return 0 ;;
    '') log "quiesce: REFUSED - OSHAL_CI_QUIESCE_ALERTMANAGER_URL is not set. Each stopped worker fires $CI_QUIESCE_ALERTNAME (intake: auto, one incident each); set the Alertmanager URL, or 'none' on a box without the monitoring overlay. Nothing stopped."; return 1 ;;
  esac
  if [ -z "$CI_QUIESCE_SILENCE_SECONDS" ]; then
    log "quiesce: REFUSED - no run bound (CI_LOCK_STALE_SECONDS) to size the silence; nothing stopped"; return 1
  fi
  local ends; ends="$(ci_quiesce_iso_in "$CI_QUIESCE_SILENCE_SECONDS")"
  if ! ci_quiesce_silence_post "$(ci_quiesce_silence_json '' "$starts" "$ends" "$@")"; then
    log "quiesce: REFUSED - Alertmanager did not accept the silence ($CI_QUIESCE_SILENCE_ERROR); nothing stopped"
    return 1
  fi
  CI_QUIESCE_SILENCE="$CI_QUIESCE_POSTED_ID"
  log "quiesce: $CI_QUIESCE_ALERTNAME silenced for $# worker(s) until $ends (silence $CI_QUIESCE_SILENCE)"
}

# Let the silence end one recovery grace from now, so a restored bot is scraped up before it can
# notify - and one that did not come back alerts after the grace, as it should. Never fatal.
ci_quiesce_silence_lapse() {
  case "${CI_QUIESCE_SILENCE:-none}" in none|'') return 0 ;; esac
  case "${OSHAL_CI_QUIESCE_ALERTMANAGER_URL-}" in
    ''|none) log "quiesce: WARNING silence $CI_QUIESCE_SILENCE cannot be shortened (no Alertmanager URL); it ends on its own"; return 0 ;;
  esac
  local ends; ends="$(ci_quiesce_iso_in "$CI_QUIESCE_GRACE_SECONDS")"
  if ci_quiesce_silence_post "$(ci_quiesce_silence_json "$CI_QUIESCE_SILENCE" "${CI_QUIESCE_SILENCE_STARTS:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" "$ends" "${CI_QUIESCE_LEFT[@]}")"; then
    log "quiesce: silence now ends $ends (${CI_QUIESCE_GRACE_SECONDS}s recovery grace)"
  else
    log "quiesce: WARNING could not shorten silence $CI_QUIESCE_SILENCE ($CI_QUIESCE_SILENCE_ERROR); it ends on its own"
  fi
}

# Write the state file atomically. Called BEFORE the first stop, as an intent log.
# $1 = silence id or none, $2 = silence startsAt, rest = container names.
ci_quiesce_write_state() {
  local silence="$1" starts="$2" name tmp="$CI_QUIESCE_STATE.tmp.$$"
  shift 2
  {
    printf '# scripts/ci-local.sh worker quiesce: containers stopped for a gate run.\n'
    printf '# The next run, or `bash scripts/ci/ci-quiesce.sh --resume`, starts every one still stopped.\n'
    printf 'started=%s\npid=%s\nsilence=%s\nsilence_starts=%s\n' "$(date +%FT%T)" "$$" "$silence" "$starts"
    for name in "$@"; do printf 'container=%s\n' "$name"; done
  } > "$tmp" && mv -f "$tmp" "$CI_QUIESCE_STATE"
}

# Read the state file into CI_QUIESCE_LEFT/_SILENCE/_SILENCE_STARTS/_STARTED/_STATE_PID.
# Returns 1 when there is none. Names are re-validated: the file is input, not trusted code.
ci_quiesce_read_state() {
  local key value
  CI_QUIESCE_LEFT=() CI_QUIESCE_SILENCE='none' CI_QUIESCE_SILENCE_STARTS='' CI_QUIESCE_STARTED='' CI_QUIESCE_STATE_PID=''
  [ -f "$CI_QUIESCE_STATE" ] || return 1
  while IFS='=' read -r key value; do
    value="${value%$'\r'}"
    case "$key" in
      container) [[ "$value" =~ $CI_QUIESCE_NAME_RE ]] && CI_QUIESCE_LEFT+=("$value") ;;
      silence) CI_QUIESCE_SILENCE="$value" ;;
      silence_starts) CI_QUIESCE_SILENCE_STARTS="$value" ;;
      started) CI_QUIESCE_STARTED="$value" ;;
      pid) CI_QUIESCE_STATE_PID="$value" ;;
    esac
  done < "$CI_QUIESCE_STATE"
  return 0
}

# The configured names that may be stopped tonight, into CI_QUIESCE_ELIGIBLE. Logs each refusal.
# Returns 1 when nothing may be stopped (and says why).
ci_quiesce_select() {
  local names=() name list="${OSHAL_CI_QUIESCE_WORKERS-}"
  CI_QUIESCE_ELIGIBLE=()
  read -r -a names <<< "${list//,/ }"
  if [ "${#names[@]}" -eq 0 ]; then
    log "quiesce: not configured (OSHAL_CI_QUIESCE_WORKERS is empty) - the gates run beside the full swarm"
    return 1
  fi
  if [ -f "$CI_QUIESCE_STATE" ]; then
    log "quiesce: REFUSED - $CI_QUIESCE_STATE from an earlier run is unresolved; nothing new stopped (bash scripts/ci/ci-quiesce.sh --resume)"
    return 1
  fi
  if ! ci_quiesce_load_critical; then
    log "quiesce: REFUSED - the routing-critical list is unreadable, so its protection cannot be checked; nothing stopped"
    return 1
  fi
  for name in "${names[@]}"; do
    if ci_quiesce_eligible "$name"; then CI_QUIESCE_ELIGIBLE+=("$name")
    else log "quiesce: $name REFUSED ($CI_QUIESCE_REFUSAL)"; fi
  done
  [ "${#CI_QUIESCE_ELIGIBLE[@]}" -gt 0 ] && return 0
  log "quiesce: none of the configured workers may be stopped; the gates run beside the full swarm"
  return 1
}

# Stop the configured, eligible workers for this run. Never fails the run: a refusal or a partial
# stop is logged and the gates run beside whatever is still up.
ci_quiesce_begin() {
  local starts name stopped=0
  ci_quiesce_settings
  ci_quiesce_select || return 0
  starts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ci_quiesce_silence_open "$starts" "${CI_QUIESCE_ELIGIBLE[@]}" || return 0
  if ! ci_quiesce_write_state "$CI_QUIESCE_SILENCE" "$starts" "${CI_QUIESCE_ELIGIBLE[@]}"; then
    log "quiesce: REFUSED - could not write $CI_QUIESCE_STATE; nothing stopped"
    CI_QUIESCE_LEFT=("${CI_QUIESCE_ELIGIBLE[@]}") CI_QUIESCE_SILENCE_STARTS="$starts"
    ci_quiesce_silence_lapse
    return 0
  fi
  for name in "${CI_QUIESCE_ELIGIBLE[@]}"; do
    if MSYS_NO_PATHCONV=1 timeout 120 docker stop "$name" >/dev/null 2>&1; then
      log "quiesce: stopped $name"; stopped=$((stopped + 1))
    else
      log "quiesce: WARNING could not stop $name; it keeps running"
    fi
  done
  log "quiesce: $stopped of ${#CI_QUIESCE_ELIGIBLE[@]} worker(s) stopped for this run; state in $CI_QUIESCE_STATE"
}

# Start one stopped container and confirm it is running. Returns 1 when it is not.
ci_quiesce_start_one() {
  MSYS_NO_PATHCONV=1 timeout 120 docker start "$1" >/dev/null 2>&1 || return 1
  ci_quiesce_inspect "$1" && [ "$CI_QUIESCE_STATUS" = running ]
}

# Start every container the state file names that is not running - in batches, the cold-start
# spike being what took the engine down on 2026-07-23 - then let the silence lapse and drop the
# state file. Idempotent: no state file, no work. Returns 1, keeping a state file that names only
# what is still down, when anything did not come back. CI_QUIESCE_RESUMED counts the starts.
ci_quiesce_resume() {
  local name down=() batch=0
  CI_QUIESCE_RESUMED=0
  ci_quiesce_settings
  ci_quiesce_read_state || return 0
  for name in "${CI_QUIESCE_LEFT[@]}"; do
    ci_quiesce_inspect "$name" && [ "$CI_QUIESCE_STATUS" = running ] && continue
    if [ "$CI_QUIESCE_BATCH_SIZE" -gt 0 ] && [ "$batch" -ge "$CI_QUIESCE_BATCH_SIZE" ]; then
      sleep "$CI_QUIESCE_BATCH_SETTLE"; batch=0
    fi
    batch=$((batch + 1))
    if ci_quiesce_start_one "$name"; then
      log "quiesce: restored $name"; CI_QUIESCE_RESUMED=$((CI_QUIESCE_RESUMED + 1))
    else
      log "quiesce: FAILED to restore $name"; down+=("$name")
    fi
  done
  ci_quiesce_silence_lapse
  if [ "${#down[@]}" -gt 0 ]; then
    ci_quiesce_write_state "$CI_QUIESCE_SILENCE" "$CI_QUIESCE_SILENCE_STARTS" "${down[@]}"
    log "quiesce: ${#down[@]} worker(s) still stopped (${down[*]}); $CI_QUIESCE_STATE kept for the next run or: bash scripts/ci/ci-quiesce.sh --resume"
    return 1
  fi
  rm -f "$CI_QUIESCE_STATE"
  log "quiesce: every stopped worker is running again ($CI_QUIESCE_RESUMED started)"
  return 0
}

# Every run that holds the lock calls this first: a state file here means an earlier run ended
# without restoring its workers (killed outright, or its restore failed). Returns 0 when there was
# none, or everything was already running again; 2 when it had to start workers left down; 1 when
# some would not start.
ci_quiesce_recover_leftover() {
  ci_quiesce_settings
  ci_quiesce_read_state || return 0
  log "quiesce: $CI_QUIESCE_STATE is left from a run started ${CI_QUIESCE_STARTED:-at an unknown time} (pid ${CI_QUIESCE_STATE_PID:-unknown}) that never restored its workers; restoring them now"
  ci_quiesce_resume || return 1
  [ "$CI_QUIESCE_RESUMED" -gt 0 ] && return 2
  return 0
}

# Standalone entry: --plan (read-only) and --resume (the hand restore after a killed run).
ci_quiesce_main() {
  local mode="${1-}" force=0 name list names=()
  shift || true
  [ "${1-}" = --force ] && { force=1; shift; }
  ci_quiesce_settings
  case "$mode" in
    --plan)
      list="${OSHAL_CI_QUIESCE_WORKERS-}"
      [ "$#" -gt 0 ] && list="$*"
      # Split exactly as ci_quiesce_select does: read -a never globs, so `*` stays a name and is refused.
      read -r -a names <<< "${list//,/ }"
      [ "${#names[@]}" -gt 0 ] || { log "quiesce-plan: no names (set OSHAL_CI_QUIESCE_WORKERS or pass names)"; return 2; }
      ci_quiesce_load_critical || { log "quiesce-plan: the routing-critical list is unreadable; every name would be refused"; return 1; }
      for name in "${names[@]}"; do
        if ci_quiesce_eligible "$name"; then log "quiesce-plan: $name WOULD STOP (worker, agent ${CI_QUIESCE_AGENT:-none}, running)"
        else log "quiesce-plan: $name REFUSED ($CI_QUIESCE_REFUSAL)"; fi
      done ;;
    --resume)
      if [ -d "$STATE_DIR/ci-local.lock" ] && [ "$force" != 1 ]; then
        log "quiesce: a ci-local run holds $STATE_DIR/ci-local.lock and restores its own workers; --force restores now anyway"
        return 2
      fi
      [ -f "$CI_QUIESCE_STATE" ] || { log "quiesce: no $CI_QUIESCE_STATE - nothing to restore"; return 0; }
      ci_quiesce_resume ;;
    *) printf 'usage: %s --plan [name ...] | --resume [--force]\n' "$0" >&2; return 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  STATE_DIR="${OSHAL_CI_STATE_DIR:-$(cygpath -u "${LOCALAPPDATA:-$HOME/AppData/Local}")/oshal}"
  log() { printf '[%s] %s\n' "$(date +%FT%T)" "$*"; }
  if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi
  ci_quiesce_main "$@"
  exit $?
fi
