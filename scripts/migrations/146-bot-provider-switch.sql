/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A bot's LLM provider is a row in a table (operator, 2026-09-17: "it should literally be a switch in a table"). The FLEET-DEFAULT switch: exactly one row, the reserved scope 'fleet-default', so switching the whole fleet is ONE write. The per-bot row is NOT here — it is the existing agent_config record (config_values.providerId / modelId, the record PUT /api/agents/:id/runtime writes and ADR-034 dispatch stamping already carries), so no fourth provider store is added. The table carries no secret — keys stay in the container environment. Readable by every identity (resolution runs in request and background context alike); written only under the operator GUC, enforced by FORCE ROW LEVEL SECURITY so the owning oshal_app role is scoped too. Empty at creation: no row = the registry literal, byte-identically.
 */

-- =============================================================================
-- Migration 146: the fleet-default LLM provider switch row
-- The precedence rule that reads this table lives in
-- src/shared/llm-runtime/bot-provider-switch.ts: per-bot row (agent_config) ->
-- fleet-default row (this table) -> registry literal. No rows = the registry.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_bot_provider_switch (
  -- Only the reserved fleet scope. Per-bot switches live in agent_config.config_values.
  scope_id    TEXT        PRIMARY KEY,
  -- A harness key (codex-cli, claude-code, cline, ...) or a Cline-backed API provider id
  -- (gemini, anthropic, openrouter, ...). Validated by the api before the write; the CHECK
  -- only refuses the shapes no validator would ever produce.
  provider_id TEXT        NOT NULL,
  model_id    TEXT,
  updated_by  TEXT        NOT NULL DEFAULT 'operator',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_bot_provider_switch_scope CHECK (scope_id = 'fleet-default'),
  CONSTRAINT oshal_bot_provider_switch_provider CHECK (
    btrim(provider_id) <> '' AND provider_id !~ '\s' AND lower(provider_id) <> 'auto'
  ),
  CONSTRAINT oshal_bot_provider_switch_model CHECK (model_id IS NULL OR btrim(model_id) <> '')
);

COMMENT ON TABLE oshal_bot_provider_switch IS
  'The fleet-default LLM provider switch: one row, scope_id ''fleet-default''. Per-bot switches are agent_config.config_values.providerId/modelId. Resolved per-bot -> fleet -> registry literal. Carries no secret.';
COMMENT ON COLUMN oshal_bot_provider_switch.scope_id IS 'Always ''fleet-default''; the CHECK refuses anything else.';
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
