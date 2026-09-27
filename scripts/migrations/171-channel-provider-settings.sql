-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Operator-level chat-channel provider settings, so a Discord bot token can be saved from the cockpit instead of an .env edit plus an api container recreate. One row per provider: whether the provider is enabled, the bot secret encrypted at rest with the connector-token cipher (never plaintext), and the metadata Discord reported for the token (application id, bot user id and name, the Message Content intent flag). Operator-only under forced row-level security: only a connection stamped oshal.is_operator = on (an operator request, or boot code under the system identity) can read or write a row. Mirrored by ChannelProviderSettingsStore.ensureSchema for a box that has not applied this file.

CREATE TABLE IF NOT EXISTS channel_provider_settings (
  provider TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  secret_ciphertext TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE channel_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_provider_settings FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'channel_provider_settings_operator_only'
      AND polrelid = 'channel_provider_settings'::regclass
  ) THEN
    CREATE POLICY channel_provider_settings_operator_only ON channel_provider_settings
      AS PERMISSIVE FOR ALL
      USING (current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON channel_provider_settings TO oshal_app;
  END IF;
END $$;

COMMENT ON TABLE channel_provider_settings IS
  'Operator-level chat-channel provider configuration. secret_ciphertext is the provider bot token under the connector-token cipher; it is never stored or logged in plaintext.';
