/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream configuration and topology: oshal_alert_claim_rule (subscriptions as data with live reload and transactional full-reconcile saves) plus oshal_topology_node / oshal_topology_edge (the queryable mirror of the discovered infrastructure graph, carrying the hub gate, direction certification and per-loader provenance).
 */

-- =============================================================================
-- Migration 107: Operations Stream — claim rules and infrastructure topology
--
-- TOPOLOGY OWNERSHIP. The graph tier is the system of record for topology: the
-- discovery bot enumerates each estate and writes nodes and edges there, where
-- variable-depth traversal and connected components are native. These two tables
-- are the MIRROR the pipeline reads: the traversal result is written here at
-- decision time so the incident write, the correlation it used, and the snapshot
-- that freezes it all commit in ONE transaction, and so correlation still
-- degrades gracefully rather than failing when the graph is unreachable.
-- =============================================================================

-- ── Claim rules (the admission gate, as data) ────────────────────────────────
-- Rules used to be read from a file once at process start, so an edit needed a
-- restart and two replicas could disagree. As rows they reload within one poll
-- cycle everywhere.
--
-- SAVE IS A TRANSACTIONAL FULL RECONCILE: upsert the submitted set, then delete
-- every rule_id not in it, in the same transaction. Never skip-if-exists — that
-- silently freezes an edited rule while the surface reports success.
CREATE TABLE IF NOT EXISTS oshal_alert_claim_rule (
  rule_id               TEXT PRIMARY KEY,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  -- deterministic first-match order; ties break on rule_id so evaluation is
  -- reproducible rather than dependent on row order
  priority              INTEGER NOT NULL DEFAULT 100,

  -- {alertname?: text[], labels?: {k: v | v[]}, severityMax?: smallint}
  -- NO time or range predicate is accepted; rejected at save. A freshness clause
  -- inside a matcher is evaluated against the event's own timestamp and silently
  -- kills an entire lane while the rules sit visibly registered.
  match_predicate       JSONB NOT NULL DEFAULT '{}'::jsonb,

  identity_fields       TEXT[] NOT NULL DEFAULT ARRAY['target', 'alertname'],
  dedup_ttl_seconds     INTEGER,
  reopen_window_seconds INTEGER,

  intake                TEXT NOT NULL DEFAULT 'inherit'
                          CHECK (intake IN ('auto', 'backlog', 'inherit')),

  -- THE SWITCH. A0 parks for a human. A1 writes the root cause and the
  -- remediation plan and stops. A2 applies it, bounded. Set per rule.
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

-- ── Topology nodes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oshal_topology_node (
  -- the NORMALIZED target (lowercased, trimmed, trailing :port stripped) so it
  -- joins oshal_alert_event.target directly with no resolver in between
  node_key      TEXT PRIMARY KEY,
  display_name  TEXT,

  -- a node genuinely carries several kinds at once, so every kind match is
  -- CONTAINMENT, never equality
  kinds         TEXT[] NOT NULL DEFAULT '{}',

  -- THE HUB GATE. When non-null, an expansion step may enter this node ONLY
  -- over one of these edge types. This is the highest-leverage precision control
  -- in the traversal: without it any two alerts in a large estate connect within
  -- two hops through a shared group node, every batch collapses into one
  -- component, and the failure presents as "correlation works great".
  traverse_via  TEXT[],

  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'decommissioned')),
  props         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- provenance: which loader owns this row. A loader sweeps ONLY its own slice,
  -- so several independent refreshers are safe on one shared table, and
  -- freshness is self-checkable:
  --   SELECT loader_tag, count(*), max(refreshed_at) FROM ... GROUP BY 1
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

-- ── Topology edges ───────────────────────────────────────────────────────────
-- Directed: src DEPENDS ON dst. Correlation traverses these UNDIRECTED (it wants
-- a superset and must be robust to a reversed arrow); only root-candidate
-- ranking consults direction, and only over certified edges.
CREATE TABLE IF NOT EXISTS oshal_topology_edge (
  edge_id             BIGSERIAL PRIMARY KEY,
  src_key             TEXT NOT NULL REFERENCES oshal_topology_node(node_key) ON DELETE CASCADE,
  dst_key             TEXT NOT NULL REFERENCES oshal_topology_node(node_key) ON DELETE CASCADE,
  edge_type           TEXT NOT NULL DEFAULT 'depends_on',

  -- Root-cause ranking may use ONLY certified edges. Over uncertified ones it
  -- degrades to degree-plus-earliest-alert and labels its output a correlation
  -- hint, never a cause: a directed ranking over unaudited arrows produces
  -- confidently wrong causes, which is worse than producing none.
  direction_certified BOOLEAN NOT NULL DEFAULT false,

  attrs               JSONB NOT NULL DEFAULT '{}'::jsonb,
  loader_tag          TEXT NOT NULL DEFAULT 'operator'
                        CHECK (loader_tag IN ('compose', 'operator', 'discovery', 'observed')),
  loader_scope        TEXT NOT NULL DEFAULT '',
  refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Parallel relationships of DIFFERENT types must not collapse into one edge.
CREATE UNIQUE INDEX IF NOT EXISTS uq_topology_edge
  ON oshal_topology_edge (src_key, dst_key, edge_type);
CREATE INDEX IF NOT EXISTS idx_topology_edge_src ON oshal_topology_edge (src_key);
CREATE INDEX IF NOT EXISTS idx_topology_edge_dst ON oshal_topology_edge (dst_key);
CREATE INDEX IF NOT EXISTS idx_topology_edge_loader
  ON oshal_topology_edge (loader_tag, loader_scope);

-- ── Loader audit ─────────────────────────────────────────────────────────────
-- One durable row per loader run. A failed loader's process is gone by the time
-- anyone looks and its logs go with it, so the run records itself.
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
  -- set when the proportional brake refused a sweep
  sweep_refused  BOOLEAN NOT NULL DEFAULT false,
  error        TEXT,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_topology_loader_run
  ON oshal_topology_loader_run (loader_tag, ran_at DESC);

COMMENT ON TABLE oshal_topology_node IS
  'Infrastructure topology mirror. RETENTION: swept only by its own loader, scoped to its own loader_tag, and REFUSED when the sweep would delete 50% or more of that slice. That proportional brake is the only thing between a truncated discovery feed and total topology deletion, after which correlation silently finds nothing forever.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Topology and claim rules are shared operational configuration: readable by any
-- authenticated caller, writable only by an operator.
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
