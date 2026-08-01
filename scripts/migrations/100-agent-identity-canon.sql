/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | K2+K3 identity canon (BACKLOG kernel audit 2026-07-29). K2: a0…0018 had three names (system-architect in the local registry/persona/compose, architect-bot in the full registry + oshal-engineering manifest) — rename any DB row to the ONE name 'system-architect'. K3: a0…030 was a three-way collision (codex-packer.yaml + intelligent-processing.yaml + the self-healing-bot compose service) — self-healing-bot moves to its own id a0…056; 030 stays codex-packer. Mirrors registries/compose/manifests in the same change; pattern follows migration 015.
 */

-- =============================================================================
-- Migration 100: agent identity canon — K2 (system-architect) + K3 (self-healing)
--
-- K3 MIGRATION NOTE FOR EXISTING ROWS: historic tickets, chat_tasks cost rows and
-- routing audit entries that reference a0000000-…-000000000030 from BEFORE this
-- migration are AMBIGUOUS between codex-packer (the Bot Forge) and
-- self-healing-bot — the two identities shared the id, which is exactly why a
-- UUID cannot be safely re-pointed and the split id is the fix. Those historic
-- rows are left untouched (they are a truthful record of the collision era);
-- from this migration on, a0…030 attribution means codex-packer and a0…056
-- means self-healing-bot, unambiguously. Redis heartbeats need no migration:
-- oshal:runtime-agent:{agentId} keys carry a 90s TTL, so the old key expires
-- and the recreated container announces the new id on its own.
-- =============================================================================

-- ── K2: one name for a0…0018 ────────────────────────────────────────────────
-- Idempotent: no-ops when the row is absent or already canonical (the default
-- local registry has seeded 'system-architect' on this id for a while; only
-- SWARM_REGISTRY=full deployments seeded 'architect-bot').
UPDATE agents
SET name = 'system-architect', updated_at = NOW()
WHERE agent_id = 'a0000000-0000-0000-0000-000000000018'
  AND name <> 'system-architect';

-- ── K3: self-healing-bot gets its own identity at a0…056 ────────────────────
-- Step 1: if the collision era left the 030 row NAMED self-healing-bot (last
-- heartbeat won), restore that row to its canonical owner, codex-packer.
UPDATE agents
SET name = 'codex-packer', updated_at = NOW()
WHERE agent_id = 'a0000000-0000-0000-0000-000000000030'
  AND name = 'self-healing-bot';

-- Step 2: ensure the canonical self-healing-bot row exists at a0…056 so the
-- profile-gated container's first heartbeat/seed matches an unambiguous row.
INSERT INTO agents (
  agent_id, name, status, api_provider_id, model_id,
  persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
) VALUES (
  'a0000000-0000-0000-0000-000000000056',
  'self-healing-bot', 'active', 'auto', 'auto',
  '{"systemPrompt": "You are the self-healing remediation worker. You apply operator-approved container remediations (restart, health-check, log inspection) via your docker tool group. You never act without an approved remediation instruction.", "role": "self-healing"}'::jsonb,
  ARRAY['self-healing', 'container-restart', 'infrastructure-remediation', 'docker', 'monitoring'],
  'Select for OPERATOR-APPROVED container remediation only: restarting unhealthy swarm containers and verifying recovery. Never a general assistant.',
  ARRAY['self-healing', 'restart', 'container', 'remediation', 'unhealthy'],
  '{"topology": "localhost", "role": "specialist", "createdBy": "migration-100-identity-canon", "profileGated": "incident,extras"}'::jsonb
) ON CONFLICT (agent_id) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = NOW();
