#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — app-bot integrity guard. The apps-vs-framework carve (ADR-085) left agent_id DRIFT: a store package (portrait-studio) reused drone-operator's core-canonical id b0100000-...001, so the live DB has that id as portrait-artist (active) and drone-operator displaced to b00f0000-...001 (INACTIVE). A unit test in THIS repo can't see it (the manifest lives in the separate oshal-applications store repo, installed into the volume) — so this checks the LIVE installed state, the way swarm-routability-check.sh checks live heartbeats. Catches: (1) BROKEN — an active app whose primary bot is unregistered or inactive (its routing is dead); (2) REVIEW — an active app pointing at a bot OWNED by a different app (the cross-wire signature; some are intentional shares, so this is advisory for a human to judge).
#
# Exit 0 = no BROKEN app-bot bindings; exit 1 = at least one active app can't reach its bot.
# REVIEW findings never fail the check (they need human intent — which app owns a shared id).
#
# Usage: bash scripts/swarm-app-bot-integrity-check.sh
set -uo pipefail

DB_CONTAINER="${DB_CONTAINER:-oshal-local-db}"
PSQL=(docker exec "$DB_CONTAINER" psql -U "${PGUSER:-oshal}" -d "${PGDATABASE:-oshal}" -t -A -F '|')

if ! "${PSQL[@]}" -c "SELECT 1" >/dev/null 2>&1; then
  echo "app-bot integrity: DB ($DB_CONTAINER) not reachable — skipping" >&2
  exit 0
fi

echo "=== OSHAL app-bot integrity guard ==="

# BROKEN: an ACTIVE app whose primary declared bot (agent_ids[1]) is not a registered ACTIVE agent.
# That app's Jarvis-delegation / queue routing has nowhere valid to land.
broken="$("${PSQL[@]}" -c "
  SELECT sa.name || '  ->  ' || sa.agent_ids[1] || '  (' || COALESCE(a.name,'UNREGISTERED') || ', ' || COALESCE(a.status,'missing') || ')'
  FROM swarm_applications sa
  LEFT JOIN agents a ON a.agent_id = sa.agent_ids[1]
  WHERE sa.status='active' AND array_length(sa.agent_ids,1) >= 1
    AND (a.agent_id IS NULL OR a.status <> 'active')
  ORDER BY sa.name;" 2>/dev/null)"

# REVIEW: an ACTIVE app whose primary bot is registered but owned (metadata.manifestApp) by a
# DIFFERENT app — the cross-wire signature (drone -> portrait-artist). Some are intentional shares
# (job-apply rides career-hunter; email+social share communications-bot), so this is advisory.
review="$("${PSQL[@]}" -c "
  SELECT sa.name || '  ->  ' || sa.agent_ids[1] || '  is ' || a.name || '  (owned by: ' || (a.metadata->>'manifestApp') || ')'
  FROM swarm_applications sa
  JOIN agents a ON a.agent_id = sa.agent_ids[1]
  WHERE sa.status='active'
    AND a.metadata->>'manifestApp' IS NOT NULL
    AND a.metadata->>'manifestApp' <> sa.name
  ORDER BY sa.name;" 2>/dev/null)"

if [ -n "$review" ]; then
  echo
  echo "  REVIEW (advisory) — active app points at a bot owned by another app:"
  echo "$review" | sed 's/^/    /'
  echo "    (Some are intentional shared bots. A genuinely-wrong one means the app's own bot was"
  echo "     displaced — e.g. drone -> portrait-artist while drone-operator sits inactive.)"
fi

echo
if [ -z "$broken" ]; then
  echo "RESULT: PASS — every active app's primary bot is registered and active."
  exit 0
fi
echo "  BROKEN — active app whose primary bot is unregistered or INACTIVE (routing dead):"
echo "$broken" | sed 's/^/    /'
echo
echo "RESULT: FAIL — an active app cannot reach its bot. Fix the manifest agent_id (in its"
echo "swarm-apps/*.yaml or oshal-applications store package) or re-activate the displaced bot."
exit 1
