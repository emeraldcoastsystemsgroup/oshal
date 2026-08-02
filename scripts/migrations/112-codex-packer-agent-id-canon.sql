/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Finishes K3 (BACKLOG "codex-packer agent-id drift"). PR #85 / migration 100 fixed the COLLISION half — self-healing-bot moved off a0…030 — and left the DRIFT half: codex-packer's `agents` row had been minted by the old `repo.createAgent` path under an auto-generated UUID and never took the canonical id its manifest and both registries declare. The collision therefore became an absence: `swarm_applications.agent_ids[1]` for codex-packer points at a0…030 and NO row exists there, so `scripts/swarm-app-bot-integrity-check.sh` reports BROKEN and `scripts/oshal-up.sh` ends RESULT: FAIL on every engine restart — the operator's first signal after a restart, standing red. This moves the row onto the canonical id, preferring an in-place id change so cost/heartbeat history stays attached, and degrading to a canonical INSERT + retirement of the drifted row when foreign keys make the id immovable (every FK on agents.agent_id is ON UPDATE NO ACTION).
 */

-- =============================================================================
-- Migration 112: agent identity canon — codex-packer owns a0…030
--
-- The canonical id is the one the CODE declares, not the one the database
-- happened to generate: swarm-apps/codex-packer.yaml, swarm-bot-registry.ts and
-- swarm-bot-registry-local.ts all say a0000000-0000-0000-0000-000000000030, and
-- a manifest's agent_ids[1] is what every routing path resolves. A generated
-- UUID in one table is the outlier, so the row moves to the code's id.
--
-- WHY A DO BLOCK AND NOT A BARE UPDATE: all five foreign keys onto
-- agents.agent_id (config_sync_log, config_snapshots, agent_tools,
-- tool_install_log, agent_config) are ON UPDATE NO ACTION, so an id change
-- raises foreign_key_violation on any box where the drifted row accrued
-- references. On the reference box every one of those tables holds ZERO rows for
-- it, so the clean in-place move is what actually runs here — but a migration
-- that only works on one box is not a migration.
--
-- The fallback is NOT a swallowed error. Both branches end in the same
-- guarantee: a row exists at a0…030, named codex-packer, active, so the
-- integrity check passes and routing lands. In the fallback the drifted row is
-- retired (status 'inactive') rather than deleted, because its referencing rows
-- are a truthful record of the drift era — the same call migrations 100 and 111
-- made about ambiguous history.
-- =============================================================================

DO $$
DECLARE
  canonical CONSTANT uuid := 'a0000000-0000-0000-0000-000000000030';
  drifted   uuid;
BEGIN
  -- Already canonical (fresh box, or this migration re-run): nothing to do.
  IF EXISTS (SELECT 1 FROM agents WHERE agent_id = canonical) THEN
    RAISE NOTICE 'migration 112: a0...030 already present — no drift to repair';
    RETURN;
  END IF;

  SELECT agent_id INTO drifted
  FROM agents
  WHERE name = 'codex-packer' AND agent_id <> canonical
  ORDER BY created_at
  LIMIT 1;

  IF drifted IS NULL THEN
    RAISE NOTICE 'migration 112: no codex-packer row at all — the app loader will seed the canonical id';
    RETURN;
  END IF;

  BEGIN
    UPDATE agents SET agent_id = canonical, updated_at = NOW() WHERE agent_id = drifted;
    RAISE NOTICE 'migration 112: moved codex-packer % -> a0...030 in place (history preserved)', drifted;
  EXCEPTION WHEN foreign_key_violation THEN
    -- The drifted id is referenced and cannot move. Mint the canonical row from
    -- the drifted one so routing works, and retire the old row so nothing
    -- resolves codex-packer to two identities.
    INSERT INTO agents (
      agent_id, name, status, api_provider_id, model_id,
      persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
    )
    SELECT canonical, name, 'active', api_provider_id, model_id,
           persona, base_capabilities, base_selector_descriptor, base_routing_keywords, metadata
    FROM agents WHERE agent_id = drifted
    ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = NOW();

    UPDATE agents SET status = 'inactive', updated_at = NOW() WHERE agent_id = drifted;
    RAISE NOTICE 'migration 112: % is referenced and could not move; canonical a0...030 minted from it and the drifted row retired', drifted;
  END;
END $$;
