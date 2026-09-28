-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Keep Jarvis calling disabled until each owner selects a connected Twilio account and explicitly opts in.
-- 2   | maintainer@emeraldcoastsystemsgroup.com   | Change Log brought to the standard block format; no schema change.

CREATE TABLE IF NOT EXISTS jarvis_calling_settings (
  user_sub TEXT PRIMARY KEY,
  connection_id UUID,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  transfer_phone TEXT,
  max_minutes INTEGER NOT NULL DEFAULT 20 CHECK (max_minutes BETWEEN 1 AND 60),
  max_cost_cents INTEGER NOT NULL DEFAULT 500 CHECK (max_cost_cents BETWEEN 100 AND 50000),
  consented_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT jarvis_calling_enabled_requires_setup CHECK (
    NOT enabled OR (connection_id IS NOT NULL AND transfer_phone IS NOT NULL AND consented_at IS NOT NULL)
  ),
  CONSTRAINT jarvis_calling_phone_format CHECK (
    transfer_phone IS NULL OR transfer_phone ~ '^\+[1-9][0-9]{6,14}$'
  )
);

ALTER TABLE jarvis_calling_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE jarvis_calling_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jarvis_calling_settings_owner_or_operator ON jarvis_calling_settings;
CREATE POLICY jarvis_calling_settings_owner_or_operator ON jarvis_calling_settings
  USING (user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on')
  WITH CHECK (user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on');
