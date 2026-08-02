/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ensureAlertPipelineSchema — the Operations Stream schema as executable DDL, grouped core/incident/evidence/config-topology/metering and applied in dependency order. Runs once per process so a fresh install or a hot-swapped container reaches a working pipeline without an out-of-band migration step.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'alert-pipeline-schema' });

/**
 * Process-level guard. The DDL is idempotent, but it is also several hundred statements: running
 * it on every store call would put a needless round-trip in front of every write on the hot intake
 * path. One successful application per process is enough — the schema cannot regress underneath a
 * running process without a deploy, and a deploy starts a new one.
 */
let ensured = false;

/**
 * Landing, normalization and failure capture.
 *
 * `oshal_alert_envelope` holds the POST body verbatim, written before anything parses it, which is
 * what makes replay a re-run rather than a reconstruction. `oshal_alert_event` is one normalized
 * alert per row and carries the durable intake decision, so the noise allowlist can be tuned from
 * evidence instead of from a counter that resets with the process. `oshal_alert_deadletter` keeps
 * whatever could not be understood, because malformed input is the only signal that an upstream
 * contract changed.
 *
 * `severity_num` is ordinal AND inverted on purpose: 1 = critical .. 4 = info, so every rule filter
 * reads `severity_num <= N`.
 */
const CORE_DDL = `
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

CREATE TABLE IF NOT EXISTS oshal_alert_event (
  event_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id              UUID REFERENCES oshal_alert_envelope(envelope_id) ON DELETE SET NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  source                   TEXT NOT NULL DEFAULT 'alertmanager',

  fingerprint              TEXT NOT NULL DEFAULT '',

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

  namespace                TEXT,
  container                TEXT,
  instance                 TEXT,
  job                      TEXT,

  envelope_group_key       TEXT,
  receiver                 TEXT,

  dedup_key                TEXT,
  identity_source          TEXT,
  used_fingerprint_fallback BOOLEAN NOT NULL DEFAULT false,

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
`;

/**
 * Consolidation: one incident row per live identity, plus real membership rows.
 *
 * `uq_incident_live` is the load-bearing object here. A partial unique index over `dedup_key`
 * restricted to the live states makes exactly-one-open-incident-per-identity a database guarantee,
 * which is what lets consolidation be a single upsert and lets the mutual exclusion hold across
 * restarts and replicas rather than living in one process's lock.
 *
 * Membership is rows, not a capped array, so composition is an exact join and `members_overflow`
 * records explicitly when the attach cap was hit — auto-close refuses while it is non-zero, since
 * full resolution is unprovable when some members were never written down.
 *
 * The event -> incident foreign key is created here rather than with the event table because this
 * is where its target exists.
 */
const INCIDENT_DDL = `
CREATE TABLE IF NOT EXISTS oshal_incident (
  incident_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  dedup_key              TEXT NOT NULL,
  identity_source        TEXT NOT NULL DEFAULT '',
  incident_label         TEXT NOT NULL DEFAULT '',
  instance_seq           INTEGER NOT NULL DEFAULT 1,
  state                  TEXT NOT NULL DEFAULT 'open'
                           CHECK (state IN ('open', 'resolved', 'closed', 'archived')),

  primary_alertname      TEXT NOT NULL DEFAULT '',
  primary_target         TEXT NOT NULL DEFAULT '',
  claim_rule_id          TEXT,

  severity               TEXT NOT NULL DEFAULT 'warning',
  severity_num           SMALLINT NOT NULL DEFAULT 3,
  priority               TEXT NOT NULL DEFAULT 'medium',

  first_seen             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen              TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count       BIGINT NOT NULL DEFAULT 1,
  member_count           INTEGER NOT NULL DEFAULT 1,
  members_overflow       INTEGER NOT NULL DEFAULT 0,
  reopen_count           INTEGER NOT NULL DEFAULT 0,
  reopened_at            TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  closed_by              TEXT CHECK (closed_by IS NULL OR closed_by IN ('auto', 'operator', 'ticket')),
  recurrence_of          UUID REFERENCES oshal_incident(incident_id),

  correlation_group_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  correlation_engine     TEXT NOT NULL DEFAULT 'none'
                           CHECK (correlation_engine IN ('none', 'same-target', 'graph', 'postgres-cte')),
  correlation_depth      SMALLINT,
  correlation_version    TEXT,
  root_candidate_target  TEXT,
  root_candidate_reason  TEXT,
  root_candidate_ambiguous BOOLEAN NOT NULL DEFAULT false,

  intake_status          TEXT NOT NULL DEFAULT 'backlog',
  flags                  TEXT[] NOT NULL DEFAULT '{}',
  flap_recent            TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
  flap_parked            BOOLEAN NOT NULL DEFAULT false,
  ticket_id              TEXT,

  revision               BIGINT NOT NULL DEFAULT 0,
  owner_sub              TEXT NOT NULL DEFAULT 'alert:prometheus',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_identity_instance
  ON oshal_incident (dedup_key, instance_seq);

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

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_alert_event_incident'
  ) THEN
    ALTER TABLE oshal_alert_event
      ADD CONSTRAINT fk_alert_event_incident
      FOREIGN KEY (incident_id) REFERENCES oshal_incident(incident_id) ON DELETE SET NULL;
  END IF;
END $$;

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
`;

