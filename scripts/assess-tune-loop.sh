#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# =============================================================================
# assess-tune-loop.sh — 5-hour iterative bot improvement loop
# Cycle: post complex ticket → wait → assess RCA quality → tune persona → repeat
# =============================================================================
set -uo pipefail

API="http://127.0.0.1:35457"
DB="oshal-local-db"
LOG_DIR="logs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$SCRIPT_DIR/.."
PERSONA="$WORKSPACE/ai-lab/bot-personas/incident-remediation-bot.yaml"

mkdir -p "$LOG_DIR"
LOOP_LOG="$LOG_DIR/assess-tune-loop.log"
LOCK_FILE="$LOG_DIR/assess-tune-loop.lock"

# ─── Single-instance lock (heartbeat-based — no PID check, works on Windows) ──
# The running loop touches the lock file every cycle. If the file is less than
# MAX_STALE_AGE seconds old, we assume a live instance is running.
MAX_STALE_AGE=300   # 5 min: stale if no heartbeat for this long

_lock_age_s() {
  local now mtime
  now=$(date +%s)
  mtime=$(date -r "$LOCK_FILE" +%s 2>/dev/null)
  [[ -n "$mtime" ]] && echo $(( now - mtime )) || echo 9999
}

if [[ -f "$LOCK_FILE" ]]; then
  age=$(_lock_age_s)
  if [[ "$age" -lt "$MAX_STALE_AGE" ]]; then
    echo "[$(date '+%H:%M:%S')] ABORT: lock file is ${age}s old — another instance is running. Exit."
    exit 0
  else
    echo "[$(date '+%H:%M:%S')] Stale lock (${age}s old) — removing."
    rm -f "$LOCK_FILE"
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT INT TERM

ts()  { date '+%H:%M:%S'; }
log() { echo "[$(ts)] $*"; }
hr()  { echo "────────────────────────────────────────────────────────────────"; }

db() { docker exec "$DB" psql -U oshal -d oshal -t -c "$1" 2>/dev/null | tr -d ' \n'; }

# ─── Grade an RCA report ───────────────────────────────────────────────────
grade_rca() {
  local ticket_id="$1"
  local rca_file="$2"
  if [[ ! -f "$rca_file" ]]; then
    echo "FAIL:no_file"
    return
  fi

  local content
  content=$(cat "$rca_file")
  local score=0
  local issues=()

  # Check for real OpenSearch data (specific alarm IDs, timestamps, index names)
  if echo "$content" | grep -qiE 'example_log_sre|example_spec_sre|logstash-202|echo_staged|prometheus_alarms|dynatrace_alarms|zabbix_alarms'; then
    score=$((score+25))
  else
    issues+=("MISSING: No OpenSearch index names found — bot did not query real data")
  fi

  # Check for actual alarm IDs or timestamps from queries
  if echo "$content" | grep -qE '[0-9a-f]{16,}|2026-04-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'; then
    score=$((score+15))
  else
    issues+=("MISSING: No alarm IDs or precise timestamps from queries")
  fi

  # Check for graph data
  if echo "$content" | grep -qiE 'graph|neighbor|topology|upstream|downstream|dependency|MATCH|cypher|relationship'; then
    score=$((score+15))
  else
    issues+=("MISSING: No graph topology findings — bot did not query Graph API")
  fi

  # Check for kubectl data (for K8s tickets)
  if echo "$content" | grep -qiE 'kubectl|namespace|pod|node|OOMKilled|Evicted|CrashLoop|PodDisruption|memory.pressure'; then
    score=$((score+10))
  fi

  # Check for ServiceNow changes or ticket DB history
  if echo "$content" | grep -qiE 'ServiceNow|sn_get_changes|sn_get_incidents|change.*found|no.*change|prior.*incident|ticket.*history'; then
    score=$((score+10))
  else
    issues+=("MISSING: No ServiceNow change check or ticket history query")
  fi

  # Check for specific root cause (not generic)
  if echo "$content" | grep -qiE 'Root Cause:|root.cause'; then
    local rc_line
    rc_line=$(echo "$content" | grep -i 'Root Cause:' | head -1)
    if echo "$rc_line" | grep -qiE 'unknown|insufficient data|unable to determine|no data|not found'; then
      issues+=("WEAK: Root cause is vague — needs actual evidence from queries")
    else
      score=$((score+15))
    fi
  else
    issues+=("MISSING: No Root Cause section")
  fi

  # Check for scripts
  local diag_exists=false
  local rem_exists=false
  if docker exec oshal-local-api sh -c "test -f /app/workspace-shared/$ticket_id/deliverables/scripts/diagnose.sh" 2>/dev/null; then
    diag_exists=true
    score=$((score+5))
  fi
  if docker exec oshal-local-api sh -c "test -f /app/workspace-shared/$ticket_id/deliverables/scripts/remediate.sh" 2>/dev/null; then
    rem_exists=true
    score=$((score+5))
  fi
  if [[ "$diag_exists" == "false" ]]; then
    issues+=("MISSING: scripts/diagnose.sh not produced")
  fi
  if [[ "$rem_exists" == "false" ]]; then
    issues+=("MISSING: scripts/remediate.sh not produced")
  fi

  echo "SCORE:$score ISSUES:${#issues[@]}"
  for issue in "${issues[@]}"; do
    echo "  >> $issue"
  done
}

