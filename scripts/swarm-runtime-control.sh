#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

set -euo pipefail

BASE_URL="${OSHAL_SWARM_BASE_URL:-http://localhost:3456}"
DB_CONTAINER="${OSHAL_SWARM_DB_CONTAINER:-oshal-swarm-db}"
DB_NAME="${OSHAL_SWARM_DB_NAME:-oshal}"
DB_USER="${OSHAL_SWARM_DB_USER:-oshal}"
DRY_RUN=0

ACTIVE_ROOT_STATUSES="'pending','assigned','executing','in-review'"
ACTIVE_SUBTASK_STATUSES="'subtask-pending','subtask-assigned','subtask-executing'"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/swarm-runtime-control.sh active
  bash scripts/swarm-runtime-control.sh [--dry-run] stop-run <run-id> [reason]
  bash scripts/swarm-runtime-control.sh [--dry-run] stop-ticket <external-id> [reason]
  bash scripts/swarm-runtime-control.sh [--dry-run] stop-all [reason]

Examples:
  bash scripts/swarm-runtime-control.sh active
  bash scripts/swarm-runtime-control.sh --dry-run stop-all "operator cleanup"
  bash scripts/swarm-runtime-control.sh stop-run 1c410ce5-053c-43a4-abce-88394672c27d "stuck after timeout"
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    exit 1
  fi
}

psql_exec() {
  docker exec -i "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -P pager=off -c "$1"
}

psql_read() {
  docker exec -i "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 -P pager=off -At -F $'\t' -c "$1"
}

escape_sql() {
  printf '%s' "$1" | tr '\n' ' ' | sed "s/'/''/g"
}

run_or_echo_sql() {
  local sql="$1"
  if [ "${DRY_RUN}" -eq 1 ]; then
    printf '[dry-run] %s\n' "$sql"
  else
    psql_exec "$sql"
  fi
}

show_active() {
  echo "Base URL: ${BASE_URL}"
  echo "DB Container: ${DB_CONTAINER}"
  echo
  echo "=== In-Progress Runs ==="
  psql_exec "
    SELECT run_id, provider, status, started_at, COALESCE(completed_at::text, '') AS completed_at, COALESCE(error, '') AS error
    FROM swarm_runs
    WHERE status = 'in_progress'
    ORDER BY started_at DESC;
  "
  echo
  echo "=== Active Work Items ==="
  psql_exec "
    SELECT work_item_id, swarm_run_id, external_id, status, COALESCE(assigned_agent_id, '') AS assigned_agent_id, updated_at, title
    FROM work_items
    WHERE status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES})
    ORDER BY updated_at DESC;
  "
  echo
  echo "=== Escalated Work Items ==="
  psql_exec "
    SELECT work_item_id, swarm_run_id, external_id, status, COALESCE(assigned_agent_id, '') AS assigned_agent_id, updated_at, title
    FROM work_items
    WHERE status = 'escalated'
    ORDER BY updated_at DESC
    LIMIT 100;
  "
}

stop_ticket_records() {
  local external_id="$1"
  local reason="$2"
  local external_id_sql
  local reason_sql

  external_id_sql="$(escape_sql "${external_id}")"
  reason_sql="$(escape_sql "${reason}")"

  run_or_echo_sql "
    UPDATE work_items
    SET
      status = CASE
        WHEN status IN (${ACTIVE_SUBTASK_STATUSES}) THEN 'subtask-failed'
        WHEN status IN (${ACTIVE_ROOT_STATUSES}) THEN 'escalated'
        ELSE status
      END,
      execution_output = CASE
        WHEN execution_output IS NULL THEN
          jsonb_build_object('operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text))
        WHEN jsonb_typeof(execution_output) = 'object' THEN
          execution_output || jsonb_build_object('operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text))
        ELSE
          jsonb_build_object(
            'previous_execution_output', execution_output,
            'operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text)
          )
      END,
      updated_at = NOW()
    WHERE external_id = '${external_id_sql}'
      AND status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES});
  "

  run_or_echo_sql "
    UPDATE tickets
    SET
      status = 'escalated',
      state_group = 'escalated',
      execution_phase = NULL,
      updated_at = NOW()
    WHERE (ticket_id = '${external_id_sql}' OR external_id = '${external_id_sql}')
      AND status <> 'complete';
  "
}

