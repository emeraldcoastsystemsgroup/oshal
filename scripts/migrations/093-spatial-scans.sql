/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — owner-scoped spatial_scans table: one row per video->3D reconstruction scan (metadata + storage refs only; the .splat/.ply bytes live on disk, never in a BYTEA column). RLS shape mirrors buildOwnerRlsPolicyStatements exactly (spatial_scans_owner_or_operator) so this migration and the SpatialScanStore fresh-boot bootstrap produce an identical policy. GUC oshal.current_sub scopes every read/write to the owning user; operator bypass via oshal.is_operator.
 */

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_scans (
  id             TEXT PRIMARY KEY,
  user_sub       TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',   -- queued | reconstructing | ready | failed
  source_kind    TEXT NOT NULL DEFAULT 'video',    -- video | images
  source_name    TEXT,                             -- original upload filename (display only)
  source_ref     TEXT,                             -- on-disk path to the stored source (never served raw)
  source_bytes   BIGINT,
  provider       TEXT,                             -- sim | edge (which reconstruction engine ran)
  artifact_ref   TEXT,                             -- on-disk path to the produced .splat
  gaussian_count INTEGER,
  error          TEXT,                             -- failure detail when status='failed'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spatial_scans_user_created_idx
  ON spatial_scans (user_sub, created_at DESC);

-- Owner-scoped RLS (defense-in-depth beneath the WHERE user_sub=$1 filter every query carries).
-- Create-if-absent, never drop/recreate: re-running at boot must never open a window with RLS
-- enabled but no policy. Shape is byte-identical to buildOwnerRlsPolicyStatements('spatial_scans','user_sub').
ALTER TABLE spatial_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE spatial_scans FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'spatial_scans_owner_or_operator'
      AND polrelid = 'spatial_scans'::regclass
  ) THEN
    CREATE POLICY spatial_scans_owner_or_operator ON spatial_scans
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END $$;

COMMIT;
