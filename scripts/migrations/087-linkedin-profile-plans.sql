-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user plan for the
--              | LinkedIn Profile Studio: the desired profile shape (headline, about,
--              | skills, custom URL, background image + featured resume asset paths)
--              | plus the approval/dispatch state machine. LinkedIn has NO profile-
--              | edit API, so an APPROVED plan is dispatched to the desktop worker
--              | (linkedin-profile-operator, browser_control MCP) which drives the
--              | operator's real logged-in Chrome and reports back. ONE live plan per
--              | user (UNIQUE user_sub); every read/write is user_sub-scoped.
--              | Idempotent — mirrors ProfilePlanStore.ensureSchema() in
--              | src/features/profile-studio; this file is the canonical DDL.
-- 2 | maintainer@emeraldcoastsystemsgroup.com   | Add photo_path — the
--              | profile photo/headshot (direct upload or picked from the user's
--              | Portrait Studio gallery). Trailing ALTER upgrades tables created
--              | by the earlier same-day build in place.
-- 3 | maintainer@emeraldcoastsystemsgroup.com   | Add monotonic dispatch generations and one-use callback capability bindings so stale, replayed, expired, or mismatched desktop results cannot mutate a later plan.

-- The user's desired LinkedIn profile + lifecycle. `state` is the machine
-- (draft -> approved -> dispatched -> applied | failed; reset returns to draft).
-- Asset paths point into the per-user career store on the api container; trusted
-- dispatch code stages contained regular files into the remote task workspace. `result_note`
-- carries the operator's per-field outcome report (what changed / what blocked).
CREATE TABLE IF NOT EXISTS linkedin_profile_plans (
  id                    SERIAL PRIMARY KEY,
  user_sub              TEXT NOT NULL UNIQUE,
  headline              TEXT NOT NULL DEFAULT '',
  about                 TEXT NOT NULL DEFAULT '',
  skills                JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_url            TEXT NOT NULL DEFAULT '',
  background_image_path TEXT,
  photo_path            TEXT,
  resume_path           TEXT,
  state                 TEXT NOT NULL DEFAULT 'draft',
  dispatch_task_id      TEXT,
  dispatch_client_id    TEXT,
  dispatch_generation   BIGINT NOT NULL DEFAULT 0,
  callback_capability_hash TEXT,
  callback_capability_expires_at TIMESTAMPTZ,
  callback_capability_operation TEXT,
  callback_capability_used_at TIMESTAMPTZ,
  result_note           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linkedin_profile_plans_state
  ON linkedin_profile_plans (state);

-- Upgrade-in-place for tables created before photo_path existed (same-day build).
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS photo_path TEXT;
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS dispatch_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_hash TEXT;
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_expires_at TIMESTAMPTZ;
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_operation TEXT;
ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_used_at TIMESTAMPTZ;
