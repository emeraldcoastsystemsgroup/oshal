/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 022: Swarm Application Manifests
-- Date: 2026-04-21
-- Author: maintainer@emeraldcoastsystemsgroup.com
-- ADR: the swarm-application-manifests ADR in docs/adr/
-- Description:
--   One row per installed swarm application. A "swarm application" is a
--   bundle of bots, tools, UI surfaces, and ticket workflows loaded from a
--   manifest file (swarm-apps/*.yaml). Apps can be toggled active/inactive
--   without restarting containers. Multiple apps can be active simultaneously.
-- =============================================================================

CREATE TABLE IF NOT EXISTS swarm_applications (
  app_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  version VARCHAR(50) NOT NULL DEFAULT '0.0.0',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  manifest_path VARCHAR(500) NOT NULL,
  agent_ids UUID[] NOT NULL DEFAULT '{}',
  tool_names TEXT[] NOT NULL DEFAULT '{}',
  manifest JSONB NOT NULL DEFAULT '{}',
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swarm_apps_status ON swarm_applications(status);
CREATE INDEX IF NOT EXISTS idx_swarm_apps_name ON swarm_applications(name);

-- updated_at auto-touch on any UPDATE
CREATE OR REPLACE FUNCTION touch_swarm_applications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_swarm_applications_updated_at ON swarm_applications;
CREATE TRIGGER trg_swarm_applications_updated_at
BEFORE UPDATE ON swarm_applications
FOR EACH ROW EXECUTE FUNCTION touch_swarm_applications_updated_at();
