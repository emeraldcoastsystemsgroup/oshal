#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)

# =============================================================================
# monitor-oshal.sh — Watch local OSHAL incident processing
# =============================================================================
# Usage: bash scripts/monitor-oshal.sh
# Polls local OSHAL (port 35457) for ticket status progression.
# Shows all incident tickets and their current state.
# =============================================================================

API="http://127.0.0.1:35457"

echo "=== OSHAL Local Monitor — $(date) ==="
echo "API: ${API}"
echo ""

# Get all tickets
result=$(curl -s "${API}/api/tickets" 2>&1)
if [[ $? -ne 0 ]]; then
  echo "ERROR: Cannot reach ${API}/api/tickets"
  exit 1
fi

echo "--- Incident Tickets ---"
echo "${result}" | python3 - <<'PYEOF'
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    tickets = data
elif isinstance(data, dict):
    tickets = data.get('tickets', data.get('data', data.get('items', [])))
else:
    tickets = []

incidents = [t for t in tickets if t.get('ticketType') == 'incident']
others = [t for t in tickets if t.get('ticketType') != 'incident']

status_order = {
    'approved': 0,
    'in_process_discovery': 1,
    'in_process_design': 2,
    'in_process_build': 3,
    'in_process_deploy': 4,
    'in_process_test': 5,
    'in_process_release': 6,
    'approval_required': 7,
    'customer_action': 8,
    'complete': 9,
    'escalated': 10,
    'paused': 11,
    'cancelled': 12,
    'backlog': 13,
}

status_icons = {
    'approved': '⏳',
    'in_process_discovery': '🔍',
    'in_process_design': '📐',
    'in_process_build': '🔨',
    'in_process_deploy': '🚀',
    'in_process_test': '🧪',
    'in_process_release': '📦',
    'approval_required': '🔒',
    'customer_action': '👤',
    'complete': '✅',
    'escalated': '⚠️',
    'paused': '⏸',
    'cancelled': '❌',
    'backlog': '📋',
}

incidents.sort(key=lambda t: status_order.get(t.get('status',''), 99))

if not incidents:
    print("  No incident tickets found yet.")
    print("  Create one via the cockpit or POST /api/tickets.")
else:
    print(f"  Total incidents: {len(incidents)}")
    print()
    for t in incidents:
        status = t.get('status', 'unknown')
        icon = status_icons.get(status, '?')
        tid = t.get('ticketId', '?')[:8]
        title = t.get('title', '?')[:70]
        priority = t.get('priority', '?')
        print(f"  {icon} [{status:25s}] [{priority:6s}] {tid}… {title}")

print()
print(f"  Other ticket types: {len(others)}")
PYEOF

echo ""
echo "--- Active Bot Workspaces (last 5 modified files) ---"
# Try to find workspace files via docker
docker exec oshal-local-api find /app/workspace-shared -name "*.md" -newer /app/workspace-shared -type f 2>/dev/null | head -20 | while read f; do
  echo "  $(stat -c '%y' "$f" 2>/dev/null | cut -c1-19) — $f"
done 2>/dev/null || echo "  (run inside container: docker exec oshal-local-api find /app/workspace-shared -name '*.md' -type f)"

echo ""
echo "--- Recent API Logs (last 20 lines) ---"
docker compose -f "$(dirname "$0")/../docker-compose.oshal-local.yml" logs --tail=20 oshal-api 2>/dev/null || \
  docker logs oshal-local-api --tail=20 2>/dev/null || \
  echo "  (cannot read logs — run: docker logs oshal-local-api --tail=50)"

echo ""
echo "=== $(date) ==="
echo "Re-run this script to refresh. Ctrl+C to stop watching."
echo "  watch -n 30 'bash scripts/monitor-oshal.sh 2>&1 | head -60'"
