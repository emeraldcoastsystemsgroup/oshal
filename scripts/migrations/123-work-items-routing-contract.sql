/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Move the remaining work-item runtime schema contract into the ordered migration chain so managed bot roles can start with validate-only DDL posture.
 */

-- Migration 007 predates the watchdog's durable run linkage and terminal
-- routing-failure state. Runtime bootstrapping added both later, but managed
-- bot roles intentionally have no DDL. Keep the canonical migration identical
-- to work-item-schema.ts and safe on both fresh and already-upgraded databases.

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS run_id TEXT;

ALTER TABLE work_items
  DROP CONSTRAINT IF EXISTS work_items_status_check;

ALTER TABLE work_items
  ADD CONSTRAINT work_items_status_check CHECK (status IN (
    'pending', 'assigned', 'executing', 'completed', 'failed', 'escalated',
    'in-review',
    'subtask-pending', 'subtask-assigned', 'subtask-executing',
    'subtask-completed', 'subtask-failed',
    'routing_failed'
  ));
