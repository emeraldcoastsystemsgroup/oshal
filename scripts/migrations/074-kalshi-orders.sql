-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Kalshi order audit trail (ADR-094 Phase 2): every order placed through OSHAL, with the evaluated hand snapshot that justified it — a bet with no recorded justification is unrepresentable, mirroring ADR-052's decision-FK principle. env column records demo|live at placement time; grading joins snapshots to settlements later.

CREATE TABLE IF NOT EXISTS kalshi_orders (
  id                BIGSERIAL PRIMARY KEY,
  user_sub          TEXT        NOT NULL,
  env               TEXT        NOT NULL,             -- demo | live (detected at placement)
  ticker            TEXT        NOT NULL,
  side              TEXT        NOT NULL,             -- yes | no
  action            TEXT        NOT NULL,             -- buy | sell
  count             INTEGER     NOT NULL,
  limit_price_cents INTEGER     NOT NULL,
  client_order_id   TEXT        NOT NULL UNIQUE,      -- idempotency key sent to Kalshi
  kalshi_order_id   TEXT,
  kalshi_status     TEXT,                             -- resting | executed | canceled | rejected...
  hand_snapshot     JSONB,                            -- the BetHand that justified the order (null = manual)
  error             TEXT,                             -- exchange rejection detail when placement failed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kalshi_orders_user ON kalshi_orders (user_sub, created_at DESC);