# ─── Wait for a specific ticket to complete ───────────────────────────────
wait_ticket() {
  local ticket_id="$1"
  local max_wait="${2:-300}"
  local elapsed=0

  while [[ $elapsed -lt $max_wait ]]; do
    local status
    status=$(db "SELECT status FROM tickets WHERE ticket_id='$ticket_id';")
    case "$status" in
      complete|escalated)
        echo "$status"
        return
        ;;
    esac
    sleep 15
    elapsed=$((elapsed+15))
  done
  echo "timeout"
}

# ─── Post one complex ticket and return its ID ───────────────────────────
post_ticket() {
  local level="$1"
  # Post the ticket
  bash "$SCRIPT_DIR/complex-incidents.sh" "$level" >> "$LOOP_LOG" 2>&1

  # Get the most recently created ticket ID
  sleep 3
  local tid
  tid=$(db "SELECT ticket_id FROM tickets WHERE status='approved' ORDER BY created_at DESC LIMIT 1;")
  echo "$tid"
}

# ─── Find RCA file for a ticket ───────────────────────────────────────────
find_rca() {
  local ticket_id="$1"
  docker exec oshal-local-api sh -c \
    "find /app/workspace-shared/$ticket_id/deliverables/RCA-REPORT.md 2>/dev/null" 2>/dev/null
}

read_rca() {
  local ticket_id="$1"
  docker exec oshal-local-api sh -c \
    "cat /app/workspace-shared/$ticket_id/deliverables/RCA-REPORT.md 2>/dev/null" 2>/dev/null
}

# ─── MAIN LOOP ─────────────────────────────────────────────────────────────
log ""
hr
log "ASSESS-TUNE LOOP — $(date)"
log "Running for 5 hours. Each cycle: post → wait → grade → tune → repeat"
hr

END_TIME=$(( $(date +%s) + 18000 ))  # 5 hours
cycle=0
level=3
consecutive_good=0

