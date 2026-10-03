/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D2/D4 (slice S1b): the provider-offer table, one row per (capability, provider). It holds the unit price an operator sets for recording spend (USD per character for text to speech, per audio second for speech to text, per image, per video second), never a literal in code; an optional quota label the options list shows ("a shared free tier"); and who a user-written choice may name the provider for (offered_to: operator, everyone or nobody; NULL means the class default D4 names — swarm-paid to the operator only — and nothing reads it before slice S2, which adds the grant control and its enforcement). Same read and write policy as the swarm rows (migration 183): every identity reads, only the operator identity or system work writes, enforced by FORCE ROW LEVEL SECURITY. No row = no price set and the class default offer: a call is still recorded, as a zero-amount row, and the api log line names it unpriced. No function is created here.
 */

-- =============================================================================
-- Migration 184: capability provider offers (ADR-173)
-- Read by the capability row snapshot (src/shared/capability-providers) and the
-- spend recorder (src/features/capability-providers): the amount of one call is
-- its units times unit_price_usd. Empty at creation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_capability_provider_offers (
  capability     TEXT          NOT NULL,
  provider_id    TEXT          NOT NULL,
  -- Who a USER-written choice may name this provider for (D4). NULL = the class default.
  offered_to     TEXT,
  -- USD per unit: characters (tts), audio seconds (stt), images (image), video seconds (video).
  unit_price_usd NUMERIC(14,8),
  -- A label the options list shows beside the provider, e.g. a shared free-tier quota.
  quota_label    TEXT,
  updated_by     TEXT          NOT NULL DEFAULT 'operator',
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (capability, provider_id),
  CONSTRAINT oshal_capability_provider_offers_capability CHECK (capability IN ('tts', 'stt', 'image', 'video')),
  CONSTRAINT oshal_capability_provider_offers_provider CHECK (btrim(provider_id) <> '' AND provider_id !~ '\s'),
  CONSTRAINT oshal_capability_provider_offers_offered_to CHECK (offered_to IS NULL OR offered_to IN ('operator', 'everyone', 'nobody')),
  CONSTRAINT oshal_capability_provider_offers_price CHECK (unit_price_usd IS NULL OR unit_price_usd >= 0),
  CONSTRAINT oshal_capability_provider_offers_quota_label CHECK (quota_label IS NULL OR (btrim(quota_label) <> '' AND length(quota_label) <= 120))
);

COMMENT ON TABLE oshal_capability_provider_offers IS
  'ADR-173 offers: per (capability, provider) the unit price spend is recorded at, an optional quota label, and who a user-written choice may name it for. Readable by every identity, written only by the operator identity or system work (FORCE RLS). Carries no secret.';
COMMENT ON COLUMN oshal_capability_provider_offers.unit_price_usd IS 'USD per unit: per character (tts), per audio second (stt), per image, per video second. NULL = no price set: the call is recorded as a zero-amount row, and the api log line names it unpriced.';
COMMENT ON COLUMN oshal_capability_provider_offers.offered_to IS 'operator, everyone or nobody: who a user-written choice may name the provider for (ADR-173 D4). NULL = the class default (swarm-paid: the operator only). Enforced from slice S2.';
COMMENT ON COLUMN oshal_capability_provider_offers.quota_label IS 'Shown beside the provider in the options list, e.g. a shared free-tier quota. At most 120 characters.';

ALTER TABLE oshal_capability_provider_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_capability_provider_offers FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_capability_provider_offers_read_all'
      AND polrelid = 'oshal_capability_provider_offers'::regclass
  ) THEN
    CREATE POLICY oshal_capability_provider_offers_read_all
      ON oshal_capability_provider_offers
      AS PERMISSIVE FOR SELECT
      USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_capability_provider_offers_write_operator'
      AND polrelid = 'oshal_capability_provider_offers'::regclass
  ) THEN
    CREATE POLICY oshal_capability_provider_offers_write_operator
      ON oshal_capability_provider_offers
      AS PERMISSIVE FOR ALL
      USING (current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;
