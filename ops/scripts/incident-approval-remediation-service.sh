#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# =============================================================================
# incident-approval-remediation-service.sh
# -----------------------------------------------------------------------------
# Manages the incident approval/remediation loop as a detached launchctl job so
# it survives shell/session teardown on macOS.
#
# Usage:
#   bash ops/scripts/incident-approval-remediation-service.sh start
#   bash ops/scripts/incident-approval-remediation-service.sh stop
#   bash ops/scripts/incident-approval-remediation-service.sh restart
#   bash ops/scripts/incident-approval-remediation-service.sh status
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
LABEL="${LABEL:-com.open-shal.incident-approval-remediation-loop}"
LEGACY_LABEL="com.open-shal.incident-approval-remediation-supervisor"
LOOP_SCRIPT="${ROOT_DIR}/ops/scripts/incident-approval-remediation-loop.sh"
LOOP_OUT="${LOG_DIR}/incident-approval-remediation-loop.out"
WRAPPER_OUT="${LOG_DIR}/incident-approval-remediation-launcher.out"
LOOP_PID_FILE="${LOG_DIR}/incident-approval-remediation-loop.pid"
HEARTBEAT_FILE="${LOG_DIR}/incident-approval-remediation-loop.heartbeat"
STATE_FILE="${LOG_DIR}/incident-approval-remediation-loop.state"

mkdir -p "${LOG_DIR}"

remove_job() {
  /bin/launchctl remove "${LABEL}" >/dev/null 2>&1 || true
  /bin/launchctl remove "${LEGACY_LABEL}" >/dev/null 2>&1 || true
}

launch_command() {
  cat <<EOF
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Docker.app/Contents/Resources/bin:/Users/SAPUSER/.homebrew/bin:/Users/SAPUSER/.homebrew/sbin:/Users/SAPUSER/bin"
cd "${ROOT_DIR}" || exit 1
while true; do
  bash "${LOOP_SCRIPT}" >> "${LOOP_OUT}" 2>&1
  exit_code=\$?
  printf '[%s] %s\n' "\$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "loop exited with code=\${exit_code}; restarting in 5s" >> "${WRAPPER_OUT}"
  sleep 5
done
EOF
}

kill_matching_processes() {
  local pattern="$1"
  while read -r pid _; do
    [[ -n "${pid}" ]] || continue
    kill -9 "${pid}" >/dev/null 2>&1 || true
  done < <(ps -eo pid=,command= | grep "${pattern}" | grep -v grep || true)
}

start_job() {
  stop_job
  rm -f "${LOOP_PID_FILE}" "${HEARTBEAT_FILE}"
  rm -rf "${LOG_DIR}/incident-approval-remediation-loop.lock" \
         "${LOG_DIR}/incident-approval-remediation-supervisor.lock"
  /bin/launchctl submit -l "${LABEL}" -- /bin/bash -lc "$(launch_command)"
}

stop_job() {
  remove_job
  kill_matching_processes '[i]ncident-approval-remediation-supervisor.sh'
  kill_matching_processes '[i]ncident-approval-remediation-loop.sh'
}

status_job() {
  /bin/launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 && echo "launchctl_job=loaded" || echo "launchctl_job=not_loaded"
  [[ -f "${LOOP_PID_FILE}" ]] && printf 'loop_pid=%s\n' "$(cat "${LOOP_PID_FILE}")"
  [[ -f "${HEARTBEAT_FILE}" ]] && cat "${HEARTBEAT_FILE}"
  [[ -f "${STATE_FILE}" ]] && tail -n 8 "${STATE_FILE}"
  return 0
}

case "${1:-status}" in
  start)
    start_job
    ;;
  stop)
    stop_job
    ;;
  restart)
    stop_job
    start_job
    ;;
  status)
    status_job
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
