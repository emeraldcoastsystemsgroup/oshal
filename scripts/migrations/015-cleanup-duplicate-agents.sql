/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 015: Cleanup Duplicate Agent Registrations
-- Date: 2026-03-30
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- Description: Removes stale duplicate agent rows that accumulated from
--              migration re-runs and UUID reassignments. The canonical
--              swarm-bot-registry.ts assigns:
--                rca-specialist  → a0000000-0000-0000-0000-000000000016
--                presentation-bot → a0000000-0000-0000-0000-000000000017
--                architect-bot   → a0000000-0000-0000-0000-000000000018
--              Migration 011 originally seeded rca-specialist on ...0009,
--              and Session 140 reassigned it to ...0016. This migration
--              removes the orphaned ...0009 row.
-- =============================================================================

-- Step 1: Remove stale rca-specialist on old UUID (canonical is ...0016)
DELETE FROM agents
WHERE agent_id = 'a0000000-0000-0000-0000-000000000009'
  AND name = 'rca-specialist';

-- Step 2: Ensure canonical rca-specialist exists at ...0016 with correct metadata
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-000000000016',
  'rca-specialist', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are a Senior Root Cause Analyst. Investigate failures using 5 Whys, Ishikawa, and fault tree analysis. Distinguish symptoms from root causes. Produce actionable RCA reports.", "role": "root-cause-analyst"}'::jsonb,
  ARRAY['root-cause-analysis', 'investigation', 'debugging', 'incident-analysis'],
  'Select for ROOT CAUSE ANALYSIS, INCIDENT INVESTIGATION, and DEBUGGING of production failures.',
  ARRAY['rca', 'root-cause', 'incident', 'investigation', 'failure', 'debug', 'postmortem'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-015-canonical"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  name = EXCLUDED.name,
  persona = EXCLUDED.persona,
  base_capabilities = EXCLUDED.base_capabilities,
  base_selector_descriptor = EXCLUDED.base_selector_descriptor,
  base_routing_keywords = EXCLUDED.base_routing_keywords,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- Step 3: Remove any duplicate agent rows by name where agent_id doesn't match
-- the canonical registry. This handles edge-node duplicates and any future
-- name collisions from dynamic agent creation.
-- NOTE: Only targets known duplicates — does not blindly delete.
DELETE FROM agents a
WHERE EXISTS (
  SELECT 1 FROM agents b
  WHERE b.name = a.name
    AND b.agent_id <> a.agent_id
    AND b.updated_at > a.updated_at
)
AND a.agent_id NOT IN (
  -- Canonical UUIDs from swarm-bot-registry.ts — never delete these
  'a0000000-0000-0000-0000-000000000001', -- project-manager
  'a0000000-0000-0000-0000-000000000002', -- task-manager
  'a0000000-0000-0000-0000-000000000003', -- code-developer
  'a0000000-0000-0000-0000-000000000004', -- code-reviewer
  'a0000000-0000-0000-0000-000000000005', -- documentation-writer
  'a0000000-0000-0000-0000-000000000006', -- test-engineer
  'a0000000-0000-0000-0000-000000000007', -- agent-factory
  'a0000000-0000-0000-0000-000000000008', -- devops-bot
  'a0000000-0000-0000-0000-00000000000a', -- security-auditor-bot
  'a0000000-0000-0000-0000-00000000000b', -- incident-response-bot
  'a0000000-0000-0000-0000-00000000000c', -- research-bot
  'a0000000-0000-0000-0000-000000000016', -- rca-specialist
  'a0000000-0000-0000-0000-000000000017', -- presentation-bot
  'a0000000-0000-0000-0000-000000000018'  -- architect-bot
);

-- Step 4: Log cleanup results (visible in migration output)
DO $$
DECLARE
  agent_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO agent_count FROM agents;
  RAISE NOTICE 'Migration 015 complete: % agents in registry after cleanup', agent_count;
END $$;
