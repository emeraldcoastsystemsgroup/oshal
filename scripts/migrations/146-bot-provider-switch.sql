/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A bot's LLM provider is a row in a table (operator, 2026-09-17: "it should literally be a switch in a table"). One row per scope: an agent id for a per-bot switch, or the reserved 'fleet-default' so switching the whole fleet is ONE write. The table carries no secret — keys stay in the container environment. Readable by every identity (resolution runs in request and background context alike); written only under the operator GUC, enforced by FORCE ROW LEVEL SECURITY so the owning oshal_app role is scoped too. Empty at creation: the existing agent_config rows are NOT copied in, because 11 of them on the operator box differ from the registry and copying them would move the fleet at deploy.
 */

-- =============================================================================
-- Migration 146: bot LLM provider switch rows
-- The precedence rule that reads this table lives in
-- src/shared/llm-runtime/bot-provider-switch.ts: per-bot row -> fleet-default row ->
-- registry literal. No rows = the registry, byte-identically.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_bot_provider_switch (
  -- An agent UUID (per-bot switch) or the reserved fleet scope.
  scope_id    TEXT        PRIMARY KEY,
  -- A harness key (codex-cli, claude-code, cline, ...) or a Cline-backed API provider id
  -- (gemini, anthropic, openrouter, ...). Validated by the api before the write; the CHECK
  -- only refuses the shapes no validator would ever produce.
  provider_id TEXT        NOT NULL,
  model_id    TEXT,
  updated_by  TEXT        NOT NULL DEFAULT 'operator',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_bot_provider_switch_scope CHECK (
    scope_id = 'fleet-default'
    OR scope_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT oshal_bot_provider_switch_provider CHECK (
    btrim(provider_id) <> '' AND provider_id !~ '\s' AND lower(provider_id) <> 'auto'
  ),
  CONSTRAINT oshal_bot_provider_switch_model CHECK (model_id IS NULL OR btrim(model_id) <> '')
);

COMMENT ON TABLE oshal_bot_provider_switch IS
  'LLM provider switch rows: scope_id is an agent id (per-bot) or ''fleet-default''. Resolved per-bot -> fleet -> registry literal. Carries no secret.';
COMMENT ON COLUMN oshal_bot_provider_switch.scope_id IS 'Agent UUID, or ''fleet-default'' for the one fleet-wide row.';
COMMENT ON COLUMN oshal_bot_provider_switch.provider_id IS 'Harness key or Cline-backed API provider id; validated by the api, refused with a reason when unknown.';

ALTER TABLE oshal_bot_provider_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_bot_provider_switch FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Every identity may READ: provider resolution runs inside user requests (inline bots, chat)
  -- and background work (dispatch stamping) alike, and the rows hold nothing per-person.
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
