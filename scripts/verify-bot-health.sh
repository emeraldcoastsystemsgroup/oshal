#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Initial verify-bot-health script (E1)
# -----------------------------------------------------------------------------
#
# Verifies swarm bot health by checking Docker container status and HTTP health endpoints.
# Usage: npm run verify:bots   OR   bash scripts/verify-bot-health.sh
# Exit 0 = all healthy, Exit 1 = any unhealthy or missing.

set -euo pipefail

TOTAL=0
HEALTHY=0
UNHEALTHY=0
MISSING=0

# Known swarm bot containers from docker-compose.swarm-local.yml
BOTS=(
  "swarm-project-manager:3010"
  "swarm-task-manager:3011"
  "swarm-code-developer:3012"
  "swarm-code-reviewer:3013"
  "swarm-rca-specialist:3014"
  "swarm-presentation-bot:3015"
  "swarm-documentation-writer:3016"
  "swarm-agent-factory:3017"
  "swarm-devops-bot:3018"
  "swarm-incident-response-bot:3019"
  "swarm-research-bot:3020"
  "swarm-security-auditor-bot:3021"
  "swarm-test-engineer:3022"
  "swarm-architect-bot:3023"
  "swarm-business-plan-bot:3024"
  "swarm-tester-bot:3025"
)

echo "=== OSHAL Swarm Bot Health Check ==="
echo ""

for entry in "${BOTS[@]}"; do
  CONTAINER="${entry%%:*}"
  PORT="${entry##*:}"
  TOTAL=$((TOTAL + 1))

  # Check Docker container status
  DOCKER_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "not-found")

  if [ "$DOCKER_STATUS" = "not-found" ]; then
    # Container doesn't exist — check if it's running at all
    RUNNING=$(docker inspect --format='{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo "false")
    if [ "$RUNNING" = "true" ]; then
      DOCKER_STATUS="running (no healthcheck)"
    else
      DOCKER_STATUS="missing"
      MISSING=$((MISSING + 1))
      printf "  ❌ %-35s  MISSING (container not running)\n" "$CONTAINER"
      continue
    fi
  fi

  # Check HTTP health endpoint
  HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" = "200" ]; then
    HEALTHY=$((HEALTHY + 1))
    printf "  ✅ %-35s  docker=%s  http=%s\n" "$CONTAINER" "$DOCKER_STATUS" "$HTTP_STATUS"
  else
    UNHEALTHY=$((UNHEALTHY + 1))
    printf "  ⚠️  %-35s  docker=%s  http=%s\n" "$CONTAINER" "$DOCKER_STATUS" "$HTTP_STATUS"
  fi
done

echo ""
echo "=== Summary ==="
echo "  Total:     $TOTAL"
echo "  Healthy:   $HEALTHY"
echo "  Unhealthy: $UNHEALTHY"
echo "  Missing:   $MISSING"

if [ "$UNHEALTHY" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "RESULT: FAIL — $((UNHEALTHY + MISSING)) bot(s) not healthy"
  exit 1
fi

echo ""
echo "RESULT: PASS — all $TOTAL bots healthy"
exit 0