stop_run() {
  local run_id="$1"
  local reason="${2:-Operator requested swarm run stop}"
  local run_id_sql
  local reason_sql
  local external_ids

  run_id_sql="$(escape_sql "${run_id}")"
  reason_sql="$(escape_sql "${reason}")"

  if [ "$(psql_read "SELECT COUNT(*) FROM swarm_runs WHERE run_id = '${run_id_sql}';")" = "0" ]; then
    echo "ERROR: swarm run not found: ${run_id}" >&2
    exit 1
  fi

  external_ids="$(psql_read "SELECT DISTINCT external_id FROM work_items WHERE swarm_run_id = '${run_id_sql}' AND external_id IS NOT NULL ORDER BY external_id;")"

  run_or_echo_sql "
    UPDATE swarm_runs
    SET
      status = 'failed',
      completed_at = COALESCE(completed_at, NOW()),
      error = CASE
        WHEN COALESCE(error, '') = '' THEN 'operator_stopped: ${reason_sql}'
        ELSE error || ' | operator_stopped: ${reason_sql}'
      END,
      updated_at = NOW()
    WHERE run_id = '${run_id_sql}'
      AND status = 'in_progress';
  "

  run_or_echo_sql "
    UPDATE work_items
    SET
      status = CASE
        WHEN status IN (${ACTIVE_SUBTASK_STATUSES}) THEN 'subtask-failed'
        WHEN status IN (${ACTIVE_ROOT_STATUSES}) THEN 'escalated'
        ELSE status
      END,
      execution_output = CASE
        WHEN execution_output IS NULL THEN
          jsonb_build_object('operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text))
        WHEN jsonb_typeof(execution_output) = 'object' THEN
          execution_output || jsonb_build_object('operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text))
        ELSE
          jsonb_build_object(
            'previous_execution_output', execution_output,
            'operator_stop', jsonb_build_object('reason', '${reason_sql}', 'stopped_at', NOW()::text)
          )
      END,
      updated_at = NOW()
    WHERE swarm_run_id = '${run_id_sql}'
      AND status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES});
  "

  while IFS= read -r external_id; do
    [ -n "${external_id}" ] || continue
    stop_ticket_records "${external_id}" "${reason}"
  done <<< "${external_ids}"
}

stop_ticket() {
  local external_id="$1"
  local reason="${2:-Operator requested ticket stop}"
  local external_id_sql
  local reason_sql
  local stoppable_runs

  external_id_sql="$(escape_sql "${external_id}")"
  reason_sql="$(escape_sql "${reason}")"

  if [ "$(psql_read "SELECT COUNT(*) FROM work_items WHERE external_id = '${external_id_sql}';")" = "0" ]; then
    echo "ERROR: no work items found for external id: ${external_id}" >&2
    exit 1
  fi

  stop_ticket_records "${external_id}" "${reason}"

  stoppable_runs="$(psql_read "
    WITH candidate_runs AS (
      SELECT DISTINCT swarm_run_id
      FROM work_items
      WHERE external_id = '${external_id_sql}'
    ),
    run_activity AS (
      SELECT
        swarm_run_id,
        COUNT(*) FILTER (WHERE status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES})) AS active_total,
        COUNT(*) FILTER (WHERE status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES}) AND external_id = '${external_id_sql}') AS active_target
      FROM work_items
      WHERE swarm_run_id IN (SELECT swarm_run_id FROM candidate_runs)
      GROUP BY swarm_run_id
    )
    SELECT swarm_run_id
    FROM run_activity
    WHERE active_total > 0 AND active_total = active_target
    ORDER BY swarm_run_id;
  ")"

  while IFS= read -r run_id; do
    [ -n "${run_id}" ] || continue
    run_or_echo_sql "
      UPDATE swarm_runs
      SET
        status = 'failed',
        completed_at = COALESCE(completed_at, NOW()),
        error = CASE
          WHEN COALESCE(error, '') = '' THEN 'operator_stopped: ${reason_sql}'
          ELSE error || ' | operator_stopped: ${reason_sql}'
        END,
        updated_at = NOW()
      WHERE run_id = '$(escape_sql "${run_id}")'
        AND status = 'in_progress';
    "
  done <<< "${stoppable_runs}"
}

stop_all() {
  local reason="${1:-Operator requested stop-all}"
  local run_ids
  local orphan_external_ids

  run_ids="$(psql_read "SELECT run_id FROM swarm_runs WHERE status = 'in_progress' ORDER BY started_at DESC;")"
  while IFS= read -r run_id; do
    [ -n "${run_id}" ] || continue
    stop_run "${run_id}" "${reason}"
  done <<< "${run_ids}"

  orphan_external_ids="$(psql_read "
    SELECT DISTINCT external_id
    FROM work_items
    WHERE status IN (${ACTIVE_ROOT_STATUSES}, ${ACTIVE_SUBTASK_STATUSES})
      AND external_id IS NOT NULL
    ORDER BY external_id;
  ")"
  while IFS= read -r external_id; do
    [ -n "${external_id}" ] || continue
    stop_ticket "${external_id}" "${reason}"
  done <<< "${orphan_external_ids}"
}

main() {
  require_command docker

  if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=1
    shift
  fi

  local action="${1:-}"
  case "${action}" in
    active)
      show_active
      ;;
    stop-run)
      [ -n "${2:-}" ] || { usage; exit 1; }
      stop_run "$2" "${3:-Operator requested swarm run stop}"
      ;;
    stop-ticket)
      [ -n "${2:-}" ] || { usage; exit 1; }
      stop_ticket "$2" "${3:-Operator requested ticket stop}"
      ;;
    stop-all)
      stop_all "${2:-Operator requested stop-all}"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
