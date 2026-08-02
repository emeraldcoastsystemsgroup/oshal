/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream metering: oshal_rca_reservation (durable reserve-before-act budget holds, so a restart mid-burst no longer zeroes reserved spend and a second replica can see them) and oshal_alert_funnel_snapshot (per-stage per-lane volume over time — the surface the absence alarms read).
 */

-- =============================================================================
-- Migration 108: Operations Stream — budget reservations and the funnel
-- =============================================================================

-- ── Reserve-before-act budget holds ──────────────────────────────────────────
-- The gate reads SUM(usd) WHERE released_at IS NULL AND expires_at > now(),
-- added to actuals summed from the cost ledger. Holds were previously an array
-- on one in-process gate instance: a restart mid-burst zeroed reserved spend and
-- a second api process could not see them at all, so the cap was per-process.
CREATE TABLE IF NOT EXISTS oshal_rca_reservation (
  reservation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     UUID REFERENCES oshal_incident(incident_id) ON DELETE SET NULL,
  dedup_key       TEXT NOT NULL DEFAULT '',
  usd             NUMERIC(12, 4) NOT NULL DEFAULT 0,
  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  released_at     TIMESTAMPTZ,
  released_reason TEXT,
  owner_sub       TEXT NOT NULL DEFAULT 'alert:prometheus'
);

-- The gate's hot read. Partial so it stays proportional to LIVE holds, not history.
CREATE INDEX IF NOT EXISTS idx_rca_reservation_live
  ON oshal_rca_reservation (expires_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rca_reservation_dedup
  ON oshal_rca_reservation (dedup_key, reserved_at DESC);

COMMENT ON TABLE oshal_rca_reservation IS
  'Durable budget holds. RETENTION: released or expired rows deleted after 7 days. An expired reservation stops counting immediately via the expires_at predicate — it does not wait for a sweep to run.';

-- ── The funnel ───────────────────────────────────────────────────────────────
-- Volume per stage per lane over time. Every other counter in the system is
-- point-in-time; this is the only historical trend surface, and it is what makes
-- the absence alarms possible.
--
-- THE ALARM THAT MATTERS: a stage at zero while its PREDECESSOR is non-zero.
-- Threshold alerting only ever fires on data, so a dead pipeline produces none —
-- absence detection is the only thing standing between a wedged pipeline and a
-- silent one.
--
-- Per-lane counts come from per-lane queries. Never slice a global total by a
-- label and present the slices as a funnel: the stages stop being sequential and
-- a later stage can appear larger than an earlier one.
CREATE TABLE IF NOT EXISTS oshal_alert_funnel_snapshot (
  snapshot_id    BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT NOT NULL DEFAULT 'alertmanager',
  stage          TEXT NOT NULL,
  count          BIGINT NOT NULL DEFAULT 0,
  window_minutes INTEGER NOT NULL DEFAULT 60
);

CREATE INDEX IF NOT EXISTS idx_alert_funnel_ts
  ON oshal_alert_funnel_snapshot (ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_funnel_stage_ts
  ON oshal_alert_funnel_snapshot (stage, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_funnel_source_stage_ts
  ON oshal_alert_funnel_snapshot (source, stage, ts DESC);

COMMENT ON TABLE oshal_alert_funnel_snapshot IS
  'Per-stage per-lane volume. RETENTION: 90 days. Stage vocabulary: envelopes, events, identity_dropped, noise, claimed, incidents_opened, incidents_reopened, incidents_bundled, tickets_created, dispatch_attempted, dispatch_suppressed, dispatch_failed, actions_applied.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE oshal_rca_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_rca_reservation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_rca_reservation_operator_or_owner ON oshal_rca_reservation;
CREATE POLICY oshal_rca_reservation_operator_or_owner ON oshal_rca_reservation
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );

-- The funnel is aggregate operational telemetry carrying no per-subject data:
-- readable by any authenticated caller, writable by the capture job and operators.
ALTER TABLE oshal_alert_funnel_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_alert_funnel_snapshot FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_alert_funnel_read ON oshal_alert_funnel_snapshot;
DROP POLICY IF EXISTS oshal_alert_funnel_write ON oshal_alert_funnel_snapshot;
CREATE POLICY oshal_alert_funnel_read ON oshal_alert_funnel_snapshot
  FOR SELECT USING (true);
CREATE POLICY oshal_alert_funnel_write ON oshal_alert_funnel_snapshot
  FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR current_setting('oshal.current_sub', true) = 'alert:prometheus'
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR current_setting('oshal.current_sub', true) = 'alert:prometheus'
  );
