#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# =============================================================================
# incident-approval-remediation-supervisor.sh
# -----------------------------------------------------------------------------
# Keeps the local incident approval/remediation loop alive overnight.
# - Enforces a single supervisor instance
# - Starts the loop if it is not running
# - Restarts the loop if its heartbeat goes stale
#
# Usage:
#   nohup bash ops/scripts/incident-approval-remediation-supervisor.sh \
#     > logs/incident-approval-remediation-supervisor.out 2>&1 & echo $! > logs/incident-approval-remediation-supervisor.pid
# =============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
SUPERVISOR_LOG="${LOG_DIR}/incident-approval-remediation-supervisor.events.log"
SUPERVISOR_OUT="${LOG_DIR}/incident-approval-remediation-supervisor.out"
SUPERVISOR_PID_FILE="${LOG_DIR}/incident-approval-remediation-supervisor.pid"
SUPERVISOR_LOCK_DIR="${LOG_DIR}/incident-approval-remediation-supervisor.lock"
SUPERVISOR_LOCK_PID_FILE="${SUPERVISOR_LOCK_DIR}/pid"
LOOP_SCRIPT="${ROOT_DIR}/ops/scripts/incident-approval-remediation-loop.sh"
LOOP_OUT="${LOG_DIR}/incident-approval-remediation-loop.out"
LOOP_PID_FILE="${LOG_DIR}/incident-approval-remediation-loop.pid"
LOOP_HEARTBEAT_FILE="${LOG_DIR}/incident-approval-remediation-loop.heartbeat"

CHECK_SECONDS="${CHECK_SECONDS:-30}"
RESTART_DELAY_SECONDS="${RESTART_DELAY_SECONDS:-10}"
HEARTBEAT_STALE_SECONDS="${HEARTBEAT_STALE_SECONDS:-180}"
LOCK_HELD=0

mkdir -p "${LOG_DIR}"

ts() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '[%s] %s\n' "$(ts)" "$*" | tee -a "${SUPERVISOR_LOG}"
}

process_matches() {
  local pid="$1"
  local pattern="$2"
  ps -p "${pid}" -o command= 2>/dev/null | grep -Fq "${pattern}"
}

acquire_lock() {
  local existing_pid=""

  if mkdir "${SUPERVISOR_LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${SUPERVISOR_LOCK_PID_FILE}"
    printf '%s\n' "$$" > "${SUPERVISOR_PID_FILE}"
    LOCK_HELD=1
    return 0
  fi

  if [[ -f "${SUPERVISOR_LOCK_PID_FILE}" ]]; then
    existing_pid="$(tr -dc '0-9' < "${SUPERVISOR_LOCK_PID_FILE}" 2>/dev/null || true)"
  fi

  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null && process_matches "${existing_pid}" 'incident-approval-remediation-supervisor.sh'; then
    log "Another incident supervisor is already running (pid=${existing_pid}); exiting."
    exit 0
  fi

  rm -rf "${SUPERVISOR_LOCK_DIR}"
  mkdir -p "${SUPERVISOR_LOCK_DIR}"
  printf '%s\n' "$$" > "${SUPERVISOR_LOCK_PID_FILE}"
  printf '%s\n' "$$" > "${SUPERVISOR_PID_FILE}"
  LOCK_HELD=1
  log "Recovered stale supervisor lock${existing_pid:+ from pid=${existing_pid}}."
}

release_lock() {
  rm -rf "${SUPERVISOR_LOCK_DIR}"
  rm -f "${SUPERVISOR_PID_FILE}"
}

cleanup_supervisor_artifacts() {
  if [[ "${LOCK_HELD}" != "1" ]]; then
    return
  fi

  if [[ -f "${SUPERVISOR_LOCK_PID_FILE}" ]] && [[ "$(tr -dc '0-9' < "${SUPERVISOR_LOCK_PID_FILE}" 2>/dev/null || true)" != "$$" ]]; then
    return
  fi

  release_lock
}

loop_pid() {
  tr -dc '0-9' < "${LOOP_PID_FILE}" 2>/dev/null || true
}

loop_running() {
  local pid
  pid="$(loop_pid)"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null || return 1
  process_matches "${pid}" 'incident-approval-remediation-loop.sh'
}

heartbeat_age_seconds() {
  local ts_line now beat_ts
  [[ -f "${LOOP_HEARTBEAT_FILE}" ]] || {
    printf '%s\n' 999999
    return
  }
  ts_line="$(awk -F= '/^ts=/{print $2}' "${LOOP_HEARTBEAT_FILE}" 2>/dev/null || true)"
  [[ -n "${ts_line}" ]] || {
    printf '%s\n' 999999
    return
  }
  now="$(date +%s)"
  beat_ts="${ts_line}"
  printf '%s\n' $(( now - beat_ts ))
}

start_loop() {
  nohup bash "${LOOP_SCRIPT}" >> "${LOOP_OUT}" 2>&1 &
  sleep 1
  log "Started incident loop${1:+ (${1})} with pid=$(loop_pid)"
}

stop_loop() {
  local pid
  pid="$(loop_pid)"
  [[ -n "${pid}" ]] || return 0

  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    sleep 3
    if kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
  fi
}

handle_shutdown() {
  log "Incident supervisor stopping."
  stop_loop
  cleanup_supervisor_artifacts
  exit 0
}

trap cleanup_supervisor_artifacts EXIT
trap handle_shutdown SIGINT SIGTERM
trap '' SIGHUP

acquire_lock
log "Incident approval/remediation supervisor started. check=${CHECK_SECONDS}s stale=${HEARTBEAT_STALE_SECONDS}s"

while true; do
  if ! loop_running; then
    log "Incident loop not running; launching."
    start_loop "not-running"
    sleep "${CHECK_SECONDS}"
    continue
  fi

  age="$(heartbeat_age_seconds)"
  if (( age > HEARTBEAT_STALE_SECONDS )); then
    log "Incident loop heartbeat stale (${age}s > ${HEARTBEAT_STALE_SECONDS}s); restarting."
    stop_loop
    sleep "${RESTART_DELAY_SECONDS}"
    start_loop "stale-heartbeat"
  fi

  sleep "${CHECK_SECONDS}"
done
