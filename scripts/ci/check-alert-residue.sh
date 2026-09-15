#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Synthetic-residue guard for the alert consolidation tables. The integration guards for the alert pipeline used to run against whatever DSN the box handed them, which on this machine is the deployment database: 27 oshal_incident rows in it are fixture rows (24 from the reopen spec's 'probe-target', 3 from the cutover spec's 'cut-' run prefix) and one of them is still counted as a live incident by every dashboard that reads the table. Those specs now own a disposable PostgreSQL, and this is the standing proof that no fixture row lands in the deployment again. Fail-closed by design: a database it could not query reports UNCHECKED (exit 2), never "clean" — a guard that passes without looking is the false-green this repo has already paid for once.
#
# Usage:  bash scripts/ci/check-alert-residue.sh
#
# Reads only. It issues SELECTs and never writes, so it is safe against a live
# deployment; removing residue it finds is an operator decision, not this script's.
#
# Environment (all optional — defaults name the local deployment stack):
#   OSHAL_RESIDUE_DB_CONTAINER   container running the deployment PostgreSQL
#   OSHAL_RESIDUE_DB_USER        role to connect as
#   OSHAL_RESIDUE_DB_NAME        database to inspect
#   OSHAL_RESIDUE_PSQL_TIMEOUT   seconds allowed per query
#   OSHAL_RESIDUE_SAMPLE_ROWS    how many offending rows to print
#
# Exit codes: 0 = no synthetic residue; 1 = residue present; 2 = UNCHECKED
#             (database unreachable — the guard did not get to look).
set -uo pipefail

DB_CONTAINER="${OSHAL_RESIDUE_DB_CONTAINER:-oshal-local-db}"
DB_USER="${OSHAL_RESIDUE_DB_USER:-oshal}"
DB_NAME="${OSHAL_RESIDUE_DB_NAME:-oshal}"
PSQL_TIMEOUT="${OSHAL_RESIDUE_PSQL_TIMEOUT:-60}"
SAMPLE_ROWS="${OSHAL_RESIDUE_SAMPLE_ROWS:-10}"

# The three shapes the alert integration guards write, named here once so the
# gate and its regression spec cannot drift apart:
#   probe-target             tests/unit/alert-incident-reopen.spec.ts (makeEvent target)
#   cut-<pid>-<time>-...     tests/unit/alert-incident-cutover.spec.ts (RUN prefix)
#   zz-incident-reopen-...   tests/unit/alert-incident-reopen.spec.ts (RUN_PREFIX dedup key)
INCIDENT_PREDICATE="primary_target = 'probe-target' OR primary_target LIKE 'cut-%' OR dedup_key LIKE 'zz-incident-reopen-%'"
EVENT_PREDICATE="target = 'probe-target' OR target LIKE 'cut-%' OR dedup_key LIKE 'zz-incident-reopen-%'"

# Runs one statement in the deployment database. MSYS_NO_PATHCONV is load-bearing on
# Git Bash: without it the SQL's leading tokens can be rewritten into Windows paths.
psql_query() {
  MSYS_NO_PATHCONV=1 timeout "$PSQL_TIMEOUT" docker exec "$DB_CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At -c "$1"
}

# Answers whether a table exists, so a deployment that has not run migration 104/105
# is reported as "nothing to check" instead of being mistaken for a query failure.
table_present() {
  local answer
  answer=$(psql_query "SELECT to_regclass('public.$1') IS NOT NULL" 2>/dev/null) || return 1
  [ "$answer" = "t" ]
}

probe_output=$(psql_query 'SELECT 1' 2>&1)
probe_rc=$?
if [ "$probe_rc" -ne 0 ] || [ "$probe_output" != "1" ]; then
  echo "alert-residue: UNCHECKED - could not query database '$DB_NAME' in container '$DB_CONTAINER'." >&2
  echo "alert-residue: the guard did not look, so nothing here says the deployment is clean." >&2
  [ -n "$probe_output" ] && echo "alert-residue: $probe_output" >&2
  exit 2
fi

if ! table_present oshal_incident; then
  echo "alert-residue: oshal_incident is not present in '$DB_NAME' - the consolidation migrations have not run here, so no fixture row can exist."
  exit 0
fi

incident_count=$(psql_query "SELECT count(*) FROM oshal_incident WHERE $INCIDENT_PREDICATE")
if [ -z "$incident_count" ]; then
  echo "alert-residue: UNCHECKED - the oshal_incident residue count returned nothing." >&2
  exit 2
fi

member_count=0
if table_present oshal_incident_member; then
  member_count=$(psql_query "SELECT count(*) FROM oshal_incident_member WHERE incident_id IN (SELECT incident_id FROM oshal_incident WHERE $INCIDENT_PREDICATE)")
fi

event_count=0
if table_present oshal_alert_event; then
  event_count=$(psql_query "SELECT count(*) FROM oshal_alert_event WHERE $EVENT_PREDICATE")
fi

total=$(( incident_count + member_count + event_count ))
if [ "$total" -eq 0 ]; then
  echo "alert-residue: clean (no probe-target / cut- / zz-incident-reopen- rows in '$DB_NAME')"
  exit 0
fi

echo "alert-residue: FAIL - $total synthetic row(s) from the alert integration guards are in the deployment database '$DB_NAME'." >&2
echo "alert-residue: oshal_incident=$incident_count oshal_incident_member=$member_count oshal_alert_event=$event_count" >&2
echo "alert-residue: the alert specs own a disposable PostgreSQL (tests/helpers/disposable-alert-postgres.ts); a row here means something wrote fixture data into the running deployment." >&2
if [ "$incident_count" -gt 0 ]; then
  echo "alert-residue: first $SAMPLE_ROWS offending oshal_incident row(s):" >&2
  psql_query "SELECT incident_id || ' | ' || primary_target || ' | ' || state || ' | ' || dedup_key FROM oshal_incident WHERE $INCIDENT_PREDICATE ORDER BY first_seen LIMIT $SAMPLE_ROWS" >&2
fi
exit 1
