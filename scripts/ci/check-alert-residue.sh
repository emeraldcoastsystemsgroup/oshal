#!/usr/bin/env bash
#
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Synthetic-residue guard for the alert consolidation tables. The integration guards for the alert pipeline used to run against whatever DSN the box handed them, which on this machine is the deployment database: 27 oshal_incident rows in it are fixture rows (24 from the reopen spec's 'probe-target', 3 from the cutover spec's 'cut-' run prefix) and one of them is still counted as a live incident by every dashboard that reads the table. Those specs now own a disposable PostgreSQL, and this is the standing proof that no fixture row lands in the deployment again. Fail-closed by design: a database it could not query reports UNCHECKED (exit 2), never "clean" — a guard that passes without looking is the false-green this repo has already paid for once.
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Close the one hole in that fail-closed claim: only the opening connectivity probe was fail-closed. Every query after it collapsed failure into a benign answer — table_present returned the same falsy value whether the table was genuinely absent or the query never completed, so a connection lost after the probe was reported as "the consolidation migrations have not run here" (exit 0, clean), and an unreadable oshal_incident_member / oshal_alert_event silently contributed 0 to the total. Existence checks now carry a distinct "could not ask" outcome and every count must come back as a number; anything else is UNCHECKED, which is what the header above has always promised.
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
#             (a query the verdict depends on did not answer — the guard did not
#             get to look, at the connectivity probe or at any point after it).
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

# The single exit for "the verdict depends on an answer this run never got". Every
# caller routes an unanswered query here rather than substituting a benign value,
# because a clean verdict the guard did not actually earn is worse than a red one.
unchecked() {
  echo "alert-residue: UNCHECKED - $1" >&2
  echo "alert-residue: the guard did not look, so nothing here says the deployment is clean." >&2
  [ "$#" -gt 1 ] && [ -n "$2" ] && echo "alert-residue: $2" >&2
  exit 2
}

# Answers whether a table exists, with three outcomes kept deliberately distinct:
#   0  the table is there
#   1  it is genuinely absent (a deployment that never ran migration 104/105)
#   2  the question could not be asked at all
# Collapsing 2 into 1 is precisely how a connection dropped after the opening probe
# used to be announced as "the consolidation migrations have not run here".
table_present() {
  local answer status
  answer=$(psql_query "SELECT to_regclass('public.$1') IS NOT NULL" 2>&1)
  status=$?
  TABLE_PRESENT_DETAIL="$answer"
  [ "$status" -ne 0 ] && return 2
  case "$answer" in
    t) return 0 ;;
    f) return 1 ;;
    *) return 2 ;;
  esac
}

# Runs a count and refuses to hand back a number it did not receive: a failed query,
# an empty result or any non-digit answer is UNCHECKED, never zero. Publishes through
# COUNT_RESULT rather than stdout so the exit inside unchecked ends the run instead of
# a command-substitution subshell that the caller would then read as an empty count.
COUNT_RESULT=0
count_rows() {
  local label="$1" answer status
  answer=$(psql_query "$2" 2>&1)
  status=$?
  [ "$status" -ne 0 ] && unchecked "the $label count in '$DB_NAME' did not complete." "$answer"
  case "$answer" in
    '' | *[!0-9]*) unchecked "the $label count in '$DB_NAME' answered '$answer' rather than a number." ;;
  esac
  COUNT_RESULT="$answer"
}

# Existence check for an optional companion table: absent means this deployment does
# not have it and 0 is the honest count; unanswerable means we do not know, so stop.
count_optional_table() {
  local table="$1" sql="$2"
  table_present "$table"
  case $? in
    0) count_rows "$table" "$sql" ;;
    1) COUNT_RESULT=0 ;;
    *) unchecked "the $table existence check in '$DB_NAME' did not answer." "$TABLE_PRESENT_DETAIL" ;;
  esac
}

TABLE_PRESENT_DETAIL=''

probe_output=$(psql_query 'SELECT 1' 2>&1)
probe_rc=$?
if [ "$probe_rc" -ne 0 ] || [ "$probe_output" != "1" ]; then
  unchecked "could not query database '$DB_NAME' in container '$DB_CONTAINER'." "$probe_output"
fi

table_present oshal_incident
case $? in
  0) ;;
  1)
    echo "alert-residue: oshal_incident is not present in '$DB_NAME' - the consolidation migrations have not run here, so no fixture row can exist."
    exit 0
    ;;
  *) unchecked "the oshal_incident existence check in '$DB_NAME' did not answer." "$TABLE_PRESENT_DETAIL" ;;
esac

count_rows oshal_incident "SELECT count(*) FROM oshal_incident WHERE $INCIDENT_PREDICATE"
incident_count="$COUNT_RESULT"

count_optional_table oshal_incident_member \
  "SELECT count(*) FROM oshal_incident_member WHERE incident_id IN (SELECT incident_id FROM oshal_incident WHERE $INCIDENT_PREDICATE)"
member_count="$COUNT_RESULT"

count_optional_table oshal_alert_event "SELECT count(*) FROM oshal_alert_event WHERE $EVENT_PREDICATE"
event_count="$COUNT_RESULT"

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
