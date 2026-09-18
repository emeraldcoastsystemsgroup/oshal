/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A bot's LLM provider is a row in a table (operator, 2026-09-17: "it should literally be a switch in a table"). The FLEET-DEFAULT switch: exactly one row, the reserved scope 'fleet-default', so switching the whole fleet is ONE write. The per-bot row is NOT here — it is the existing agent_config record (config_values.providerId / modelId, the record PUT /api/agents/:id/runtime writes and ADR-034 dispatch stamping already carries), so no fourth provider store is added. The table carries no secret — keys stay in the container environment. Readable by every identity (resolution runs in request and background context alike); written only under the operator GUC, enforced by FORCE ROW LEVEL SECURITY so the owning oshal_app role is scoped too. Empty at creation: no row = the registry literal, byte-identically.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot switch row lives HERE too (scope_id = the agent id), and an agent_config record is never one. Measured read-only on the operator box (2026-09-17): 70 agent_config records name a provider and not one was written by a person — 67 are seedManifestBotRuntime's manifest/deployment default (blank configUpdatedBy, configVersion 1), 2 are the bot's own broadcast-up ('bot-local'), 1 is a ConfigSyncService push ('oshal-push'). Entry 1's design read every one of them as a per-bot switch that beats the fleet row, so the operator's acceptance test (ADR-162 §7: ONE fleet-default write moves the WHOLE fleet) failed for all 70 — a machinery-written mirror of a registry literal is the literal wearing a row. Now: a per-bot row exists only when an operator writes one through the api (PUT /api/agents/:id/runtime with a providerId; released with DELETE /api/agents/provider-switch/:agentId), updated_by records who, and the operator-only write policy is what makes "operator-written" a property of the table rather than of a string. agent_config stays ADR-034 tier 2 of the carried dispatch record, BENEATH the fleet-default row. Rollout on the operator box: NOTHING is seeded from agent_config, so the first fleet-default write moves all 70 (registry bots and package bots alike); the 11 non-Codex records (project-manager gemini, task-manager openai, personal-finance-bot anthropic, and the 8 claude-code package bots) move with them, because none is an operator's choice.
 */

-- =============================================================================
-- Migration 146: the LLM provider switch rows
-- The precedence rule that reads this table lives in
-- src/shared/llm-runtime/bot-provider-switch.ts: per-bot row (this table,
-- scope_id = agent id, operator-written) -> fleet-default row (this table,
-- scope_id 'fleet-default') -> registry literal. No rows = the registry.
-- agent_config.config_values.providerId is NOT a switch: it is the ADR-034
-- dispatch record (tier 2 of what a dispatch carries), written by manifest
-- seeding, bot broadcast-up and config push — machinery, not an operator —
-- and it is OUTRANKED by the fleet-default row. Nothing is seeded from it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_bot_provider_switch (
  -- The reserved fleet scope 'fleet-default', or an agent id (a per-bot switch an operator wrote).
  scope_id    TEXT        PRIMARY KEY,
  -- A harness key (codex-cli, claude-code, cline, ...) or a Cline-backed API provider id
  -- (gemini, anthropic, openrouter, ...). Validated by the api before the write; the CHECK
  -- only refuses the shapes no validator would ever produce.
  provider_id TEXT        NOT NULL,
  model_id    TEXT,
  updated_by  TEXT        NOT NULL DEFAULT 'operator',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_bot_provider_switch_scope CHECK (btrim(scope_id) <> '' AND scope_id !~ '\s'),
  CONSTRAINT oshal_bot_provider_switch_provider CHECK (
    btrim(provider_id) <> '' AND provider_id !~ '\s' AND lower(provider_id) <> 'auto'
  ),
  CONSTRAINT oshal_bot_provider_switch_model CHECK (model_id IS NULL OR btrim(model_id) <> '')
);

COMMENT ON TABLE oshal_bot_provider_switch IS
  'The LLM provider switch rows: scope_id ''fleet-default'' (the fleet default, one write moves every bot without its own row) or an agent id (a per-bot switch an operator wrote; updated_by records who). agent_config.providerId is the ADR-034 dispatch record beneath the fleet row, never a switch. Resolved per-bot -> fleet -> registry literal. Carries no secret.';
COMMENT ON COLUMN oshal_bot_provider_switch.scope_id IS '''fleet-default'', or the agent id of the bot the row switches; non-blank, no whitespace.';
COMMENT ON COLUMN oshal_bot_provider_switch.updated_by IS 'Who wrote the row: the operator sub from the browser session that wrote it. Machinery never writes here.';
COMMENT ON COLUMN oshal_bot_provider_switch.provider_id IS 'Harness key or Cline-backed API provider id; validated by the api, refused with a reason when unknown.';

ALTER TABLE oshal_bot_provider_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_bot_provider_switch FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Every identity may READ: provider resolution runs inside user requests (inline bots, chat)
  -- and background work (dispatch stamping) alike, and the row holds nothing per-person.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_bot_provider_switch_read_all'
      AND polrelid = 'oshal_bot_provider_switch'::regclass
  ) THEN
    CREATE POLICY oshal_bot_provider_switch_read_all
      ON oshal_bot_provider_switch
      AS PERMISSIVE FOR SELECT
      USING (true);
  END IF;
  -- Only the operator identity (or the system sentinel, which stamps the same GUC) may WRITE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_bot_provider_switch_write_operator'
      AND polrelid = 'oshal_bot_provider_switch'::regclass
  ) THEN
    CREATE POLICY oshal_bot_provider_switch_write_operator
      ON oshal_bot_provider_switch
      AS PERMISSIVE FOR ALL
      USING (current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;
