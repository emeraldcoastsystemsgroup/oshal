-- ── tv_token_revocations ──────────────────────────────────────────────────────
-- Durable revocation for the Fire TV / Roku pairing tokens (oshal_tv). Per-user
-- "minimum issued-at" watermark: a signed TV token is rejected when its `iat` is
-- older than min_iat for its user_sub. So "sign out all my TVs" is one upsert
-- (POST /api/tv/pair/revoke). Checked ONLY when a TV token is actually presented
-- (the auth middleware short-circuits for normal session requests), so this adds
-- no cost to the hot path. See src/app/routes/tv-pairing-routes.ts.
CREATE TABLE IF NOT EXISTS tv_token_revocations (
  user_sub    TEXT PRIMARY KEY,
  min_iat     BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
