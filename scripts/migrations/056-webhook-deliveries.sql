-- ADR-065: cross-replica dedup store for the connector webhook ingress (dbSeenStore).
-- A verified inbound webhook is processed once; replays of the same delivery id are ignored.
CREATE TABLE IF NOT EXISTS oshal_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