/**
 * Evidence: the frozen snapshot and the outbound ledger.
 *
 * A snapshot is mandatory rather than an optimisation. Events age out at 30 days and topology
 * mutates continuously, so the traversal that produced a grouping cannot be re-run later — the
 * answer is stored, whole, including the traversed nodes and edges, because the neighbour set IS
 * the correlation narrative and a bare group id explains nothing afterwards.
 *
 * `ck_dispatch_bucket_disjoint` keeps the ledger's arithmetic honest: a row is either suppressed or
 * attempted, never both and never neither, so total = suppressed + succeeded + failed always holds
 * and the failed bucket cannot quietly vanish from a summary.
 */
const EVIDENCE_DDL = `
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
  topology            JSONB NOT NULL DEFAULT '{}'::jsonb,
  root_candidate      JSONB,
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

  CONSTRAINT ck_dispatch_bucket_disjoint CHECK (attempted <> suppressed)
);

CREATE INDEX IF NOT EXISTS idx_alert_dispatch_dedup
  ON oshal_alert_dispatch (dedup_key, at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_incident
  ON oshal_alert_dispatch (incident_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_channel_action
  ON oshal_alert_dispatch (target_channel, action, at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_dispatch_at
  ON oshal_alert_dispatch (at DESC);

COMMENT ON TABLE oshal_alert_dispatch IS
  'Append-only outbound audit. RETENTION: 180 days. The hourly apply cap and the once-per-identity refusal are COMPUTED from these rows, so both survive a restart and hold across replicas.';

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
`;

/**
 * Configuration and the topology mirror.
 *
 * Claim rules are rows, so an edit reaches every replica within one poll cycle instead of needing a
 * restart. An empty table means UNCONFIGURED and admits everything — the admin surface says that in
 * words, because an empty list is indistinguishable from a working deny-all.
 *
 * The graph tier is the system of record for topology; these tables are the mirror the pipeline
 * reads, written at decision time so the incident, the correlation it used and the snapshot that
 * freezes it all commit together, and so correlation degrades gracefully when the graph is
 * unreachable. `traverse_via` is the hub gate: without it any two alerts in a large estate connect
 * within two hops through a shared group node and every batch collapses into one component.
 */
