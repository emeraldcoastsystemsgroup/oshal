#!/usr/bin/env bash

# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR        | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Added one-shot Docker swarm runtime inspection helper for live runs, work items, outputs, and worker processes

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUN_ID="${1:-latest}"
POSTGRES_USER="${POSTGRES_USER:-keycloak}"
POSTGRES_DB="${POSTGRES_DB:-keycloak}"

psql_query() {
  docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "$1"
}

if [[ "$RUN_ID" == "latest" ]]; then
  RUN_ID="$(psql_query "select run_id from swarm_runs order by started_at desc limit 1;" | awk 'NR==3 { print $1 }')"
fi

if [[ -z "$RUN_ID" || "$RUN_ID" == "run_id" ]]; then
  echo "No swarm run found."
  exit 1
fi

echo "== Swarm Run =="
echo "$RUN_ID"
echo

echo "== Run Record =="
psql_query "select run_id,status,error,started_at,completed_at,completed_at-started_at as duration from swarm_runs where run_id='${RUN_ID}';"
echo

echo "== Work Items =="
psql_query "select work_item_id,external_id,status,assigned_agent_id,updated_at from work_items where swarm_run_id='${RUN_ID}' or external_id in (select external_id from work_items where swarm_run_id='${RUN_ID}') or external_id in (select 'verify:' || external_id from work_items where swarm_run_id='${RUN_ID}') order by updated_at;"
echo

echo "== Execution Output =="
psql_query "select external_id,status,left(coalesce(execution_output::text,''),5000) as execution_output from work_items where swarm_run_id='${RUN_ID}' order by updated_at;"
echo

echo "== Verification Output =="
psql_query "select external_id,status,left(coalesce(execution_output::text,''),5000) as execution_output from work_items where external_id in (select 'verify:' || external_id from work_items where swarm_run_id='${RUN_ID}') order by updated_at;"
echo

echo "== Active Worker Processes =="
docker compose exec -T api-server sh -lc "ps -ef | grep -E 'cline|node /usr/local/bin/cline|swarm-' | grep -v grep || true"
echo

echo "== Recent Container Logs =="
docker compose logs --tail=120 api-server
