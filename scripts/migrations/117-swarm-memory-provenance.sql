/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the durable SEC-05 swarm
 *   memory ledger with explicit trust, source, workload creator, approval, and validation evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bind operator approval evidence to the exact durable document SHA-256.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Permit only connection-scoped ledger-broker transactions through FORCE RLS; application owner/workspace ACLs remain mandatory.
 */

-- The migration runner owns BEGIN/COMMIT. Shared operational memory is writable/readable only
-- from an operator/system GUC context; model-facing vector search remains a derived index.
CREATE TABLE IF NOT EXISTS oshal_swarm_memory (
  work_item_id TEXT PRIMARY KEY CHECK (length(btrim(work_item_id)) > 0),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  document TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  owner_sub TEXT,
  tenant_id TEXT,
  workspace_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared')),
  trust_level TEXT NOT NULL DEFAULT 'untrusted'
    CHECK (trust_level IN ('untrusted', 'validated', 'approved')),
  source TEXT NOT NULL CHECK (length(btrim(source)) > 0),
  created_by_workload TEXT NOT NULL CHECK (length(btrim(created_by_workload)) > 0),
  approved_by_sub TEXT,
  approval_content_sha256 TEXT
    CHECK (approval_content_sha256 IS NULL OR approval_content_sha256 ~ '^[0-9a-f]{64}$'),
  validation_method TEXT,
  validation_evidence_sha256 TEXT
    CHECK (validation_evidence_sha256 IS NULL OR validation_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oshal_swarm_memory_visibility CHECK (
    (visibility = 'private' AND owner_sub IS NOT NULL AND length(owner_sub) > 0)
    OR (visibility = 'shared' AND owner_sub IS NULL AND tenant_id IS NULL
      AND workspace_id IS NULL AND trust_level = 'approved')
  ),
  CONSTRAINT oshal_swarm_memory_trust_evidence CHECK (
    (trust_level = 'untrusted' AND approved_by_sub IS NULL
      AND approval_content_sha256 IS NULL AND validation_method IS NULL
      AND validation_evidence_sha256 IS NULL)
    OR (trust_level = 'validated' AND approved_by_sub IS NULL
      AND approval_content_sha256 IS NULL AND validation_method IS NOT NULL
      AND validation_evidence_sha256 IS NOT NULL)
    OR (trust_level = 'approved' AND approved_by_sub IS NOT NULL
      AND length(approved_by_sub) > 0
      AND approval_content_sha256 = content_sha256
      AND validation_method IS NULL AND validation_evidence_sha256 IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_oshal_swarm_memory_trust_updated
  ON oshal_swarm_memory (trust_level, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oshal_swarm_memory_creator
  ON oshal_swarm_memory (created_by_workload, updated_at DESC);

ALTER TABLE oshal_swarm_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_swarm_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_swarm_memory_operator_only ON oshal_swarm_memory;
DROP POLICY IF EXISTS oshal_swarm_memory_ledger_broker ON oshal_swarm_memory;
CREATE POLICY oshal_swarm_memory_ledger_broker ON oshal_swarm_memory
  AS PERMISSIVE FOR ALL
  USING (current_setting('oshal.swarm_memory_ledger_broker', true) = 'on')
  WITH CHECK (current_setting('oshal.swarm_memory_ledger_broker', true) = 'on');