const CONFIG_TOPOLOGY_DDL = `
CREATE TABLE IF NOT EXISTS oshal_alert_claim_rule (
  rule_id               TEXT PRIMARY KEY,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  priority              INTEGER NOT NULL DEFAULT 100,

  match_predicate       JSONB NOT NULL DEFAULT '{}'::jsonb,

  identity_fields       TEXT[] NOT NULL DEFAULT ARRAY['target', 'alertname'],
  dedup_ttl_seconds     INTEGER,
  reopen_window_seconds INTEGER,

  intake                TEXT NOT NULL DEFAULT 'inherit'
                          CHECK (intake IN ('auto', 'backlog', 'inherit')),

  autonomy_level        TEXT NOT NULL DEFAULT 'A0'
                          CHECK (autonomy_level IN ('A0', 'A1', 'A2')),

  root_filter           TEXT[],
  correlation_depth     SMALLINT,
  predicate_hash        TEXT NOT NULL DEFAULT '',
  notes                 TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_alert_claim_rule_active
  ON oshal_alert_claim_rule (enabled, priority)
  WHERE enabled;

COMMENT ON TABLE oshal_alert_claim_rule IS
  'Subscriptions as data. RETENTION: permanent (configuration). An EMPTY table means UNCONFIGURED and accepts everything — the admin screen says so in words rather than showing an empty list that looks like a working deny-all.';

CREATE TABLE IF NOT EXISTS oshal_topology_node (
  node_key      TEXT PRIMARY KEY,
  display_name  TEXT,

  kinds         TEXT[] NOT NULL DEFAULT '{}',

  traverse_via  TEXT[],

  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'decommissioned')),
  props         JSONB NOT NULL DEFAULT '{}'::jsonb,

  loader_tag    TEXT NOT NULL DEFAULT 'operator'
                  CHECK (loader_tag IN ('compose', 'operator', 'discovery', 'observed')),
  loader_scope  TEXT NOT NULL DEFAULT '',
  refreshed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topology_node_loader
  ON oshal_topology_node (loader_tag, loader_scope);
CREATE INDEX IF NOT EXISTS idx_topology_node_kinds
  ON oshal_topology_node USING GIN (kinds);

CREATE TABLE IF NOT EXISTS oshal_topology_edge (
  edge_id             BIGSERIAL PRIMARY KEY,
  src_key             TEXT NOT NULL REFERENCES oshal_topology_node(node_key) ON DELETE CASCADE,
  dst_key             TEXT NOT NULL REFERENCES oshal_topology_node(node_key) ON DELETE CASCADE,
  edge_type           TEXT NOT NULL DEFAULT 'depends_on',

  direction_certified BOOLEAN NOT NULL DEFAULT false,

  attrs               JSONB NOT NULL DEFAULT '{}'::jsonb,
  loader_tag          TEXT NOT NULL DEFAULT 'operator'
                        CHECK (loader_tag IN ('compose', 'operator', 'discovery', 'observed')),
  loader_scope        TEXT NOT NULL DEFAULT '',
  refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_topology_edge
  ON oshal_topology_edge (src_key, dst_key, edge_type);
CREATE INDEX IF NOT EXISTS idx_topology_edge_src ON oshal_topology_edge (src_key);
CREATE INDEX IF NOT EXISTS idx_topology_edge_dst ON oshal_topology_edge (dst_key);
CREATE INDEX IF NOT EXISTS idx_topology_edge_loader
  ON oshal_topology_edge (loader_tag, loader_scope);

CREATE TABLE IF NOT EXISTS oshal_topology_loader_run (
  run_id       BIGSERIAL PRIMARY KEY,
  loader_tag   TEXT NOT NULL,
  loader_scope TEXT NOT NULL DEFAULT '',
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  success      BOOLEAN NOT NULL DEFAULT false,
  nodes_upserted INTEGER NOT NULL DEFAULT 0,
  edges_upserted INTEGER NOT NULL DEFAULT 0,
  nodes_swept    INTEGER NOT NULL DEFAULT 0,
  edges_swept    INTEGER NOT NULL DEFAULT 0,
  sweep_refused  BOOLEAN NOT NULL DEFAULT false,
  error        TEXT,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_topology_loader_run
  ON oshal_topology_loader_run (loader_tag, ran_at DESC);

COMMENT ON TABLE oshal_topology_node IS
  'Infrastructure topology mirror. RETENTION: swept only by its own loader, scoped to its own loader_tag, and REFUSED when the sweep would delete 50% or more of that slice. That proportional brake is the only thing between a truncated discovery feed and total topology deletion, after which correlation silently finds nothing forever.';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['oshal_alert_claim_rule', 'oshal_topology_node',
                           'oshal_topology_edge', 'oshal_topology_loader_run']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I FOR SELECT USING (true)
    $p$, t || '_read', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I FOR ALL
        USING (
          current_setting('oshal.is_operator', true) = 'on'
          OR current_setting('oshal.current_sub', true) = 'alert:prometheus'
        )
        WITH CHECK (
          current_setting('oshal.is_operator', true) = 'on'
          OR current_setting('oshal.current_sub', true) = 'alert:prometheus'
        )
    $p$, t || '_write', t);
  END LOOP;
END $$;
`;

