/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D2/D6 (slice S1): the swarm rows for the four capabilities (tts, stt, image, video). One row per (scope, capability): scope 'fleet-default' is the swarm default every call falls to when nothing above it governs ("Portal default" to users); an agent-id scope is the administrator's per-bot row, read from slice S3. Mirrors oshal_bot_provider_switch (migration 147): every identity may READ (resolution runs inside user requests and background work alike, and a row holds nothing per-person); only the operator identity, or server work under the system identity, may WRITE, enforced by the table's own FORCE ROW LEVEL SECURITY policy, so a signed-in non-operator's write is refused by Postgres. With no row for a (scope, capability) the swarm default is what config-seed/global-config.json or the existing selector names today, byte for byte. Rows hold provider ids and options (a voice, a model), never a secret; the api validates a provider id against that capability's registry before it writes. No function is created here, so no SECURITY DEFINER helper is added.
 */

-- =============================================================================
-- Migration 183: capability provider swarm rows (ADR-173)
-- The resolver that reads this table lives in src/shared/capability-providers
-- (resolveCapabilityProvider): explicit provider -> the caller's own default ->
-- the 'fleet-default' row here -> the seed (global-config.json or the selector)
-- -> refuse, naming what is missing. Empty at creation: no row = today.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_capability_swarm_rows (
  -- The reserved swarm scope 'fleet-default', or an agent id (an administrator's per-bot row).
  scope_id    TEXT        NOT NULL,
  capability  TEXT        NOT NULL,
  -- A provider id of that capability's registry (gemini-stt, local-stt, google-cloud-tts, ...).
  -- Validated by the api before the write; the CHECK only refuses shapes no validator produces.
  provider_id TEXT        NOT NULL,
  -- Options beside the provider: a voice (text to speech) or a model. Never a secret.
  options     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_by  TEXT        NOT NULL DEFAULT 'operator',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_id, capability),
  CONSTRAINT oshal_capability_swarm_rows_scope CHECK (btrim(scope_id) <> '' AND scope_id !~ '\s'),
  CONSTRAINT oshal_capability_swarm_rows_capability CHECK (capability IN ('tts', 'stt', 'image', 'video')),
  CONSTRAINT oshal_capability_swarm_rows_provider CHECK (btrim(provider_id) <> '' AND provider_id !~ '\s'),
  CONSTRAINT oshal_capability_swarm_rows_options CHECK (jsonb_typeof(options) = 'object')
);

COMMENT ON TABLE oshal_capability_swarm_rows IS
  'ADR-173 swarm rows: per (scope, capability) the provider a capability call falls to. scope_id ''fleet-default'' is the swarm default; an agent id is an administrator''s per-bot row. No row = the provider config-seed/global-config.json or the existing selector names. Readable by every identity, written only by the operator identity or system work (FORCE RLS). Carries no secret.';
COMMENT ON COLUMN oshal_capability_swarm_rows.scope_id IS '''fleet-default'', or the agent id of the bot the row governs; non-blank, no whitespace.';
COMMENT ON COLUMN oshal_capability_swarm_rows.capability IS 'One of tts, stt, image, video.';
COMMENT ON COLUMN oshal_capability_swarm_rows.provider_id IS 'A provider id of that capability''s registry; validated by the api, refused with a reason when unknown.';
COMMENT ON COLUMN oshal_capability_swarm_rows.options IS 'A JSON object: voice (text to speech, a voice that provider lists) and/or model. Never a secret.';
COMMENT ON COLUMN oshal_capability_swarm_rows.updated_by IS 'Who wrote the row: the operator subject from the session that wrote it.';

ALTER TABLE oshal_capability_swarm_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_capability_swarm_rows FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Every identity may READ: resolution runs inside user requests (voice, images) and background
  -- work alike, and a row holds nothing per-person.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_capability_swarm_rows_read_all'
      AND polrelid = 'oshal_capability_swarm_rows'::regclass
  ) THEN
    CREATE POLICY oshal_capability_swarm_rows_read_all
      ON oshal_capability_swarm_rows
      AS PERMISSIVE FOR SELECT
      USING (true);
  END IF;
  -- Only the operator identity (or the system sentinel, which stamps the same GUC) may WRITE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_capability_swarm_rows_write_operator'
      AND polrelid = 'oshal_capability_swarm_rows'::regclass
  ) THEN
    CREATE POLICY oshal_capability_swarm_rows_write_operator
      ON oshal_capability_swarm_rows
      AS PERMISSIVE FOR ALL
      USING (current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;
