/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 018: Add ticket_type column for workflow routing
-- =============================================================================
-- ticket_type determines which workflow processes the ticket:
--   'build'    — Software development (7-phase swarm pipeline)
--   'incident' — Infrastructure incident investigation (direct specialist)
-- =============================================================================

-- NOTE: the `tickets` table is created at RUNTIME by ticket-schema.ts
-- (ensureSchema), which runs AFTER this migration on a fresh database. Guard on
-- the table's existence so a fresh-DB bootstrap does not throw here and abort the
-- whole migration chain (which would leave swarm_applications etc. uncreated).
-- ticket_type is also defined in ticket-schema.ts, so fresh installs are correct;
-- this migration backfills/retags existing databases.
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type TEXT NOT NULL DEFAULT 'build';
    CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets (ticket_type);

    -- Retroactively tag existing incident tickets
    UPDATE tickets SET ticket_type = 'incident'
    WHERE ticket_type = 'build'
      AND (labels @> ARRAY['incident'] OR labels @> ARRAY['rca-requested']);
  END IF;
END $$;
