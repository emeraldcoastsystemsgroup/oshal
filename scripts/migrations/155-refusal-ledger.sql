/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | P1 refusal visibility: durable structured denials with actor/package/target/prepared-execution/remedy context and owner-or-operator row security. No top-level BEGIN/COMMIT; the migration runner owns the transaction.
 */

CREATE TABLE IF NOT EXISTS oshal_refusals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The refusing principal owns visibility. A person sees their own rows; a scheduled system
  -- service is isolated as service:<app>; operators see the whole fleet through the policy.
  code TEXT NOT NULL CHECK (length(btrim(code)) > 0),
  owner_sub TEXT NOT NULL CHECK (length(btrim(owner_sub)) > 0),
  actor_sub TEXT NOT NULL CHECK (length(btrim(actor_sub)) > 0),
  actor_issuer TEXT,
  owning_package TEXT NOT NULL CHECK (length(btrim(owning_package)) > 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('agent','job','route','ticket','tool','other')),
  target TEXT NOT NULL CHECK (length(btrim(target)) > 0),
  prepared_execution_id TEXT,
  remedy TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS oshal_refusals_occurred_at
  ON oshal_refusals (occurred_at DESC);
CREATE INDEX IF NOT EXISTS oshal_refusals_code_occurred_at
  ON oshal_refusals (code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS oshal_refusals_package_target
  ON oshal_refusals (owning_package, target_kind, target);

ALTER TABLE oshal_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_refusals FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'oshal_refusals_owner_or_operator'
       AND polrelid = 'oshal_refusals'::regclass
  ) THEN
    CREATE POLICY oshal_refusals_owner_or_operator ON oshal_refusals
      AS PERMISSIVE FOR ALL
      USING (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END $$;
