-- ─────────────────────────────────────────────────────────────────────────────
-- 044-ticket-queue-reclassification.sql
--
-- project IS a queue. Backfills existing tickets out of the catch-all "Default"
-- bucket into their proper queue (application), so the queue board stops showing
-- everything under "Default".
--
-- Classification (mirrors src/entities/ticket/queue-classification.ts —
-- TICKET_TYPE_TO_QUEUE_ID; KEEP IN SYNC):
--   1. A ticket that already carries a real metadata.queueId (e.g. the chat
--      thread's queue=chat rows, or a user-assigned queue) is LEFT ALONE.
--   2. A user-assigned legacy project (metadata.projectId != 'default') becomes
--      the queue as-is (the project->queue rename — their choice is preserved).
--   3. Everything else is reclassified by ticket_type into its owning app queue.
--
-- queueIdentifier is intentionally NOT written here — resolveCanonicalTicketQueue
-- rebuilds it from queueName on read (dual-read), so we only persist the queue id,
-- name, and workspace slug.
--
-- Idempotent: the WHERE clause skips rows that already have a non-default queueId,
-- so re-running is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

-- Guard: the `tickets` table is created at runtime by ticket-schema.ts, AFTER
-- migrations on a fresh DB. Skip this backfill (nothing to reclassify on a fresh
-- install) rather than throw and abort the chain.
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NULL THEN
    RETURN;
  END IF;

  UPDATE tickets AS t
  SET
    metadata = t.metadata || jsonb_build_object(
      'queueId',       d.queue_id,
      'queueName',     d.queue_name,
      'workspaceSlug', d.queue_id
    ),
    updated_at = NOW()
  FROM (
  SELECT
    ticket_id,
    queue_id,
    initcap(replace(queue_id, '-', ' ')) AS queue_name
  FROM (
    SELECT
      ticket_id,
      CASE
        -- (2) Preserve an explicit, non-default user-assigned project as the queue.
        WHEN COALESCE(NULLIF(metadata->>'projectId', ''), 'default') <> 'default'
          THEN metadata->>'projectId'
        -- (3) Reclassify the "Default" bucket by ticket_type -> owning app queue.
        ELSE CASE ticket_type
          WHEN 'career-application'     THEN 'career-hunter'
          WHEN 'cloud-op'              THEN 'cloud'
          WHEN 'eats'                  THEN 'eats'
          WHEN 'email-summarizer'      THEN 'email-summarizer'
          WHEN 'federal-capture'       THEN 'federal-capture'
          WHEN 'finance-brief'         THEN 'finance'
          WHEN 'home-control'          THEN 'home'
          WHEN 'identity-review'       THEN 'identity'
          WHEN 'incident'              THEN 'intelligent-operations'
          WHEN 'intelligent-processing' THEN 'intelligent-processing'
          WHEN 'build'                 THEN 'oshal-engineering'
          WHEN 'shopping'              THEN 'purchasing'
          WHEN 'rides'                 THEN 'rides'
          WHEN 'security-finding'      THEN 'security-center'
          WHEN 'trading-decision'      THEN 'intelligent-trades'
          WHEN 'youtube-kids-brief'    THEN 'youtube-kids'
          WHEN 'chat'                  THEN 'chat'
          -- Forward-compatible: an unmapped ticket_type becomes a queue of its own name.
          ELSE ticket_type
        END
      END AS queue_id
    FROM tickets
  ) base
) AS d
  WHERE t.ticket_id = d.ticket_id
    AND COALESCE(NULLIF(t.metadata->>'queueId', ''), 'default') = 'default'
    AND d.queue_id IS NOT NULL
    AND d.queue_id <> 'default';
END $$;
