#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block

# assess-cycle.sh — One iteration of the OSHAL improvement loop
# Logs to logs/oshal-improvement.log with timestamps
# Run from c:/Projects/oshal/

set -uo pipefail

REPO="c:/Projects/oshal"
LOG="$REPO/logs/oshal-improvement.log"
API="http://127.0.0.1:35457"
OS="https://127.0.0.1:9200"
OS_CREDS="admin:admin"
WORKSPACE="/app/workspace-shared"

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $1" | tee -a "$LOG"
}

log "=== CYCLE START ==="

# ── 1. Queue state ────────────────────────────────────────────────────────────
QUEUE_JSON=$(curl -s "$API/api/tickets?limit=200" 2>/dev/null)
QUEUE_SUMMARY=$(echo "$QUEUE_JSON" | python3 -c "
import json,sys,collections
data = json.load(sys.stdin)
tickets = data if isinstance(data,list) else data.get('tickets', data.get('data',[]))
c = collections.Counter(t.get('status','?') for t in tickets)
print(dict(c))
" 2>&1)
log "Queue: $QUEUE_SUMMARY"

# ── 2. Find recent completed workspaces with QUEUE-REVIEW.md ─────────────────
log "--- Recent queue-bot decisions ---"
DECISIONS=$(docker exec oshal-local-api sh -c "
  for workspace in \$(ls -td /app/workspace-shared/*/ 2>/dev/null | grep -v '__queue' | head -20); do
    review=\"\${workspace}deliverables/QUEUE-REVIEW.md\"
    brief_file=\"\${workspace}TASK-BRIEF.md\"
    if [ -f \"\$review\" ]; then
      result=\$(head -5 \"\$review\" | grep -oE 'APPROVED|REVISION-REQUIRED' | head -1)
      title=\$(head -5 \"\$brief_file\" | grep 'Task Brief' | sed 's/.*Task Brief — //' | cut -c1-55)
      rca_file=\"\${workspace}deliverables/RCA-REPORT.md\"
      has_real_data='no-rca'
      if [ -f \"\$rca_file\" ]; then
        if grep -q '\"count\":[1-9]' \"\$rca_file\" 2>/dev/null; then
          has_real_data='REAL-DATA'
        elif grep -q 'example_log_sre_' \"\$rca_file\" 2>/dev/null; then
          has_real_data='queried-0'
        fi
      fi
      echo \"\${result:-PENDING}|\${has_real_data}|\${title}\"
    fi
  done
" 2>/dev/null)
echo "$DECISIONS" | head -15 | while IFS='|' read result data title; do
  log "  $result | $data | $title"
done

# ── 3. Find new REVISION-REQUIRED tickets — extract first rejection line ──────
log "--- New rejection reasons (last 5) ---"
REJECTS=$(docker exec oshal-local-api sh -c "
  for workspace in \$(ls -td /app/workspace-shared/*/ 2>/dev/null | grep -v '__queue' | head -30); do
    review=\"\${workspace}deliverables/QUEUE-REVIEW.md\"
    if [ -f \"\$review\" ] && grep -q 'REVISION-REQUIRED' \"\$review\"; then
      title=\$(head -5 \"\${workspace}TASK-BRIEF.md\" | grep 'Task Brief' | sed 's/.*Task Brief — //' | cut -c1-50)
      # Get first bullet point of feedback
      reason=\$(grep -A1 'FEEDBACK:' \"\$review\" | tail -1 | cut -c1-120)
      echo \"REJECT|\${title}|\${reason}\"
    fi
  done | head -5
" 2>/dev/null)
echo "$REJECTS" | while IFS='|' read _ title reason; do
  log "  REJECT: $title :: $reason"
done

# ── 4. Check if port-forward is alive ────────────────────────────────────────
PF_STATUS=$(curl -sk --max-time 3 "$OS/_cat/health?h=status" -u "$OS_CREDS" 2>&1 | tr -d '\n')
log "OpenSearch port-forward: $PF_STATUS"
if [[ "$PF_STATUS" != *"green"* && "$PF_STATUS" != *"yellow"* ]]; then
  log "WARNING: port-forward appears down — restarting"
  kubectl --context="${KUBE_CONTEXT:?set KUBE_CONTEXT}" port-forward -n "${OPENSEARCH_NS:-observability}" svc/"${OPENSEARCH_SVC:-opensearch-primary}" 9200:9200 &
  sleep 3
  log "  Port-forward restarted (PID $!)"
fi

# ── 5. Pump fresh real incidents ──────────────────────────────────────────────
log "--- Pumping fresh real incidents ---"
PUMP_OUT=$(bash "$REPO/scripts/pump-real-incidents.sh" 2>&1 | grep -E 'OK|FAIL|===|---')
echo "$PUMP_OUT" | while read line; do
  log "  PUMP: $line"
done

# ── 6. Check for cost tracking on recent complete tickets ─────────────────────
log "--- Recent completed tickets with cost ---"
echo "$QUEUE_JSON" | python3 -c "
import json,sys
data = json.load(sys.stdin)
tickets = data if isinstance(data,list) else data.get('tickets', data.get('data',[]))
complete = [t for t in tickets if t.get('status') == 'complete']
# Sort by updated_at desc, take last 5
import operator
try:
    recent = sorted(complete, key=lambda t: t.get('updated_at',''), reverse=True)[:5]
except: recent = complete[:5]
for t in recent:
    cost = t.get('metadata', {}).get('cost', 'N/A')
    print(f\"  cost={cost} | {t.get('title','?')[:60]}\")
" 2>/dev/null | while read line; do
  log "$line"
done

log "=== CYCLE END ==="
