-- 073-trading-lab-notes-overrides.sql
--
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Strategy Library (ADR-095): per-strategy notes/lessons-learned journal + per-user live-config overrides so an armed lab strategy can drive part or all of the profile (revertible; env stays the default). RLS owner-or-operator, matching migration 072's pattern.
--
-- WHY
-- (1) Strategies carried only a 500-char description — the operator asked for dated notes and
--     lessons learned on each tested configuration (the strategy-log narrative, queryable per row).
-- (2) The live autopilot's knobs lived ONLY in env vars; there was no mechanism to switch the
--     profile onto a saved lab strategy from the UI. trading_config_overrides holds one ACTIVE
--     override per user (history preserved via active=false rows) that the dispatch overlay reads
--     before falling back to env. Matches the runtime bootstrap in
--     src/app/trading-config-overrides.ts (ensureOverridesSchema) and the notes bootstrap in
--     src/app/trading-strategy-lab-store.ts (ensureLabSchema).

CREATE TABLE IF NOT EXISTS trading_strategy_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
  user_sub    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'lesson', 'decision')),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trd_strategy_notes_strategy ON trading_strategy_notes (strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trd_strategy_notes_owner ON trading_strategy_notes (user_sub);

CREATE TABLE IF NOT EXISTS trading_config_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub       TEXT NOT NULL,
  strategy_id    UUID REFERENCES trading_strategies(id) ON DELETE SET NULL,
  strategy_name  TEXT NOT NULL,
  config         JSONB NOT NULL,
  apply_pct      INTEGER NOT NULL DEFAULT 100 CHECK (apply_pct BETWEEN 1 AND 100),
  active         BOOLEAN NOT NULL DEFAULT true,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);
-- One ACTIVE override per user; deactivated rows remain as the apply/revert audit history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_cfg_override_one_active ON trading_config_overrides (user_sub) WHERE active;
CREATE INDEX IF NOT EXISTS idx_trd_cfg_override_owner ON trading_config_overrides (user_sub, created_at DESC);

ALTER TABLE trading_strategy_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_strategy_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE trading_config_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_config_overrides FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['trading_strategy_notes', 'trading_config_overrides'] LOOP
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
