-- =============================================================================
-- Migration 085: LinkedIn AI Content Assistant drafts (social north-star)
-- -----------------------------------------------------------------------------
-- DATE         | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user store for the
--              | orchestrated LinkedIn content flow (topic -> social-writer draft ->
--              | quality-judge score -> one refine pass under the bar -> pending-
--              | approval -> approve/schedule -> publish/reject). Keyed by OIDC sub;
--              | a draft is personal content so every read/write is user_sub-scoped
--              | (NOT operator-visible). Idempotent — mirrors ContentDraftStore
--              | .ensureSchema() in src/features/linkedin-assistant so a fresh DB
--              | works without a manual migration step; this file is the canonical DDL.
-- =============================================================================

-- One drafted LinkedIn post and its lifecycle. `state` is the five-step machine
-- (draft -> pending-approval -> scheduled -> published | rejected); `dimensions`
-- holds the quality-judge per-criterion breakdown; `scheduled_for` is set only at
-- approval; `publish_error` carries the last user-visible publish skip (e.g. "connect
-- LinkedIn") without failing the row.
CREATE TABLE IF NOT EXISTS social_content_drafts (
  id            SERIAL PRIMARY KEY,
  user_sub      TEXT NOT NULL,
  topic         TEXT NOT NULL,
  goal          TEXT,
  tone          TEXT,
  source_url    TEXT,
  body          TEXT NOT NULL DEFAULT '',
  score         INT,
  dimensions    JSONB NOT NULL DEFAULT '{}'::jsonb,
  judge_mode    TEXT,
  rationale     TEXT,
  refined       BOOLEAN NOT NULL DEFAULT false,
  state         TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','pending-approval','scheduled','published','rejected')),
  scheduled_for TIMESTAMPTZ,
  publish_error TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The surface lists a user's drafts by state, newest first.
CREATE INDEX IF NOT EXISTS idx_social_content_drafts_user_state
  ON social_content_drafts (user_sub, state, updated_at DESC);