while [[ $(date +%s) -lt $END_TIME ]]; do
  cycle=$((cycle+1))
  cycle_start=$(date +%s)

  log ""
  hr
  log "CYCLE $cycle — Level $level ticket — $(date '+%H:%M:%S')"
  hr

  # Heartbeat: keep lock file fresh so concurrent starts are blocked
  touch "$LOCK_FILE" 2>/dev/null || true

  # Post ticket
  log "Posting Level $level ticket..."
  TICKET_ID=$(post_ticket "$level")
  if [[ -z "$TICKET_ID" ]]; then
    log "ERROR: Could not get ticket ID"
    sleep 30
    continue
  fi
  log "Ticket: $TICKET_ID"

  # Wait for completion (L3+ tickets need more time — 20 min max)
  MAX_WAIT=1200
  [[ $level -le 2 ]] && MAX_WAIT=600
  log "Waiting for ticket to complete (max $(( MAX_WAIT/60 )) min)..."
  RESULT=$(wait_ticket "$TICKET_ID" $MAX_WAIT)
  log "Result: $RESULT"

  if [[ "$RESULT" == "timeout" || "$RESULT" == "escalated" ]]; then
    log "WARN: Ticket $RESULT — checking for partial RCA"
  fi

  # Read and grade the RCA
  log "--- RCA Assessment ---"
  local_rca="/tmp/rca-cycle${cycle}.md"
  read_rca "$TICKET_ID" > "$local_rca" 2>/dev/null

  if [[ ! -s "$local_rca" ]]; then
    log "NO RCA FILE WRITTEN — bot produced no output"
    GRADE_OUTPUT="SCORE:0 ISSUES:1"
    ISSUES=("Bot produced no deliverables at all")
    SCORE=0
  else
    log "RCA file found ($(wc -l < "$local_rca") lines, $(wc -c < "$local_rca") bytes)"
    # Show first 40 lines
    head -40 "$local_rca" | tee -a "$LOOP_LOG"
    log "..."

    # Grade it
    GRADE_OUTPUT=$(grade_rca "$TICKET_ID" "$local_rca")
    log "--- Grade ---"
    echo "$GRADE_OUTPUT" | tee -a "$LOOP_LOG"
    SCORE=$(echo "$GRADE_OUTPUT" | grep 'SCORE:' | sed 's/.*SCORE:\([0-9]*\).*/\1/')
  fi

  log "Score: $SCORE/100"

  # ─── Tune based on score ───────────────────────────────────────────────
  if [[ "$SCORE" -ge 70 ]]; then
    consecutive_good=$((consecutive_good+1))
    log "GOOD RCA (score $SCORE) — consecutive good: $consecutive_good"

    if [[ $consecutive_good -ge 2 && $level -lt 5 ]]; then
      level=$((level+1))
      consecutive_good=0
      log "ADVANCING to Level $level"
    fi
  else
    consecutive_good=0
    log "NEEDS IMPROVEMENT (score $SCORE) — tuning persona"

    # Add specific tuning based on what was missing
    MISSING_OPENSEARCH=false
    MISSING_GRAPH=false
    MISSING_ROOT_CAUSE=false

    if echo "$GRADE_OUTPUT" | grep -q "No OpenSearch"; then MISSING_OPENSEARCH=true; fi
    if echo "$GRADE_OUTPUT" | grep -q "No graph"; then MISSING_GRAPH=true; fi
    if echo "$GRADE_OUTPUT" | grep -q "Root cause"; then MISSING_ROOT_CAUSE=true; fi

    log "Gaps: opensearch=$MISSING_OPENSEARCH graph=$MISSING_GRAPH rootcause=$MISSING_ROOT_CAUSE"

    # Inject reinforcement into the dispatch prompt
    if $MISSING_OPENSEARCH; then
      log "Patching: Adding OpenSearch enforcement to dispatch prompt"
      PATCH_MSG="CRITICAL: You MUST run execute_command curl to query OpenSearch before writing. The RCA without OpenSearch data is INVALID."
      docker exec oshal-local-api python3 -c "
content = open('/app/dist/features/swarm-orchestration/services/queue-manager-service.js').read()
old = \"'## INVESTIGATION SEQUENCE (follow all steps):'\"
new = old + \", '⚠️  $PATCH_MSG'\"
if old in content:
    open('/app/dist/features/swarm-orchestration/services/queue-manager-service.js','w').write(content.replace(old, new, 1))
    print('patched')
" 2>/dev/null || log "patch failed"
    fi
  fi

  elapsed=$(( $(date +%s) - cycle_start ))
  remaining=$(( END_TIME - $(date +%s) ))
  log "Cycle $cycle done in ${elapsed}s. Time remaining: $(( remaining/60 ))min"

  # Summary of all tickets
  log "Pipeline state: $(docker exec "$DB" psql -U oshal -d oshal -t -c "SELECT status, COUNT(*) FROM tickets GROUP BY status ORDER BY COUNT(*) DESC;" 2>/dev/null | grep -v '^$' | tr '\n' ' ')"

  # Wait before next cycle (let queue drain, give time for loop to pump next batch)
  WAIT=60
  if [[ "$RESULT" == "complete" && "$SCORE" -ge 70 ]]; then
    WAIT=30
  fi
  log "Waiting ${WAIT}s before cycle $((cycle+1))..."
  sleep "$WAIT"
done

hr
log "ASSESS-TUNE LOOP COMPLETE — ran $cycle cycles"
hr
