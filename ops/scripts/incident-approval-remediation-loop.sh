#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# =============================================================================
# incident-approval-remediation-loop.sh
# -----------------------------------------------------------------------------
# Local OSHAL incident operator loop:
#   - approves at most one incident per hour
#   - checks the focused incident every 5 minutes
#   - applies limited local remediations when the runtime or ticket stalls
#   - keeps a compact state file and consolidates event context after 75 lines
#
# Usage:
#   nohup bash ops/scripts/incident-approval-remediation-loop.sh \
#     > logs/incident-approval-remediation-loop.out 2>&1 & echo $! > logs/incident-approval-remediation-loop.pid
#
# Stop:
#   kill "$(cat logs/incident-approval-remediation-loop.pid)"
# =============================================================================

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
STATE_FILE="${LOG_DIR}/incident-approval-remediation-loop.state"
EVENT_LOG="${LOG_DIR}/incident-approval-remediation-loop.events.log"
SUMMARY_LOG="${LOG_DIR}/incident-approval-remediation-loop.summary.log"
PID_FILE="${LOG_DIR}/incident-approval-remediation-loop.pid"
HEARTBEAT_FILE="${LOG_DIR}/incident-approval-remediation-loop.heartbeat"
LOCK_DIR="${LOG_DIR}/incident-approval-remediation-loop.lock"
LOCK_PID_FILE="${LOCK_DIR}/pid"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.oshal-local.yml"

API="${API:-http://127.0.0.1:35457}"
POLL_SECONDS="${POLL_SECONDS:-300}"
APPROVAL_INTERVAL_SECONDS="${APPROVAL_INTERVAL_SECONDS:-3600}"
APPROVAL_LIMIT="${APPROVAL_LIMIT:-10}"
STALL_SECONDS="${STALL_SECONDS:-1800}"
CONSOLIDATE_AT_LINES="${CONSOLIDATE_AT_LINES:-75}"
KEEP_EVENT_LINES="${KEEP_EVENT_LINES:-25}"
MIN_LIVE_BOTS="${MIN_LIVE_BOTS:-12}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-30}"
PRIMARY_REMEDIATION_BOT="${PRIMARY_REMEDIATION_BOT:-rca-specialist}"
SECONDARY_REMEDIATION_BOT="${SECONDARY_REMEDIATION_BOT:-devops-bot}"
TERTIARY_REMEDIATION_BOT="${TERTIARY_REMEDIATION_BOT:-incident-remediation-bot}"
LOCK_HELD=0

RESTART_SERVICES=(
  oshal-api
  incident-remediation-bot
  incident-response-bot
  queue-bot
  devops-bot
  rca-specialist
)

mkdir -p "${LOG_DIR}"

ts() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  local message="$*"
  printf '[%s] %s\n' "$(ts)" "${message}" | tee -a "${EVENT_LOG}"
}

append_summary() {
  printf '[%s] %s\n' "$(ts)" "$*" >> "${SUMMARY_LOG}"
}

write_heartbeat() {
  local stage="${1:-running}"
  cat > "${HEARTBEAT_FILE}" <<EOF
pid=$$
ts=$(date +%s)
stage='${stage//\'/}'
current_incident_id='${CURRENT_INCIDENT_ID:-}'
current_incident_status='${CURRENT_INCIDENT_STATUS:-}'
EOF
}

process_matches_script() {
  local pid="$1"
  ps -p "${pid}" -o command= 2>/dev/null | grep -Fq 'incident-approval-remediation-loop.sh'
}

