#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Script to clean junk UUID-titled tickets from Redis. Targets 445 tickets that have UUID-as-title, no descriptions, no workspaces, no hierarchy.
#
# Usage:
#   ./scripts/clean-junk-redis-tickets.sh                # dry-run (default)
#   ./scripts/clean-junk-redis-tickets.sh --execute      # actually delete
#
# The script connects to the oshal-swarm-redis container and:
# 1. Scans all oshal:tickets:* keys
# 2. Identifies tickets where the title matches a UUID pattern
# 3. Reports how many junk tickets were found
# 4. Deletes them only if --execute flag is passed

set -euo pipefail

REDIS_CONTAINER="${REDIS_CONTAINER:-oshal-swarm-redis}"
REDIS_PREFIX="oshal:tickets:"
UUID_PATTERN="^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
EXECUTE=false

if [[ "${1:-}" == "--execute" ]]; then
  EXECUTE=true
  echo "🔴 EXECUTE mode — junk tickets will be DELETED"
else
  echo "🟡 DRY-RUN mode — pass --execute to actually delete"
fi

echo ""
echo "Scanning ${REDIS_PREFIX}* keys in container ${REDIS_CONTAINER}..."

# Get all ticket keys
KEYS=$(docker exec "${REDIS_CONTAINER}" redis-cli --no-auth-warning KEYS "${REDIS_PREFIX}*" 2>/dev/null || echo "")

if [[ -z "${KEYS}" ]]; then
  echo "No ticket keys found. Is the Redis container running?"
  exit 0
fi

TOTAL_COUNT=0
JUNK_COUNT=0
JUNK_KEYS=""

while IFS= read -r key; do
  if [[ -z "${key}" ]]; then
    continue
  fi
  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  # Get the title field from the hash
  TITLE=$(docker exec "${REDIS_CONTAINER}" redis-cli --no-auth-warning HGET "${key}" "title" 2>/dev/null || echo "")

  # Check if title matches UUID pattern (junk ticket)
  if echo "${TITLE}" | grep -qiE "${UUID_PATTERN}"; then
    JUNK_COUNT=$((JUNK_COUNT + 1))
    JUNK_KEYS="${JUNK_KEYS}${key}\n"
  fi
done <<< "${KEYS}"

echo ""
echo "📊 Results:"
echo "   Total tickets: ${TOTAL_COUNT}"
echo "   Junk tickets (UUID-titled): ${JUNK_COUNT}"
echo "   Real tickets: $((TOTAL_COUNT - JUNK_COUNT))"

if [[ ${JUNK_COUNT} -eq 0 ]]; then
  echo ""
  echo "✅ No junk tickets found — nothing to clean."
  exit 0
fi

if [[ "${EXECUTE}" == "true" ]]; then
  echo ""
  echo "🗑️  Deleting ${JUNK_COUNT} junk tickets..."

  DELETED=0
  while IFS= read -r key; do
    if [[ -z "${key}" ]]; then
      continue
    fi
    docker exec "${REDIS_CONTAINER}" redis-cli --no-auth-warning DEL "${key}" > /dev/null 2>&1
    DELETED=$((DELETED + 1))
  done < <(printf '%b' "${JUNK_KEYS}")

  echo "✅ Deleted ${DELETED} junk tickets."
else
  echo ""
  echo "ℹ️  Run with --execute to delete these ${JUNK_COUNT} junk tickets:"
  echo "   ./scripts/clean-junk-redis-tickets.sh --execute"
fi