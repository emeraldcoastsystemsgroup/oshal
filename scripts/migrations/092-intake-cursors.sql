-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Added durable provider cursor checkpoints for restart-safe external ticket reconciliation

CREATE TABLE IF NOT EXISTS oshal_intake_cursors (
  provider TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE oshal_intake_cursors IS
  'Controller-owned opaque checkpoints for external intake provider reconciliation.';
