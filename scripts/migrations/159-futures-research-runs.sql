-- ADR-116 bounded futures research run history. A negative study is retained as evidence;
-- this table cannot place an order or promote a strategy. Runtime bootstrap mirrors this shape.
CREATE TABLE IF NOT EXISTS oshal_trading_futures_research_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  status TEXT NOT NULL,
  config JSONB NOT NULL,
  markets JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS oshal_futures_one_running_run
  ON oshal_trading_futures_research_runs (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS oshal_futures_runs_owner_created
  ON oshal_trading_futures_research_runs (owner_sub, created_at DESC);

ALTER TABLE oshal_trading_futures_research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_futures_research_runs FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_trading_futures_research_runs_owner_or_operator'
      AND polrelid = 'oshal_trading_futures_research_runs'::regclass
  ) THEN
    CREATE POLICY oshal_trading_futures_research_runs_owner_or_operator
      ON oshal_trading_futures_research_runs AS PERMISSIVE FOR ALL
      USING (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
  IF to_regrole('oshal_app') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_trading_futures_research_runs TO oshal_app';
  END IF;
END $$;