acquire_lock() {
  local existing_pid=""

  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${LOCK_PID_FILE}"
    printf '%s\n' "$$" > "${PID_FILE}"
    LOCK_HELD=1
    return 0
  fi

  if [[ -f "${LOCK_PID_FILE}" ]]; then
    existing_pid="$(tr -dc '0-9' < "${LOCK_PID_FILE}" 2>/dev/null || true)"
  fi

  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null && process_matches_script "${existing_pid}"; then
    log "Another incident approval/remediation loop is already running (pid=${existing_pid}); exiting."
    exit 0
  fi

  rm -rf "${LOCK_DIR}"
  mkdir -p "${LOCK_DIR}"
  printf '%s\n' "$$" > "${LOCK_PID_FILE}"
  printf '%s\n' "$$" > "${PID_FILE}"
  LOCK_HELD=1
  log "Recovered stale incident loop lock${existing_pid:+ from pid=${existing_pid}}."
}

release_lock() {
  rm -rf "${LOCK_DIR}"
}

consolidate_context() {
  local lines
  lines=$(wc -l < "${EVENT_LOG}" 2>/dev/null || echo 0)
  if (( lines < CONSOLIDATE_AT_LINES )); then
    return
  fi

  local complete_count escalated_count approved_count in_process_count
  complete_count=$(grep -c 'status=complete' "${EVENT_LOG}" 2>/dev/null || true)
  escalated_count=$(grep -c 'status=escalated' "${EVENT_LOG}" 2>/dev/null || true)
  approved_count=$(grep -c 'approved incident' "${EVENT_LOG}" 2>/dev/null || true)
  in_process_count=$(grep -c 'status=in_process_' "${EVENT_LOG}" 2>/dev/null || true)

  append_summary \
    "context consolidated after ${lines} event lines | approved=${approved_count} complete=${complete_count} escalated=${escalated_count} in_process=${in_process_count}"

  tail -n "${KEEP_EVENT_LINES}" "${EVENT_LOG}" > "${EVENT_LOG}.tmp" && mv "${EVENT_LOG}.tmp" "${EVENT_LOG}"
  log "Context consolidated at ${CONSOLIDATE_AT_LINES} lines; kept last ${KEEP_EVENT_LINES} event lines."
}

load_state() {
  if [[ -f "${STATE_FILE}" ]]; then
    # shellcheck source=/dev/null
    source "${STATE_FILE}"
  fi

  APPROVALS_STARTED="${APPROVALS_STARTED:-0}"
  CURRENT_INCIDENT_ID="${CURRENT_INCIDENT_ID:-}"
  CURRENT_INCIDENT_STATUS="${CURRENT_INCIDENT_STATUS:-}"
  CURRENT_INCIDENT_TITLE="${CURRENT_INCIDENT_TITLE:-}"
  NEXT_APPROVE_EPOCH="${NEXT_APPROVE_EPOCH:-0}"
  LAST_STATUS_CHANGE_EPOCH="${LAST_STATUS_CHANGE_EPOCH:-0}"
  CURRENT_REMEDIATION_ATTEMPTS="${CURRENT_REMEDIATION_ATTEMPTS:-0}"
  LAST_REMEDIATION_TARGET="${LAST_REMEDIATION_TARGET:-}"
}

clear_focus() {
  CURRENT_INCIDENT_ID=""
  CURRENT_INCIDENT_STATUS=""
  CURRENT_INCIDENT_TITLE=""
  CURRENT_REMEDIATION_ATTEMPTS=0
  LAST_REMEDIATION_TARGET=""
}

save_state() {
  cat > "${STATE_FILE}" <<EOF
APPROVALS_STARTED=${APPROVALS_STARTED}
CURRENT_INCIDENT_ID='${CURRENT_INCIDENT_ID}'
CURRENT_INCIDENT_STATUS='${CURRENT_INCIDENT_STATUS}'
CURRENT_INCIDENT_TITLE='${CURRENT_INCIDENT_TITLE//\'/}'
NEXT_APPROVE_EPOCH=${NEXT_APPROVE_EPOCH}
LAST_STATUS_CHANGE_EPOCH=${LAST_STATUS_CHANGE_EPOCH}
CURRENT_REMEDIATION_ATTEMPTS=${CURRENT_REMEDIATION_ATTEMPTS}
LAST_REMEDIATION_TARGET='${LAST_REMEDIATION_TARGET}'
EOF
}

