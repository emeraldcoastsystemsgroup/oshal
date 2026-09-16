/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-20: record the side effects of working a landed alert event, once per event, so a claim that rolls back after the handler's pool writes committed and then re-drains the event is a no-op instead of a second delivery. Same operator-or-owner RLS as the other alert tables (migration 104). Mirrored in alert-pipeline-schema.ts. No top-level BEGIN/COMMIT: the runner owns the transaction (tests/unit/migration-transactionality.spec.ts).
 */

-- =============================================================================
-- Migration 141: side effects of a landed alert event, applied once per event
--
-- WHAT BROKE (BUG-20, reproduced 2026-09-14)
--   withPendingEvents claims events FOR UPDATE SKIP LOCKED and works them inside
--   the claim transaction, but the handler's incident, member and dispatch writes
--   go through the pool: they commit on their own. When the claim rolled back
--   after them, the event returned to pending and the next drain worked it again
--   - occurrence 2 for one delivery, a second member count, a second dispatch row.
--
-- THE FIX: an idempotent consumer keyed on the event's identity
--   Every side effect of working an event records (event_id, effect) in the same
--   statement or transaction as the write it performs, and working an event starts
--   by reading which effects are already recorded. The claim's row lock on the
--   event serializes that read-then-apply for any one event; this primary key is the
--   backstop - a duplicate record is a violation that rolls its write back.
--
-- RETENTION: follows oshal_alert_event (ON DELETE CASCADE).
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_alert_event_effect (
  event_id   UUID        NOT NULL REFERENCES oshal_alert_event (event_id) ON DELETE CASCADE,
  effect     TEXT        NOT NULL
             CHECK (effect IN ('intake', 'consolidate', 'member') OR effect ~ '^dispatch:[a-z][a-z-]*$'),
  owner_sub  TEXT        NOT NULL,
  detail     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, effect)
);

COMMENT ON TABLE oshal_alert_event_effect IS
  'BUG-20: each side effect of working a landed alert event, recorded once per event with what a replay needs to reproduce its result. RETENTION: follows oshal_alert_event (ON DELETE CASCADE).';

ALTER TABLE oshal_alert_event_effect ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_alert_event_effect FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_alert_event_effect_operator_or_owner ON oshal_alert_event_effect;
CREATE POLICY oshal_alert_event_effect_operator_or_owner ON oshal_alert_event_effect
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );
