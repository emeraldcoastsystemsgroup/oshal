-- =============================================================================
-- Migration 050: Travel Platform schema
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | The "Travel" app data
--              | layer (ADR-059): a SWARM-WIDE anonymized price-observation DB
--              | (the intelligence moat), per-traveller profile/searches/watches,
--              | and the concierge's chat + durable learned preferences. Public
--              | tenant + per-user (OIDC sub) isolation, mirrors the purchasing/
--              | movies pattern.
-- =============================================================================

-- Public tenant every traveller belongs to until an operator carves out more
-- (mirrors shop_tenants / lm_tenants). NOTE: 'c002' is a valid-hex node in the
-- commerce family (c001 = purchasing); 't001'/'v001' would NOT be valid hex.
CREATE TABLE IF NOT EXISTS travel_tenants (
  tenant_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       VARCHAR(64) UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO travel_tenants (tenant_id, slug, name)
  VALUES ('00000000-0000-4000-8000-00000000c002', 'public', 'Public Travellers')
  ON CONFLICT (tenant_id) DO NOTHING;

-- ─── Swarm-wide price observations (THE MOAT) ────────────────────────────────
-- Every search + quote the swarm sees is written here, ANONYMIZED — there is NO
-- user_sub on this table ON PURPOSE (ADR-059 §2): this is market data shared
-- swarm-wide, not personal data. Powers "good price / wait" intelligence, the
-- fare-watch cron, and a network effect that improves for everyone with use.
CREATE TABLE IF NOT EXISTS travel_observations (
  obs_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         VARCHAR(8)  NOT NULL DEFAULT 'flight',  -- flight | hotel | car
  -- A stable, low-cardinality key for the thing being priced, so we can aggregate:
  -- flights = 'JFK-LHR-2026-08-01-economy'; hotels = 'PAR-2026-08-01-2026-08-04';
  -- cars = 'MIA-2026-08-01-2026-08-04-midsize'.
  route_key    VARCHAR(160) NOT NULL,
  origin       VARCHAR(8),                             -- IATA / city code (flights/cars)
  destination  VARCHAR(64),                            -- IATA / city / area
  depart_date  DATE,
  return_date  DATE,
  cabin        VARCHAR(16),                            -- economy | premium | business | first
  carrier      VARCHAR(64),                            -- airline / chain / rental brand (best offer)
  price        NUMERIC(10,2) NOT NULL,
  currency     VARCHAR(8)  NOT NULL DEFAULT 'USD',
  source       VARCHAR(16) NOT NULL DEFAULT 'duffel',  -- duffel | demo
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_obs_route ON travel_observations (route_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_obs_kind ON travel_observations (kind, observed_at DESC);

-- ─── Per-traveller profile (the personal layer) ──────────────────────────────
-- The app-local working set fed into the concierge prompt. The rich/sovereign
-- model is the ADR-057 tri-store vault; this mirrors movies_profile/shop_profile.
CREATE TABLE IF NOT EXISTS travel_profile (
  user_sub          VARCHAR(255) PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT '00000000-0000-4000-8000-00000000c002',
  display_name      TEXT,
  home_airport      VARCHAR(8),                         -- IATA, e.g. 'VPS'
  preferred_airlines TEXT[] NOT NULL DEFAULT '{}',
  preferred_cabin   VARCHAR(16) NOT NULL DEFAULT 'economy',
  seat_pref         VARCHAR(16),                        -- aisle | window | none
  hotel_brands      TEXT[] NOT NULL DEFAULT '{}',
  avoid             TEXT[] NOT NULL DEFAULT '{}',        -- e.g. 'red-eye', 'basic-economy'
  budget_band       VARCHAR(16),                        -- low | mid | high
  loyalty           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {marriott:{tier,points}} (manual until broker)
  notes             TEXT,
  onboarded         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Per-traveller search history ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS travel_searches (
  search_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub     VARCHAR(255) NOT NULL,
  kind         VARCHAR(8)  NOT NULL DEFAULT 'flight',
  route_key    VARCHAR(160) NOT NULL,
  query        JSONB NOT NULL DEFAULT '{}'::jsonb,       -- the raw params searched
  best_price   NUMERIC(10,2),
  currency     VARCHAR(8) DEFAULT 'USD',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_searches_user ON travel_searches (user_sub, created_at DESC);

-- ─── Saved fare watches (the fare-watch cron re-polls these) ─────────────────
CREATE TABLE IF NOT EXISTS travel_watches (
  watch_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub      VARCHAR(255) NOT NULL,
  kind          VARCHAR(8)  NOT NULL DEFAULT 'flight',
  route_key     VARCHAR(160) NOT NULL,
  query         JSONB NOT NULL DEFAULT '{}'::jsonb,      -- enough to re-run the search
  target_price  NUMERIC(10,2),                           -- alert when best <= this (NULL = any drop)
  last_price    NUMERIC(10,2),
  currency      VARCHAR(8) DEFAULT 'USD',
  status        VARCHAR(16) NOT NULL DEFAULT 'active',    -- active | tripped | paused
  last_checked_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_watches_user ON travel_watches (user_sub, status);
CREATE INDEX IF NOT EXISTS idx_travel_watches_active ON travel_watches (status) WHERE status = 'active';

-- ─── Conversations + messages + durable learned prefs ────────────────────────
CREATE TABLE IF NOT EXISTS travel_conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub        VARCHAR(255) NOT NULL,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS travel_messages (
  message_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES travel_conversations(conversation_id) ON DELETE CASCADE,
  user_sub        VARCHAR(255) NOT NULL,
  role            VARCHAR(16) NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS travel_feedback (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub    VARCHAR(255) NOT NULL,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_feedback_user_note ON travel_feedback (user_sub, lower(note));
