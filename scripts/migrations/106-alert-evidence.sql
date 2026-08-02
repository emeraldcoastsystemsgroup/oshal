/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream evidence: oshal_incident_snapshot (frozen members + traversed subgraph + root candidate at each material moment) and oshal_alert_dispatch (append-only audit of every outbound decision, and the ledger the hourly cap and once-per-identity check are computed from).
 */

-- =============================================================================
-- Migration 106: Operations Stream — snapshots and the dispatch ledger
--
-- WHY THE SNAPSHOT IS MANDATORY, NOT AN OPTIMISATION
-- Events age out at 30 days and topology mutates continuously, so the traversal
-- that produced a grouping CANNOT be re-run later and no workflow may assume it
-- can. The answer is therefore stored, not recomputed. The whole traversed
-- subgraph goes in — nodes, edges, neighbours — because the neighbour set IS
-- the correlation narrative; a bare group id explains nothing after the fact.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_incident_snapshot (
  snapshot_id         BIGSERIAL PRIMARY KEY,
  incident_id         UUID NOT NULL REFERENCES oshal_incident(incident_id) ON DELETE CASCADE,
  taken_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason              TEXT NOT NULL
                        CHECK (reason IN ('ticket-cut', 'membership-change', 'reopen', 'close', 'manual')),

  correlation_engine  TEXT NOT NULL DEFAULT 'none',
  correlation_depth   SMALLINT,
  correlation_version TEXT NOT NULL DEFAULT '',

  members             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- the traversed {nodes[], edges[]} subgraph, stored WHOLE
  topology            JSONB NOT NULL DEFAULT '{}'::jsonb,
  root_candidate      JSONB,
  -- occurrence / member / reopen / dispatch tallies at this instant
  counters            JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_ids           UUID[] NOT NULL DEFAULT '{}',
  ticket_id           TEXT,
  owner_sub           TEXT NOT NULL DEFAULT 'alert:prometheus'
);

CREATE INDEX IF NOT EXISTS idx_incident_snapshot_incident
  ON oshal_incident_snapshot (incident_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_snapshot_ticket
  ON oshal_incident_snapshot (ticket_id)
  WHERE ticket_id IS NOT NULL;

COMMENT ON TABLE oshal_incident_snapshot IS
  'Frozen incident evidence. RETENTION: 365 days — deliberately outlives both the events (30d) and the incident row (180d closed).';

-- ── The dispatch ledger ──────────────────────────────────────────────────────
-- Every outbound decision, attempted or suppressed, succeeded or failed.
--
-- THE BUCKET INVARIANT, asserted by tests/unit/dispatch-bucket-invariant.spec.ts:
--   total = suppressed + (attempted AND success) + (attempted AND NOT success)
-- The three buckets are disjoint AND exhaustive. Dropping the failed bucket is
-- how a surface ends up rendering "10 attempts (0 sent / 0 deduplicated)" for a
-- misconfigured handler — it reads as a display bug while being load-bearing
-- data that is simply not shown.
CREATE TABLE IF NOT EXISTS oshal_alert_dispatch (
  dispatch_id    BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  incident_id    UUID REFERENCES oshal_incident(incident_id) ON DELETE SET NULL,
  dedup_key      TEXT NOT NULL DEFAULT '',
  target_channel TEXT NOT NULL
                   CHECK (target_channel IN ('ticket', 'analysis', 'self-heal', 'notify')),
  action         TEXT NOT NULL
                   CHECK (action IN ('create', 'update', 'reopen', 'close',
                                     'park-budget', 'park-flap', 'restore',
                                     'apply', 'verify')),
  attempted      BOOLEAN NOT NULL DEFAULT true,
  suppressed     BOOLEAN NOT NULL DEFAULT false,
  success        BOOLEAN,
  status_code    INTEGER,
  error          TEXT,
  ticket_id      TEXT,
  ttl_seconds    INTEGER,
  payload        JSONB,
  owner_sub      TEXT NOT NULL DEFAULT 'alert:prometheus',

  -- A row is either suppressed or attempted, never both and never neither.
  CONSTRAINT ck_dispatch_bucket_disjoint CHECK (attempted <> suppressed)
);

CREATE INDEX IF NOT EXISTS idx_alert_dispatch_dedup
  ON oshal_alert_dispatch (dedup_key, at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_incident
  ON oshal_alert_dispatch (incident_id, at DESC);
-- The hourly apply cap and the once-per-identity check read through this one.
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_channel_action
  ON oshal_alert_dispatch (target_channel, action, at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_at
  ON oshal_alert_dispatch (at DESC);

COMMENT ON TABLE oshal_alert_dispatch IS
  'Append-only outbound audit. RETENTION: 180 days. The hourly apply cap and the once-per-identity refusal are COMPUTED from these rows, so both survive a restart and hold across replicas.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['oshal_incident_snapshot', 'oshal_alert_dispatch']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_operator_or_owner', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        USING (
          current_setting('oshal.is_operator', true) = 'on'
          OR owner_sub = current_setting('oshal.current_sub', true)
        )
        WITH CHECK (
          current_setting('oshal.is_operator', true) = 'on'
          OR owner_sub = current_setting('oshal.current_sub', true)
        )
    $p$, t || '_operator_or_owner', t);
  END LOOP;
END $$;
