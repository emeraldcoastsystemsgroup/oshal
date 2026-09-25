/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Durable producer-key receipts for internal alert landing, independent of event retention and protected by the existing pipeline owner/operator boundary.
 */

CREATE TABLE IF NOT EXISTS oshal_alert_producer_receipt (
  owner_sub TEXT NOT NULL,
  source TEXT NOT NULL,
  producer_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  event_id UUID REFERENCES oshal_alert_event(event_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, source, producer_key)
);

COMMENT ON TABLE oshal_alert_producer_receipt IS
  'Permanent internal-producer occurrence receipts. Event retention sets event_id null, never forgets a delivered key. Receipt and event commit atomically; no fabricated transport envelope. Do not purge while the producer can replay the key.';

ALTER TABLE oshal_alert_producer_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_alert_producer_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alert_producer_operator_or_owner ON oshal_alert_producer_receipt;
CREATE POLICY alert_producer_operator_or_owner ON oshal_alert_producer_receipt
  USING (current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true))
  WITH CHECK (current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true));
