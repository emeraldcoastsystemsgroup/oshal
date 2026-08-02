/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream core intake: oshal_alert_envelope (the verbatim webhook body, the replay source), oshal_alert_event (one normalized alert per row, carrying the dedup identity and the durable intake decision), and oshal_alert_deadletter (anything unparseable or unprocessable). Tier-1 RLS with the alert:prometheus machine owner. Retention is declared here at creation, not bolted on later.
 */

-- =============================================================================
-- Migration 104: Operations Stream — lossless landing and the normalized event
--
-- The intake used to canonicalize an alert in a request-handler local and throw
-- it away, so an alert that failed mid-processing left no trace and nothing was
-- ever replayable. These three tables make arrival, understanding and failure
-- all durable and independently queryable.
--
-- Idempotent + re-runnable: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP POLICY IF EXISTS. Mirrored by ensureAlertPipelineSchema() in
-- src/features/alert-pipeline so a fresh install or a hot-swap self-heals.
-- =============================================================================

-- ── The verbatim POST body ───────────────────────────────────────────────────
-- One row per webhook delivery, stored BEFORE anything parses it. `body` is the
-- exact JSON the sender sent, which is what makes replay real rather than a
-- reconstruction: a normalization bug becomes a re-run, not data loss.
CREATE TABLE IF NOT EXISTS oshal_alert_envelope (
  envelope_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source             TEXT NOT NULL DEFAULT 'alertmanager',
  receiver           TEXT,
  envelope_status    TEXT,
  group_key          TEXT,
  external_url       TEXT,
  alert_count        INTEGER NOT NULL DEFAULT 0,
  truncated_alerts   INTEGER NOT NULL DEFAULT 0,
  body               JSONB NOT NULL,
  remote_addr        TEXT,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  expanded_count     INTEGER NOT NULL DEFAULT 0,
  normalize_error    TEXT,
  replayed_from      UUID REFERENCES oshal_alert_envelope(envelope_id),
  owner_sub          TEXT NOT NULL DEFAULT 'alert:prometheus'
);

