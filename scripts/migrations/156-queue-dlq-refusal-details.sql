-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Preserve the reviewed remedy for deterministic dispatch refusals. Migration 081 already provides reason and last_error for the exact refusal code and message.

-- Existing poison-cycle rows remain valid with a NULL remedy. A deterministic refusal writes
-- reason, last_error, and remedy in the same transaction that terminalizes the ticket and task.
ALTER TABLE oshal_queue_dlq
  ADD COLUMN IF NOT EXISTS remedy TEXT;

COMMENT ON COLUMN oshal_queue_dlq.remedy IS
  'Reviewed remedy attached to that exact refusal, when one is proven.';
