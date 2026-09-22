#!/usr/bin/env bash
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — app-bot integrity guard. The apps-vs-framework carve (ADR-085) left agent_id DRIFT: a store package (portrait-studio) reused drone-operator's core-canonical id b0100000-...001, so the live DB has that id as portrait-artist (active) and drone-operator displaced to b00f0000-...001 (INACTIVE). A unit test in THIS repo can't see it (the manifest lives in the separate oshal-applications store repo, installed into the volume) — so this checks the LIVE installed state, the way swarm-routability-check.sh checks live heartbeats. Catches: (1) BROKEN — an active app whose primary bot is unregistered or inactive (its routing is dead); (2) REVIEW — an active app pointing at a bot OWNED by a different app (the cross-wire signature; some are intentional shares, so this is advisory for a human to judge).
# 2 | maintainer@emeraldcoastsystemsgroup.com   | Scan the WHOLE agent_ids array of active AND inactive apps, and tell a wrong pin apart from a deliberate share instead of reporting both. Two things were wrong. Scope: reading only agent_ids[1] of active apps, this check could not see `brand-graphics` (inactive) declaring a bot named brand-graphics under drone-operator's id, or `trading` (inactive) pinning identity-advisor — the exact defect shape it exists to catch, invisible until the day someone activates the app and the loader renames another package's bot out from under it. Signal: `agents.metadata.manifestApp <> sa.name` is NOT the wrong-pin signature. agent_ids is an ASSOCIATION column and is many-to-many BY DESIGN (swarm-app-repository resolves workflow.workerBot by NAME; workflow-publish-compiler does the same for a published Workflow Studio workflow), so a borrowed id is usually the feature working — communications-bot across switchboard/social/email-summarizer, vids-operator across vids/creative-studio/video/daily-trade-recap, career-hunter across career-hunter/job-apply, rca-specialist across intelligent-operations/intelligent-processing are all correct. Reporting those 13 shares as findings is what made the old REVIEW section unreadable. The discriminator is the manifest itself: a deliberate share does not DECLARE the bot (it names it, and the loader resolves the name, which cannot be wrong), whereas a wrong pin declares `bots: [{name, agentId}]` and the agentId resolves to an agent with a DIFFERENT name. Measured against the live registry: 68 declarations, 2 name mismatches — brand-graphics and trading, both known defects — and zero false positives on any deliberate share. Exit contract unchanged: exit 1 only for BROKEN, because only a dead route is an outage; MISPINNED and shares stay advisory.
#
# Exit 0 = no BROKEN app-bot bindings; exit 1 = at least one active app can't reach its bot.
# MISPINNED and SHARED findings never fail the check — a share is usually deliberate, and a
# mispin on an inactive app is a latent fault a human resolves in the owning manifest.
#
# Usage: bash scripts/swarm-app-bot-integrity-check.sh
#        SHOW_SHARES=1 bash scripts/swarm-app-bot-integrity-check.sh   # enumerate the shares too
set -uo pipefail

DB_CONTAINER="${DB_CONTAINER:-oshal-local-db}"
PSQL=(docker exec "$DB_CONTAINER" psql -U "${PGUSER:-oshal}" -d "${PGDATABASE:-oshal}" -t -A -F '|')

if ! "${PSQL[@]}" -c "SELECT 1" >/dev/null 2>&1; then
  echo "app-bot integrity: DB ($DB_CONTAINER) not reachable — skipping" >&2
  exit 0
fi

echo "=== OSHAL app-bot integrity guard ==="

# BROKEN: an ACTIVE app, ANY position in agent_ids, pointing at an agent that is not registered
# and active. That app's Jarvis-delegation / queue routing has nowhere valid to land. The whole
# array matters: a manifest declaring several bots routes to all of them, so a dead bot at
# position 3 is as broken as one at position 1 — position 1 was never the contract.
broken="$("${PSQL[@]}" -c "
  SELECT sa.name || '  ->  ' || u.aid::text || '  [agent_ids[' || u.ord || ']]  ('
         || COALESCE(a.name,'UNREGISTERED') || ', ' || COALESCE(a.status,'missing') || ')'
  FROM swarm_applications sa
  CROSS JOIN LATERAL unnest(sa.agent_ids) WITH ORDINALITY AS u(aid, ord)
  LEFT JOIN agents a ON a.agent_id = u.aid
  WHERE sa.status = 'active'
    AND (a.agent_id IS NULL OR a.status <> 'active')
  ORDER BY sa.name, u.ord;" 2>/dev/null)"