cleanup_runtime_artifacts() {
  if [[ "${LOCK_HELD}" != "1" ]]; then
    return
  fi

  if [[ -f "${LOCK_PID_FILE}" ]] && [[ "$(tr -dc '0-9' < "${LOCK_PID_FILE}" 2>/dev/null || true)" != "$$" ]]; then
    return
  fi

  rm -f "${PID_FILE}" "${HEARTBEAT_FILE}"
  release_lock
}

reconcile_state_with_api() {
  local now actual_status actual_title
  now="$(date +%s)"

  if (( NEXT_APPROVE_EPOCH <= 0 )); then
    NEXT_APPROVE_EPOCH="${now}"
  fi
  if (( LAST_STATUS_CHANGE_EPOCH <= 0 )); then
    LAST_STATUS_CHANGE_EPOCH="${now}"
  fi

  if [[ -z "${CURRENT_INCIDENT_ID}" ]]; then
    return
  fi

  actual_status="$(fetch_ticket_field "${CURRENT_INCIDENT_ID}" status)"
  actual_title="$(fetch_ticket_field "${CURRENT_INCIDENT_ID}" title)"

  if [[ -z "${actual_status}" ]]; then
    log "Startup reconciliation: focused incident ${CURRENT_INCIDENT_ID} no longer exists; clearing stale focus."
    clear_focus
    LAST_STATUS_CHANGE_EPOCH="${now}"
    save_state
    return
  fi

  CURRENT_INCIDENT_TITLE="${actual_title:-${CURRENT_INCIDENT_TITLE}}"

  if [[ "${actual_status}" != "${CURRENT_INCIDENT_STATUS}" ]]; then
    CURRENT_INCIDENT_STATUS="${actual_status}"
    LAST_STATUS_CHANGE_EPOCH="${now}"
    CURRENT_REMEDIATION_ATTEMPTS=0
    LAST_REMEDIATION_TARGET=""
    save_state
    log "Startup reconciliation: current incident ${CURRENT_INCIDENT_ID} status=${CURRENT_INCIDENT_STATUS}"
  fi

  case "${CURRENT_INCIDENT_STATUS}" in
    complete|cancelled)
      log "Startup reconciliation: current incident ${CURRENT_INCIDENT_ID} already settled with status=${CURRENT_INCIDENT_STATUS}; clearing focus."
      clear_focus
      save_state
      ;;
  esac
}

api_get() {
  curl -sS -m 20 "${API}$1"
}

api_put_json() {
  local path="$1"
  local payload="$2"
  curl -sS -m 30 -X PUT "${API}${path}" \
    -H 'Content-Type: application/json' \
    -d "${payload}"
}

api_post_json() {
  local path="$1"
  local payload="$2"
  curl -sS -m 60 -X POST "${API}${path}" \
    -H 'Content-Type: application/json' \
    -d "${payload}"
}

bot_agent_id_by_name() {
  local bot_name="$1"
  api_get '/api/swarm/bots/registry' \
    | jq -r --arg name "${bot_name}" '.bots[] | select(.name==$name) | (.agentId // .id // empty)' \
    | head -n 1
}

incident_agent_id() {
  bot_agent_id_by_name "incident-remediation-bot"
}

devops_agent_id() {
  bot_agent_id_by_name "devops-bot"
}

rca_agent_id() {
  bot_agent_id_by_name "rca-specialist"
}

queue_is_healthy() {
  local health_json registry_json health_status live_bots
  health_json=$(api_get '/api/health' 2>/dev/null || echo '{}')
  registry_json=$(api_get '/api/swarm/bots/registry' 2>/dev/null || echo '{}')
  health_status=$(jq -r '.status // "unknown"' <<< "${health_json}" 2>/dev/null || echo unknown)
  live_bots=$(jq -r '.liveBots // 0' <<< "${registry_json}" 2>/dev/null || echo 0)

  if [[ "${health_status}" == "ok" ]] && (( live_bots >= MIN_LIVE_BOTS )); then
    return 0
  fi

  log "Runtime unhealthy: health=${health_status} liveBots=${live_bots}. Restarting local incident services."
  docker compose -f "${COMPOSE_FILE}" restart "${RESTART_SERVICES[@]}" >/dev/null 2>&1 || \
    log "Service restart command failed; leaving runtime as-is for next cycle."
  sleep 20
  return 1
}

