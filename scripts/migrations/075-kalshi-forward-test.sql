-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Forward test (ADR-094): the pre-registration ledger. Every prediction is written BEFORE the outcome is known and graded after settlement — this is what makes strategy search science instead of data dredging. Also logs (forecast, actual) pairs, which ARE the forecast-error model the weather strategy depends on (NWS publishes no forecast archive, so the model can only be collected forward).

-- One row per (strategy, market) prediction, written BEFORE settlement. The unique constraint is
-- the anti-dredging guard: a prediction can never be silently revised once reality is known.
CREATE TABLE IF NOT EXISTS kalshi_predictions (
  id                BIGSERIAL PRIMARY KEY,
  strategy          TEXT        NOT NULL,          -- 'weather-enso' | 'calibration' | ...
  ticker            TEXT        NOT NULL,
  event_ticker      TEXT,
  series_ticker     TEXT,
  -- What we believed, when we believed it.
  predicted_prob    NUMERIC(6,5) NOT NULL,         -- our P(YES)
  market_prob       NUMERIC(6,5) NOT NULL,         -- market's P(YES) (ask) at prediction time
  edge_net          NUMERIC(6,5) NOT NULL,         -- predicted_prob - (ask + fee)
  stake_fraction    NUMERIC(6,5) NOT NULL DEFAULT 0,
  side              TEXT        NOT NULL,          -- yes | no
  rationale         JSONB,                         -- model inputs (forecast, sigma, ENSO phase...)
  -- Did we actually paper-trade it?
  paper_traded      BOOLEAN     NOT NULL DEFAULT false,
  kalshi_order_id   TEXT,
  -- Filled in at grading time, never before.
  settled           BOOLEAN     NOT NULL DEFAULT false,
  settled_yes       BOOLEAN,
  brier             NUMERIC(8,6),                  -- (predicted_prob - outcome)^2; lower is better
  market_brier      NUMERIC(8,6),                  -- the market's Brier on the same market — the bar to beat
  pnl_per_contract  NUMERIC(8,4),                  -- realized $ per contract if the bet were taken
  graded_at         TIMESTAMPTZ,
  close_time        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kalshi_prediction UNIQUE (strategy, ticker)
);

CREATE INDEX IF NOT EXISTS idx_kalshi_pred_ungraded ON kalshi_predictions (settled, close_time);
CREATE INDEX IF NOT EXISTS idx_kalshi_pred_strategy ON kalshi_predictions (strategy, created_at DESC);

-- (forecast, actual) pairs — the empirical forecast-error distribution, conditioned on ENSO.
-- NWS publishes no forecast archive, so this table can only be grown FORWARD. It is the moat:
-- the longer it runs, the better the weather model's uncertainty estimate becomes.
CREATE TABLE IF NOT EXISTS kalshi_forecast_log (
  id             BIGSERIAL PRIMARY KEY,
  series_ticker  TEXT        NOT NULL,
  target_date    DATE        NOT NULL,
  lead_days      INTEGER     NOT NULL,
  enso_phase     TEXT        NOT NULL,             -- el-nino | neutral | la-nina
  oni            NUMERIC(4,2),
  forecast_f     NUMERIC(5,1) NOT NULL,
  actual_f       NUMERIC(5,1),                     -- null until the day is observed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kalshi_forecast UNIQUE (series_ticker, target_date, lead_days)
);

CREATE INDEX IF NOT EXISTS idx_kalshi_forecast_cell ON kalshi_forecast_log (series_ticker, lead_days, enso_phase) WHERE actual_f IS NOT NULL;
