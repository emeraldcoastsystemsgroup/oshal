-- 072-trading-strategy-lab.sql
--
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Strategy Lab (ADR-092): persistent strategy variations, persisted backtest/forward/regression runs with full equity curves, and per-strategy forward-walk state. RLS owner-or-operator, matching migration 069's pattern.
--
-- WHY
-- Backtest results were console-only (equity curves computed then discarded) and strategy
-- variations lived in env vars + prose. These tables make variations first-class, keep every
-- run's curve so past configurations chart over time, and hold the forward-walk book so each
-- saved config accrues an out-of-sample curve daily. Matches the runtime bootstrap in
-- src/app/trading-strategy-lab-store.ts (ensureLabSchema).

CREATE TABLE IF NOT EXISTS trading_strategies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config      JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'armed', 'retired')),
  baseline_run_id UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_sub, name)
);
CREATE INDEX IF NOT EXISTS idx_trd_strategies_owner ON trading_strategies (user_sub, status);

CREATE TABLE IF NOT EXISTS trading_strategy_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id  UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
  user_sub     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('backtest', 'forward', 'regression')),
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'drifted', 'failed')),
  feed         TEXT NOT NULL DEFAULT 'sip',
  git_sha      TEXT NOT NULL DEFAULT '',
  window_start DATE,
  window_end   DATE,
  bars         INTEGER NOT NULL DEFAULT 0,
  config_snapshot JSONB NOT NULL,
  metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  equity_curve JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trd_strategy_runs_strategy ON trading_strategy_runs (strategy_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trd_strategy_runs_owner ON trading_strategy_runs (user_sub, created_at DESC);

CREATE TABLE IF NOT EXISTS trading_strategy_state (
  strategy_id  UUID PRIMARY KEY REFERENCES trading_strategies(id) ON DELETE CASCADE,
  user_sub     TEXT NOT NULL,
  as_of        DATE NOT NULL,
  state        JSONB NOT NULL,
  equity_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trd_strategy_state_owner ON trading_strategy_state (user_sub);

ALTER TABLE trading_strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_strategies FORCE ROW LEVEL SECURITY;
ALTER TABLE trading_strategy_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_strategy_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE trading_strategy_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_strategy_state FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['trading_strategies', 'trading_strategy_runs', 'trading_strategy_state'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = t || '_owner_or_operator' AND polrelid = t::regclass
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL '
        || 'USING (user_sub = current_setting(''oshal.current_sub'', true) '
        || '  OR current_setting(''oshal.is_operator'', true) = ''on'') '
        || 'WITH CHECK (user_sub = current_setting(''oshal.current_sub'', true) '
        || '  OR current_setting(''oshal.is_operator'', true) = ''on'')',
        t || '_owner_or_operator', t);
    END IF;
  END LOOP;
END
$$;