# MISPINNED: the app's OWN manifest declares a bot — a name AND an explicit agentId — and that
# agentId resolves to an agent with a different name. The manifest asked for bot X and pinned
# bot Y's identifier.
#
# This is the wrong-pin signature, and it is deliberately NOT 'the stamped owner differs'. An app
# may legitimately point at another app's bot: agent_ids is an association column, and the loader
# fills it from `workflow.workerBot`, which is a NAME it resolves — a reference that cannot be
# mispinned, and which leaves no `bots:` declaration here at all. What CAN be wrong is a
# hand-written uuid, and the manifest states the name it was meant to be. Checked on inactive apps
# too: the loader upserts a declared bot BY agentId, so an inactive app carrying a wrong pin
# renames another package's bot the moment someone activates it.
mispinned="$("${PSQL[@]}" -c "
  SELECT sa.name || ' [' || sa.status || ']  declares \"' || (b->>'name') || '\"  as  '
         || btrim(lower(b->>'agentId'))
         || '   but that id is \"' || a.name || '\"  (owned by: '
         || COALESCE(a.metadata->>'manifestApp','no stamp') || ')'
  FROM swarm_applications sa
  CROSS JOIN LATERAL jsonb_array_elements(sa.manifest->'bots') b
  JOIN agents a ON a.agent_id::text = btrim(lower(b->>'agentId'))
  WHERE jsonb_typeof(sa.manifest->'bots') = 'array'
    AND b->>'agentId' IS NOT NULL
    AND b->>'name' IS NOT NULL
    AND a.name <> (b->>'name')
  ORDER BY sa.name;" 2>/dev/null)"

# SHARED: an association whose stamped owner is a different app, with no name mismatch — the
# many-to-many the column is FOR. Counted, not enumerated, because listing them is what buried
# the findings above. SHOW_SHARES=1 prints them.
shares="$("${PSQL[@]}" -c "
  SELECT sa.name || ' [' || sa.status || ']  ->  ' || a.name || '  (owned by: '
         || (a.metadata->>'manifestApp') || ')'
  FROM swarm_applications sa
  CROSS JOIN LATERAL unnest(sa.agent_ids) AS aid
  JOIN agents a ON a.agent_id = aid
  WHERE a.metadata->>'manifestApp' IS NOT NULL
    AND a.metadata->>'manifestApp' <> sa.name
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(sa.manifest->'bots') b
      WHERE jsonb_typeof(sa.manifest->'bots') = 'array'
        AND btrim(lower(b->>'agentId')) = a.agent_id::text
        AND b->>'name' IS NOT NULL
        AND b->>'name' <> a.name)
  ORDER BY sa.name;" 2>/dev/null)"

share_count=0
[ -n "$shares" ] && share_count="$(printf '%s\n' "$shares" | wc -l | tr -d ' ')"

if [ -n "$mispinned" ]; then
  echo
  echo "  MISPINNED (advisory) — a manifest declares a bot under an id that belongs to another bot:"
  echo "$mispinned" | sed 's/^/    /'
  echo "    Fix the agentId in the owning manifest (its oshal-app.yaml / swarm-apps/*.yaml), then"
  echo "    reinstall. The loader upserts BY agentId, so activating one of these RENAMES the other"
  echo "    package's bot — the ADR-085 displacement that put portrait-studio on drone-operator."
fi

echo
echo "  SHARED: $share_count association(s) point at a bot another app owns, with no name mismatch."
echo "    agent_ids is an association column and is many-to-many by design — a shared bot is"
echo "    normally correct (communications-bot, vids-operator, career-hunter, rca-specialist), and"
echo "    a published Workflow Studio workflow reusing an existing bot is the feature working."
if [ "${SHOW_SHARES:-}" = "1" ] && [ -n "$shares" ]; then
  echo "$shares" | sed 's/^/    /'
fi

echo
if [ -z "$broken" ]; then
  if [ -n "$mispinned" ]; then
    echo "RESULT: PASS (with MISPINNED findings above) — every active app's bots are registered and"
    echo "active, but a manifest above pins an id that belongs to a different bot. Not an outage"
    echo "today; it becomes one when that app is activated."
  else
    echo "RESULT: PASS — every active app's bots are registered and active, and no manifest pins"
    echo "an id belonging to a different bot."
  fi
  exit 0
fi
echo "  BROKEN — active app whose bot is unregistered or INACTIVE (routing dead):"
echo "$broken" | sed 's/^/    /'
echo
echo "RESULT: FAIL — an active app cannot reach its bot. Fix the manifest agent_id (in its"
echo "swarm-apps/*.yaml or oshal-applications store package) or re-activate the displaced bot."
exit 1
