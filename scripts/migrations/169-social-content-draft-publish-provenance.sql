-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | LinkedIn drafts record what their publish produced. `published_post_id` is the post id LinkedIn returned; `publish_params_hash` is the sha256 of the canonical connector params the publish sent, the same value the connector write-action executor writes to connector_action_audit.params_hash. A draft then joins its own audit rows on (user_sub, params_hash) without widening the shared, append-only audit table. Mirrored by ContentDraftStore.ensureSchema for a box that has not applied this file.

-- Migration 085 creates the table, and ContentDraftStore creates it lazily on a box that has
-- never applied 085. Skip rather than abort when it is absent: the runtime DDL mirror adds both
-- columns when it creates the table.
DO $$
BEGIN
  IF to_regclass('public.social_content_drafts') IS NULL THEN
    RAISE NOTICE '169: social_content_drafts absent - skipped (ContentDraftStore.ensureSchema adds these columns)';
    RETURN;
  END IF;
  ALTER TABLE social_content_drafts ADD COLUMN IF NOT EXISTS published_post_id TEXT;
  ALTER TABLE social_content_drafts ADD COLUMN IF NOT EXISTS publish_params_hash TEXT;
END $$;
