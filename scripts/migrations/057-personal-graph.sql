-- ADR-066: Postgres-backed persistence for the user-owned personal knowledge graph.
-- Mirrors InMemoryGraphStore semantics. Nodes are keyed by their stable deterministic id and
-- edges by their (type,from,to) stable id, so re-ingesting the same source item is an idempotent
-- upsert (sources accumulate + dedup, props merge) rather than a duplicate.
CREATE TABLE IF NOT EXISTS personal_graph_nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  sources    JSONB NOT NULL DEFAULT '[]'::jsonb,
  props      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS personal_graph_edges (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  sources    JSONB NOT NULL DEFAULT '[]'::jsonb,
  props      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS personal_graph_nodes_type_idx ON personal_graph_nodes (type);
CREATE INDEX IF NOT EXISTS personal_graph_edges_from_idx ON personal_graph_edges (from_id);
CREATE INDEX IF NOT EXISTS personal_graph_edges_to_idx   ON personal_graph_edges (to_id);
CREATE INDEX IF NOT EXISTS personal_graph_edges_type_idx ON personal_graph_edges (type);