CREATE INDEX IF NOT EXISTS idx_alert_envelope_received
  ON oshal_alert_envelope (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_envelope_source_received
  ON oshal_alert_envelope (source, received_at DESC);

COMMENT ON TABLE oshal_alert_envelope IS
  'Verbatim webhook deliveries. RETENTION: 7 days. Above ~50k/day switch to daily RANGE partitions on received_at and DROP PARTITION instead of DELETE.';

-- ── The normalized alert ─────────────────────────────────────────────────────
-- One row per alert in the envelope's alerts[]. This is the shape every stage
-- downstream reads, and the durable record of EVERY intake decision — including
-- the ones that used to exist only as an in-process counter that reset with the
-- api process, which is why the noise allowlist could never be tuned from
-- evidence.
--
-- severity_num is ORDINAL AND INVERTED ON PURPOSE: 1 = critical .. 4 = info, so
-- every rule filter reads `severity_num <= N`. A `>=` filter selects info-only.
CREATE TABLE IF NOT EXISTS oshal_alert_event (
  event_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id              UUID REFERENCES oshal_alert_envelope(envelope_id) ON DELETE SET NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  source                   TEXT NOT NULL DEFAULT 'alertmanager',

  -- upstream identity (evidence only — never authoritative for dedup)
  fingerprint              TEXT NOT NULL DEFAULT '',

  -- the two halves of the dedup identity
  alertname                TEXT NOT NULL DEFAULT '',
  target                   TEXT NOT NULL DEFAULT '',
  target_kind              TEXT,

  severity                 TEXT NOT NULL DEFAULT 'warning',
  severity_num             SMALLINT NOT NULL DEFAULT 3
                             CHECK (severity_num BETWEEN 1 AND 4),
  status                   TEXT NOT NULL DEFAULT 'firing'
                             CHECK (status IN ('firing', 'resolved')),
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  generator_url            TEXT,

  labels                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotations              JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary                  TEXT,

  -- promoted label columns so list reads never parse JSONB
  namespace                TEXT,
  container                TEXT,
  instance                 TEXT,
  job                      TEXT,

  -- the source's own batching identity, carried verbatim. Deliberately named
  -- apart from any correlation grouping: conflating the two layers is how a
  -- grouping question gets answered with the wrong layer's number.
  envelope_group_key       TEXT,
  receiver                 TEXT,

  -- the consolidation identity (one canonical home, one writer)
  dedup_key                TEXT,
  identity_source          TEXT,
  used_fingerprint_fallback BOOLEAN NOT NULL DEFAULT false,

  -- the durable intake decision
  claim_decision           TEXT NOT NULL DEFAULT 'pending'
                             CHECK (claim_decision IN (
                               'pending', 'created', 'consolidated', 'bundled',
                               'reopened', 'resolved', 'noise', 'dropped', 'failed')),
  claimed_by_rule          TEXT,
  unclaimed_reason         TEXT
                             CHECK (unclaimed_reason IS NULL OR unclaimed_reason IN (
                               'no_identity', 'no_rule_match', 'rule_disabled',
                               'unknown_source', 'identity_empty')),
  incident_id              UUID,

  attempts                 SMALLINT NOT NULL DEFAULT 0,
  last_error               TEXT,
  processed_at             TIMESTAMPTZ,
  owner_sub                TEXT NOT NULL DEFAULT 'alert:prometheus'
);

CREATE INDEX IF NOT EXISTS idx_alert_event_dedup
  ON oshal_alert_event (dedup_key, received_at DESC);
-- The pump's claim scan. Partial so it stays small no matter how deep history goes.
CREATE INDEX IF NOT EXISTS idx_alert_event_pending
  ON oshal_alert_event (received_at)
  WHERE claim_decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_alert_event_incident
  ON oshal_alert_event (incident_id)
  WHERE incident_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alert_event_alertname
  ON oshal_alert_event (alertname, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_event_fingerprint
  ON oshal_alert_event (fingerprint);
CREATE INDEX IF NOT EXISTS idx_alert_event_source
  ON oshal_alert_event (source, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_event_labels
  ON oshal_alert_event USING GIN (labels);

COMMENT ON TABLE oshal_alert_event IS
  'Normalized alerts, one row per alert. RETENTION: 30 days — the analysis horizon. Anything longer lives in oshal_incident_snapshot and oshal_alert_funnel_snapshot, never in the event firehose.';

-- ── What could not be understood ─────────────────────────────────────────────
-- Malformed input is never silently discarded: it is the only evidence an
-- upstream contract changed, and it is what the admin replay reads.
CREATE TABLE IF NOT EXISTS oshal_alert_deadletter (
  deadletter_id  BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage          TEXT NOT NULL
                   CHECK (stage IN ('ingest', 'normalize', 'claim', 'consolidate', 'dispatch')),
  envelope_id    UUID,
  event_id       UUID,
  failure_reason TEXT NOT NULL,
  error          TEXT,
  raw            JSONB,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  replayed_at    TIMESTAMPTZ,
  owner_sub      TEXT NOT NULL DEFAULT 'alert:prometheus'
);

CREATE INDEX IF NOT EXISTS idx_alert_deadletter_at
  ON oshal_alert_deadletter (at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deadletter_open
  ON oshal_alert_deadletter (stage, at DESC)
  WHERE replayed_at IS NULL;

COMMENT ON TABLE oshal_alert_deadletter IS
  'Unparseable or unprocessable intake. RETENTION: 30 days — long enough to notice and diagnose a broken producer, short enough that it cannot fill the disk.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- These are machine-owned operational records: the alert intake carries no user
-- identity, so it writes under the alert:prometheus synthetic owner. Reads are
-- operator-gated; writes require the owning connection. Same shape as the
-- derived-owner policies in migration 094.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['oshal_alert_envelope', 'oshal_alert_event', 'oshal_alert_deadletter']
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
