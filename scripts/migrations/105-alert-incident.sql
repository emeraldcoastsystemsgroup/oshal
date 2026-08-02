/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream consolidation: oshal_incident (one row per live identity, with the partial-unique live claim that makes exactly-one-open-incident a database guarantee rather than a process-local lock) and oshal_incident_member (real membership rows, so composition is an exact join instead of a capped array in a JSON blob).
 */

-- =============================================================================
-- Migration 105: Operations Stream — the consolidated incident
--
-- Incident state used to live inside a ticket's metadata JSONB. Two problems
-- that this migration ends:
--   1. Every update was a read-modify-write of the whole blob, so a concurrent
--      writer silently lost the other's update.
--   2. The dedup lookup was a scan over tickets, and membership was a capped
--      array that truncated without saying so.
--
-- The ticket now keeps only a pointer: {incidentId, dedupKey}, written once.
-- =============================================================================

CREATE TABLE IF NOT EXISTS oshal_incident (
  incident_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- identity
  dedup_key              TEXT NOT NULL,
  identity_source        TEXT NOT NULL DEFAULT '',
  incident_label         TEXT NOT NULL DEFAULT '',
  instance_seq           INTEGER NOT NULL DEFAULT 1,
  state                  TEXT NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open', 'resolved', 'closed', 'archived')),

  -- genesis (write-once)
  primary_alertname      TEXT NOT NULL DEFAULT '',
  primary_target         TEXT NOT NULL DEFAULT '',
  claim_rule_id          TEXT,

  -- severity escalates only upward; severity_num is inverted (1 = critical)
  severity               TEXT NOT NULL DEFAULT 'warning',
  severity_num           SMALLINT NOT NULL DEFAULT 3,
  priority               TEXT NOT NULL DEFAULT 'medium',

  -- lifecycle counters
  first_seen             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen              TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count       BIGINT NOT NULL DEFAULT 1,
  member_count           INTEGER NOT NULL DEFAULT 1,
  -- how many members were counted but NOT recorded (the cap was hit). Auto-close
  -- refuses while this is non-zero: full resolution is unprovable when some
  -- members were never written down.
  members_overflow       INTEGER NOT NULL DEFAULT 0,
  reopen_count           INTEGER NOT NULL DEFAULT 0,
  reopened_at            TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  closed_by              TEXT CHECK (closed_by IS NULL OR closed_by IN ('auto', 'operator', 'ticket')),
  recurrence_of          UUID REFERENCES oshal_incident(incident_id),

  -- correlation, recorded so a grouping decision is reproducible from
  -- (engine, version, depth, event set)
  correlation_group_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  correlation_engine     TEXT NOT NULL DEFAULT 'none'
                           CHECK (correlation_engine IN ('none', 'same-target', 'graph', 'postgres-cte')),
  correlation_depth      SMALLINT,
  correlation_version    TEXT,
  root_candidate_target  TEXT,
  root_candidate_reason  TEXT,
  root_candidate_ambiguous BOOLEAN NOT NULL DEFAULT false,

  -- dispatch state
  intake_status          TEXT NOT NULL DEFAULT 'backlog',
  flags                  TEXT[] NOT NULL DEFAULT '{}',
  flap_recent            TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
  flap_parked            BOOLEAN NOT NULL DEFAULT false,
  ticket_id              TEXT,

  -- optimistic concurrency: every field update carries WHERE revision = $n
  revision               BIGINT NOT NULL DEFAULT 0,
  owner_sub              TEXT NOT NULL DEFAULT 'alert:prometheus',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every instance of an identity is addressable...
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_identity_instance
  ON oshal_incident (dedup_key, instance_seq);

-- ...but only ONE may be live at a time. This partial unique index is the
-- exactly-one-open-incident guarantee. It is what lets the consolidation path
-- be a single ON CONFLICT upsert and lets the in-process intake lock be deleted:
-- the database is the mutual exclusion, so it holds across restarts and replicas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_live
  ON oshal_incident (dedup_key)
  WHERE state IN ('open', 'resolved');

CREATE INDEX IF NOT EXISTS idx_incident_state_last_seen
  ON oshal_incident (state, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_incident_correlation_group
  ON oshal_incident (correlation_group_id);
CREATE INDEX IF NOT EXISTS idx_incident_ticket
  ON oshal_incident (ticket_id)
  WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incident_rule_first_seen
  ON oshal_incident (claim_rule_id, first_seen DESC);

COMMENT ON TABLE oshal_incident IS
  'One row per live incident identity. RETENTION: indefinite while open/resolved; closed or archived rows older than 180 days are deleted only AFTER their snapshot rows are confirmed present.';

-- ── Membership ───────────────────────────────────────────────────────────────
-- Which distinct alert identities belong to one consolidated incident, and WHY
-- each attached. Recorded at attach time, so composition is never reconstructed
-- afterwards by a time-window guess.
CREATE TABLE IF NOT EXISTS oshal_incident_member (
  incident_id      UUID NOT NULL REFERENCES oshal_incident(incident_id) ON DELETE CASCADE,
  member_key       TEXT NOT NULL,
  alertname        TEXT NOT NULL DEFAULT '',
  target           TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT 'warning',
  severity_num     SMALLINT NOT NULL DEFAULT 3,
  fingerprint      TEXT,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  attach_reason    TEXT NOT NULL
                     CHECK (attach_reason IN ('genesis', 'same-key', 'same-target', 'dependency')),
  dependency_hops  SMALLINT,
  resolved_at      TIMESTAMPTZ,
  PRIMARY KEY (incident_id, member_key)
);

CREATE INDEX IF NOT EXISTS idx_incident_member_key
  ON oshal_incident_member (member_key);
CREATE INDEX IF NOT EXISTS idx_incident_member_unresolved
  ON oshal_incident_member (incident_id)
  WHERE resolved_at IS NULL;

-- ── The event -> incident edge ───────────────────────────────────────────────
-- Added here rather than in 104 because the target table is created in this file.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_alert_event_incident'
  ) THEN
    ALTER TABLE oshal_alert_event
      ADD CONSTRAINT fk_alert_event_incident
      FOREIGN KEY (incident_id) REFERENCES oshal_incident(incident_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE oshal_incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_incident FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_incident_operator_or_owner ON oshal_incident;
CREATE POLICY oshal_incident_operator_or_owner ON oshal_incident
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );

-- Members inherit their parent's visibility: a member row carries no owner of
-- its own, so the predicate follows the incident it belongs to.
ALTER TABLE oshal_incident_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_incident_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_incident_member_via_parent ON oshal_incident_member;
CREATE POLICY oshal_incident_member_via_parent ON oshal_incident_member
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM oshal_incident i
      WHERE i.incident_id = oshal_incident_member.incident_id
        AND i.owner_sub = current_setting('oshal.current_sub', true)
    )
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM oshal_incident i
      WHERE i.incident_id = oshal_incident_member.incident_id
        AND i.owner_sub = current_setting('oshal.current_sub', true)
    )
  );