incident_log_excerpt() {
  local ticket_id="$1"
  api_get '/api/logs' 2>/dev/null \
    | jq -r --arg tid "${ticket_id}" '
        [
          .[]
          | select((.taskId // "") == $tid or ((.message // "") | contains($tid)))
          | "\(.timestamp) [\(.level)] \(.message)"
        ][0:5][]?
      ' 2>/dev/null
}

fetch_ticket_field() {
  local ticket_id="$1"
  local field="$2"
  api_get "/api/tickets/${ticket_id}" 2>/dev/null | jq -r --arg field "${field}" '.[$field] // empty'
}

select_next_incident() {
  api_get '/api/tickets' 2>/dev/null \
    | jq -r --arg current "${CURRENT_INCIDENT_ID}" '
        .tickets
        | map(select(.ticketType == "incident" and .ticketId != $current))
        | (
            (map(select(.status == "approval_required"))) +
            (map(select(.status == "escalated"))) +
            (map(select(.status == "backlog"))) +
            (map(select(.status == "approved")))
          )
        | unique_by(.ticketId)
        | .[0].ticketId // empty
      '
}

approve_incident() {
  local ticket_id="$1"
  local title="$2"
  local result
  result=$(api_put_json "/api/tickets/${ticket_id}/status" '{"status":"approved"}' 2>/dev/null || true)
  if jq -e '.newStatus == "approved" or .status == "updated"' >/dev/null 2>&1 <<< "${result}"; then
    CURRENT_INCIDENT_ID="${ticket_id}"
    CURRENT_INCIDENT_TITLE="${title}"
    CURRENT_INCIDENT_STATUS="approved"
    LAST_STATUS_CHANGE_EPOCH="$(date +%s)"
    CURRENT_REMEDIATION_ATTEMPTS=0
    LAST_REMEDIATION_TARGET=""
    APPROVALS_STARTED=$((APPROVALS_STARTED + 1))
    NEXT_APPROVE_EPOCH=$(( $(date +%s) + APPROVAL_INTERVAL_SECONDS ))
    save_state
    log "Approved incident ${ticket_id} (${title}). approvals_started=${APPROVALS_STARTED}/${APPROVAL_LIMIT}"
    return 0
  fi

  log "Failed to approve incident ${ticket_id}: ${result}"
  return 1
}

send_remediation_prompt() {
  local ticket_id="$1"
  local ticket_status="$2"
  local target_name="$3"
  local target_agent_id="$4"
  local log_excerpt prompt payload result

  log_excerpt="$(incident_log_excerpt "${ticket_id}")"
  if [[ -z "${log_excerpt}" ]]; then
    log_excerpt="No ticket-specific log excerpt available."
  fi

  prompt=$(cat <<EOF
Operational loop intervention for incident ${ticket_id}.

Current status: ${ticket_status}
Title: ${CURRENT_INCIDENT_TITLE}

Investigate why this incident is stalled or escalated in the local OSHAL environment. Apply any safe local remediation you can directly. Focus on queue/runtime blockers, failed orchestration attempts, or obvious environment issues. Then summarize:
1. what you found
2. what you changed
3. what still blocks progress, if anything

Recent evidence:
${log_excerpt}
EOF
)

  payload=$(jq -n \
    --arg message "${prompt}" \
    --arg agentId "${target_agent_id}" \
    '{message:$message,targetAgent:$agentId,agentId:$agentId}')

  result=$(api_post_json "/api/tickets/${ticket_id}/chat" "${payload}" 2>/dev/null || true)
  if jq -e '.success == true or .botResponse != null' >/dev/null 2>&1 <<< "${result}"; then
    CURRENT_REMEDIATION_ATTEMPTS=$((CURRENT_REMEDIATION_ATTEMPTS + 1))
    LAST_REMEDIATION_TARGET="${target_name}"
    save_state
    log "Sent remediation prompt for ${ticket_id} to ${target_name}."
    return 0
  fi

  log "Failed remediation prompt for ${ticket_id} via ${target_name}: ${result}"
  return 1
}

reapprove_if_needed() {
  local ticket_id="$1"
  local current_status
  current_status=$(fetch_ticket_field "${ticket_id}" status)
  case "${current_status}" in
    escalated|approval_required|paused|backlog)
      api_put_json "/api/tickets/${ticket_id}/status" '{"status":"approved"}' >/dev/null 2>&1 || true
      CURRENT_INCIDENT_STATUS="approved"
      LAST_STATUS_CHANGE_EPOCH="$(date +%s)"
      save_state
      log "Re-approved incident ${ticket_id} from status=${current_status} after remediation."
      ;;
  esac
}

remediate_incident() {
  local ticket_id="$1"
  local current_status="$2"
  local target_name target_agent

  for target_name in "${PRIMARY_REMEDIATION_BOT}" "${SECONDARY_REMEDIATION_BOT}" "${TERTIARY_REMEDIATION_BOT}"; do
    [[ -z "${target_name}" ]] && continue
    [[ "${LAST_REMEDIATION_TARGET}" == "${target_name}" ]] && continue

    target_agent="$(bot_agent_id_by_name "${target_name}")"
    if [[ -n "${target_agent}" ]]; then
      send_remediation_prompt "${ticket_id}" "${current_status}" "${target_name}" "${target_agent}" || true
      break
    fi
  done

  reapprove_if_needed "${ticket_id}"
}

refresh_current_incident() {
  if [[ -z "${CURRENT_INCIDENT_ID}" ]]; then
    return
  fi

  local new_status new_title now status_age
  new_status=$(fetch_ticket_field "${CURRENT_INCIDENT_ID}" status)
  new_title=$(fetch_ticket_field "${CURRENT_INCIDENT_ID}" title)

  if [[ -z "${new_status}" ]]; then
    log "Current incident ${CURRENT_INCIDENT_ID} no longer exists; clearing focus."
    CURRENT_INCIDENT_ID=""
    CURRENT_INCIDENT_STATUS=""
    CURRENT_INCIDENT_TITLE=""
    CURRENT_REMEDIATION_ATTEMPTS=0
    LAST_REMEDIATION_TARGET=""
    save_state
    return
  fi

  now="$(date +%s)"
  CURRENT_INCIDENT_TITLE="${new_title}"

  if [[ "${new_status}" != "${CURRENT_INCIDENT_STATUS}" ]]; then
    CURRENT_INCIDENT_STATUS="${new_status}"
    LAST_STATUS_CHANGE_EPOCH="${now}"
    CURRENT_REMEDIATION_ATTEMPTS=0
    LAST_REMEDIATION_TARGET=""
    save_state
    log "Current incident ${CURRENT_INCIDENT_ID} status=${CURRENT_INCIDENT_STATUS}"
  fi

  case "${CURRENT_INCIDENT_STATUS}" in
    complete|cancelled)
      log "Current incident ${CURRENT_INCIDENT_ID} settled with status=${CURRENT_INCIDENT_STATUS}."
      CURRENT_INCIDENT_ID=""
      CURRENT_INCIDENT_STATUS=""
      CURRENT_INCIDENT_TITLE=""
      CURRENT_REMEDIATION_ATTEMPTS=0
      LAST_REMEDIATION_TARGET=""
      save_state
      return
      ;;
    escalated)
      remediate_incident "${CURRENT_INCIDENT_ID}" "${CURRENT_INCIDENT_STATUS}"
      ;;
    approval_required)
      api_put_json "/api/tickets/${CURRENT_INCIDENT_ID}/status" '{"status":"approved"}' >/dev/null 2>&1 || true
      CURRENT_INCIDENT_STATUS="approved"
      LAST_STATUS_CHANGE_EPOCH="${now}"
      save_state
      log "Auto-approved current incident ${CURRENT_INCIDENT_ID} from approval_required."
      ;;
    approved|in_process_*)
      status_age=$(( now - LAST_STATUS_CHANGE_EPOCH ))
      if (( status_age >= STALL_SECONDS )); then
        log "Current incident ${CURRENT_INCIDENT_ID} stalled for ${status_age}s at status=${CURRENT_INCIDENT_STATUS}; triggering remediation."
        remediate_incident "${CURRENT_INCIDENT_ID}" "${CURRENT_INCIDENT_STATUS}"
      fi
      ;;
  esac
}

maybe_approve_next_incident() {
  local now candidate_id candidate_status candidate_title
  now="$(date +%s)"

  if (( APPROVALS_STARTED >= APPROVAL_LIMIT )); then
    return
  fi

  if (( now < NEXT_APPROVE_EPOCH )); then
    return
  fi

  if [[ -n "${CURRENT_INCIDENT_ID}" && "${CURRENT_INCIDENT_STATUS}" != "complete" && "${CURRENT_INCIDENT_STATUS}" != "cancelled" ]]; then
    log "Approval window reached, but current incident ${CURRENT_INCIDENT_ID} is still active (status=${CURRENT_INCIDENT_STATUS})."
    NEXT_APPROVE_EPOCH=$(( now + APPROVAL_INTERVAL_SECONDS ))
    save_state
    return
  fi

  candidate_id="$(select_next_incident)"
  if [[ -z "${candidate_id}" ]]; then
    log "No actionable incident available for approval."
    NEXT_APPROVE_EPOCH=$(( now + APPROVAL_INTERVAL_SECONDS ))
    save_state
    return
  fi

  candidate_status="$(fetch_ticket_field "${candidate_id}" status)"
  candidate_title="$(fetch_ticket_field "${candidate_id}" title)"

  if [[ "${candidate_status}" == "escalated" ]]; then
    CURRENT_INCIDENT_ID="${candidate_id}"
    CURRENT_INCIDENT_STATUS="${candidate_status}"
    CURRENT_INCIDENT_TITLE="${candidate_title}"
    LAST_STATUS_CHANGE_EPOCH="${now}"
    save_state
    log "Selected escalated incident ${candidate_id} (${candidate_title}) for remediation before approval."
    remediate_incident "${candidate_id}" "${candidate_status}"
    approve_incident "${candidate_id}" "${candidate_title}" || true
    return
  fi

  approve_incident "${candidate_id}" "${candidate_title}" || true
}

sleep_with_heartbeat() {
  local remaining="$1"
  local chunk

  while (( remaining > 0 )); do
    chunk="${HEARTBEAT_INTERVAL_SECONDS}"
    if (( chunk > remaining )); then
      chunk="${remaining}"
    fi
    write_heartbeat "sleeping"
    sleep "${chunk}"
    remaining=$(( remaining - chunk ))
  done
}

handle_shutdown() {
  write_heartbeat "stopped"
  log "Incident approval/remediation loop stopping."
  save_state
  cleanup_runtime_artifacts
  exit 0
}

trap cleanup_runtime_artifacts EXIT
trap '' SIGHUP
trap handle_shutdown SIGINT SIGTERM

acquire_lock
load_state
reconcile_state_with_api
save_state
write_heartbeat "startup"

log "Incident approval/remediation loop started. api=${API} poll=${POLL_SECONDS}s approval_interval=${APPROVAL_INTERVAL_SECONDS}s approval_limit=${APPROVAL_LIMIT}"

while true; do
  write_heartbeat "cycle-start"
  queue_is_healthy || true
  refresh_current_incident
  maybe_approve_next_incident
  consolidate_context
  save_state
  sleep_with_heartbeat "${POLL_SECONDS}"
done