/**
 * Metering: durable budget holds and the funnel.
 *
 * The RCA gate reserves before it acts and reads `SUM(usd) WHERE released_at IS NULL AND
 * expires_at > now()`, so a hold survives a restart mid-burst and a second api process sees it —
 * the cap is per-deployment, not per-process. An expired hold stops counting the moment it expires,
 * through the predicate, without waiting for a sweep.
 *
 * The funnel is the only historical trend surface in the pipeline and exists so absence can be
 * alarmed on: threshold alerting only ever fires on data, so a dead pipeline produces none. The
 * alarm that matters is a stage at zero while its predecessor is non-zero.
 */
const METERING_DDL = `
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

CREATE INDEX IF NOT EXISTS idx_rca_reservation_live
  ON oshal_rca_reservation (expires_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rca_reservation_dedup
  ON oshal_rca_reservation (dedup_key, reserved_at DESC);

COMMENT ON TABLE oshal_rca_reservation IS
  'Durable budget holds. RETENTION: released or expired rows deleted after 7 days. An expired reservation stops counting immediately via the expires_at predicate — it does not wait for a sweep to run.';

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
`;

/**
 * The groups in dependency order. Incident tables must exist before the foreign keys in the
 * evidence and metering groups can reference them, and before the event table's incident edge can
 * be added, so the order here is a correctness constraint rather than a presentation choice.
 */
const DDL_GROUPS: ReadonlyArray<readonly [string, string]> = [
  ['core', CORE_DDL],
  ['incident', INCIDENT_DDL],
  ['evidence', EVIDENCE_DDL],
  ['config-topology', CONFIG_TOPOLOGY_DDL],
  ['metering', METERING_DDL],
];

/**
 * @description Apply one DDL group, surfacing which group failed. Postgres runs a multi-statement
 * simple query in one implicit transaction, so a group either lands whole or not at all — a partial
 * group, where a table exists without the index or policy that makes it safe to use, is the failure
 * mode worth ruling out.
 * @param pool - The shared Postgres pool.
 * @param group - Group name, used only to make a failure locatable.
 * @param ddl - The group's statements.
 * @returns Nothing.
 */
async function applyDdlGroup(pool: Pool, group: string, ddl: string): Promise<void> {
  try {
    await pool.query(ddl);
  } catch (error) {
    logger.error(
      { err: error, group, stack: error instanceof Error ? error.stack : undefined },
      'alert pipeline DDL group failed',
    );
    throw error;
  }
}

/**
 * @description Bring the Operations Stream schema up — tables, indexes, constraints and RLS
 * policies — creating whatever is absent and leaving whatever is present untouched. Called on the
 * first store operation so a fresh install, a restored volume or a hot-swapped container reaches a
 * working pipeline on its own; without it the first alert of a new deployment lands on a missing
 * table and is lost at exactly the moment the operator is watching.
 *
 * Every statement is idempotent (CREATE ... IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE
 * POLICY, an existence test before ADD CONSTRAINT), so it is safe to run against a database the
 * migrations already built. It runs at most once per process; a failure leaves the guard clear so
 * the next caller retries rather than proceeding against a half-built schema.
 * @param pool - The shared Postgres pool.
 * @returns Nothing. Rejects with the underlying Postgres error if any group cannot be applied.
 */
export async function ensureAlertPipelineSchema(pool: Pool): Promise<void> {
  if (ensured) return;
  const startedAt = Date.now();
  for (const [group, ddl] of DDL_GROUPS) {
    await applyDdlGroup(pool, group, ddl);
  }
  ensured = true;
  logger.info(
    { groups: DDL_GROUPS.length, durationMs: Date.now() - startedAt },
    'alert pipeline schema ensured',
  );
}
