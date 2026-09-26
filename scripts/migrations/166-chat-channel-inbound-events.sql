/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Permanent owner-scoped provider occurrence receipts prevent duplicate bot turns across webhook retries and Gateway reconnects.
 */

CREATE TABLE IF NOT EXISTS channel_inbound_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_sub TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE channel_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_inbound_events FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'channel_inbound_events_owner_or_operator'
      AND polrelid = 'channel_inbound_events'::regclass
  ) THEN
    CREATE POLICY channel_inbound_events_owner_or_operator ON channel_inbound_events
      AS PERMISSIVE FOR ALL
      USING (owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT ON channel_inbound_events TO oshal_app;
  END IF;
END $$;

COMMENT ON TABLE channel_inbound_events IS
  'Permanent provider event claims contain only occurrence IDs and owner subjects. A failed bot turn is not replayed; the caller may send a new message.';
