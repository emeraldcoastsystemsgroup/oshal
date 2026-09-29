-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L7: map anchors, and the ADR-111 amendment they need. spatial_scans gains a nullable tenant_id (a group's scan) and capture_session_id (the guided-capture session whose phone telemetry produced the scan, which is what joins capture GPS to its scan). A group's scan is reached only by that group's members: a RESTRICTIVE policy fences every tenant row whatever the older owner policy of migration 093 admits, so an operator-stamped session, SYSTEM, a stranger and a capturer who has left the group all get nothing, while a person's own scans behave exactly as before. A scan's owner and group are fixed when it is registered. location_map_anchors records a map's geodetic anchor by reference (kind and reference, never geometry): origin, heading, footprint radius, accuracy, source, capturing device and time, an optional place, owned by a person or a group with the same hand-written policies as every location table (members read, group admins write, no operator branch, operator decision Q2). An anchor may reference only a map of the same owner: a person's anchor that person's own scan, a group's anchor that group's scan. Its coordinates are stored minimised to the precision class its owner chose (the capturing device's, else the person's default, else block) and a policy refuses anything finer. Deleting a scan deletes its anchor.
-- -----------------------------------------------------------------------------

-- ===========================================================================
-- ADR-111 amendment: a scan may belong to a group, and names the capture session that produced it.
-- Both columns are NULL on every existing row, so this is behaviour-neutral on apply.
-- ===========================================================================

ALTER TABLE spatial_scans ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE;
ALTER TABLE spatial_scans ADD COLUMN IF NOT EXISTS capture_session_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'spatial_scans_capture_session_shape'
                    AND conrelid = 'spatial_scans'::regclass) THEN
    ALTER TABLE spatial_scans ADD CONSTRAINT spatial_scans_capture_session_shape
      CHECK (capture_session_id IS NULL
        OR capture_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS spatial_scans_tenant_created_idx
  ON spatial_scans (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;

-- A scan's owner and group are fixed when it is registered. Without this a member of a group could
-- rewrite a group scan into their own personal scan (the member policy admits the row, and the
-- owner policy of migration 093 admits the rewritten one).
CREATE OR REPLACE FUNCTION spatial_scans_owner_fence()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_sub IS DISTINCT FROM OLD.user_sub OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'spatial_scans: a scan''s owner and group are fixed when it is registered'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS spatial_scans_owner_fence ON spatial_scans;
CREATE TRIGGER spatial_scans_owner_fence
  BEFORE UPDATE OF user_sub, tenant_id ON spatial_scans
  FOR EACH ROW EXECUTE FUNCTION spatial_scans_owner_fence();

-- The group fence. RESTRICTIVE, so it holds whatever a permissive policy admits: a row with a group
-- is reached only by a signed-in member of that group. A row without one passes and is decided by
-- the owner policy of migration 093, unchanged.
DROP POLICY IF EXISTS spatial_scans_tenant_fence ON spatial_scans;
CREATE POLICY spatial_scans_tenant_fence ON spatial_scans AS RESTRICTIVE FOR ALL
  USING (tenant_id IS NULL
    OR (COALESCE(current_setting('oshal.current_sub', true), '') <> '' AND oshal_is_tenant_member(tenant_id::text)))
  WITH CHECK (tenant_id IS NULL
    OR (COALESCE(current_setting('oshal.current_sub', true), '') <> '' AND oshal_is_tenant_member(tenant_id::text)));

-- Members of the group reach its scans (the tenant branch of migration 060's personal-or-tenant shape).
DROP POLICY IF EXISTS spatial_scans_tenant_member ON spatial_scans;
CREATE POLICY spatial_scans_tenant_member ON spatial_scans AS PERMISSIVE FOR ALL
  USING (tenant_id IS NOT NULL
    AND COALESCE(current_setting('oshal.current_sub', true), '') <> '' AND oshal_is_tenant_member(tenant_id::text))
  WITH CHECK (tenant_id IS NOT NULL
    AND COALESCE(current_setting('oshal.current_sub', true), '') <> '' AND oshal_is_tenant_member(tenant_id::text));

-- ===========================================================================
-- Map anchors
-- ===========================================================================

CREATE TABLE IF NOT EXISTS location_map_anchors (
  anchor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  map_kind TEXT NOT NULL,
  map_ref TEXT NOT NULL,
  precision_class TEXT NOT NULL,
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lon DOUBLE PRECISION NOT NULL,
  origin_alt_m DOUBLE PRECISION,
  heading_deg DOUBLE PRECISION,
  footprint_radius_m DOUBLE PRECISION NOT NULL,
  accuracy_m DOUBLE PRECISION,
  anchor_source TEXT NOT NULL,
  captured_by_device_id UUID,
  captured_at TIMESTAMPTZ NOT NULL,
  place_id UUID REFERENCES location_places(place_id) ON DELETE SET NULL,
  created_by_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_map_anchors_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_map_anchors_kind CHECK (map_kind IN ('spatial-scan')),
  CONSTRAINT location_map_anchors_ref CHECK (length(map_ref) BETWEEN 1 AND 200),
  CONSTRAINT location_map_anchors_precision CHECK (precision_class IN ('exact', 'block', 'city')),
  CONSTRAINT location_map_anchors_minimised CHECK (location_fix_minimised(precision_class, origin_lat, origin_lon)),
  CONSTRAINT location_map_anchors_heading CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  CONSTRAINT location_map_anchors_footprint CHECK (footprint_radius_m >= 1 AND footprint_radius_m <= 50000),
  CONSTRAINT location_map_anchors_accuracy CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT location_map_anchors_source CHECK (anchor_source IN ('capture-gps', 'mavlink', 'manual')),
  CONSTRAINT location_map_anchors_creator CHECK (created_by_sub <> ''),
  CONSTRAINT location_map_anchors_one_anchor UNIQUE (map_kind, map_ref)
);

CREATE INDEX IF NOT EXISTS location_map_anchors_owner_idx ON location_map_anchors (owner_sub, principal_issuer) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS location_map_anchors_tenant_idx ON location_map_anchors (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_map_anchors_lat_idx ON location_map_anchors (origin_lat);

-- ===========================================================================
-- Helpers. None of them reads the operator flag; the static guard
-- (tests/helpers/location-rls-guard.ts) fails the build if one ever does.
-- ===========================================================================

-- How coarse a precision class is: a higher rank keeps fewer decimals.
CREATE OR REPLACE FUNCTION location_precision_rank(p_class text)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT CASE p_class WHEN 'exact' THEN 0 WHEN 'block' THEN 1 WHEN 'city' THEN 2 WHEN 'place-only' THEN 3 END;
$$;

-- The precision class an anchor's owner chose: the capturing device's class when the anchor names
-- one, else the person's default, else block (the default for people, and for a group anchor with
-- no device). Not a definer: the session reads its own settings and the devices it may read.
CREATE OR REPLACE FUNCTION location_map_anchor_class(p_owner_sub text, p_issuer text, p_tenant uuid, p_device uuid)
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT COALESCE(
    (SELECT d.precision_class FROM location_devices d WHERE p_device IS NOT NULL AND d.device_id = p_device),
    (SELECT s.default_precision_class FROM location_settings s
      WHERE p_tenant IS NULL AND s.owner_sub = p_owner_sub AND s.principal_issuer = p_issuer),
    'block');
$$;

-- An anchor may reference only a map of the same owner: a person's anchor that person's own scan,
-- a group's anchor that group's scan. A definer, because the map reference carries no foreign key
-- (it is by kind and reference) and the check must not depend on which scans the writer can see.
CREATE OR REPLACE FUNCTION location_map_anchorable(p_kind text, p_ref text, p_owner_sub text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p_kind = 'spatial-scan' AND EXISTS (
    SELECT 1 FROM spatial_scans s
     WHERE s.id = p_ref
       AND (   (p_tenant IS NULL AND s.tenant_id IS NULL AND COALESCE(p_owner_sub, '') <> '' AND s.user_sub = p_owner_sub)
            OR (p_tenant IS NOT NULL AND s.tenant_id = p_tenant)));
$$;

-- A deleted scan takes its anchor with it. A definer: a member who is not an admin may delete a
-- group scan but may not write a group anchor, and the anchor must not outlive its map.
CREATE OR REPLACE FUNCTION location_map_anchor_scan_removed()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM location_map_anchors WHERE map_kind = 'spatial-scan' AND map_ref = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION location_map_anchorable(text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION location_map_anchor_scan_removed() FROM PUBLIC;

DROP TRIGGER IF EXISTS location_map_anchor_scan_removed ON spatial_scans;
CREATE TRIGGER location_map_anchor_scan_removed
  AFTER DELETE ON spatial_scans
  FOR EACH ROW EXECUTE FUNCTION location_map_anchor_scan_removed();

-- ===========================================================================
-- Row-level security: ENABLE + FORCE, hand-written, no operator branch.
-- ===========================================================================

ALTER TABLE location_map_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_map_anchors FORCE ROW LEVEL SECURITY;

-- The owner, or the group (members read, admins write). The anchor grants nothing on the map it
-- names: the scan's own policies still decide who may open it.
DROP POLICY IF EXISTS location_map_anchors_read ON location_map_anchors;
CREATE POLICY location_map_anchors_read ON location_map_anchors AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_map_anchors_insert ON location_map_anchors;
CREATE POLICY location_map_anchors_insert ON location_map_anchors AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND created_by_sub = current_setting('oshal.current_sub', true)
    AND location_map_anchorable(map_kind, map_ref, owner_sub, tenant_id)
    AND location_device_in_scope(captured_by_device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id)
    AND location_precision_rank(precision_class)
        >= location_precision_rank(location_map_anchor_class(owner_sub, principal_issuer, tenant_id, captured_by_device_id)));
DROP POLICY IF EXISTS location_map_anchors_update ON location_map_anchors;
CREATE POLICY location_map_anchors_update ON location_map_anchors AS PERMISSIVE FOR UPDATE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id))
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_map_anchorable(map_kind, map_ref, owner_sub, tenant_id)
    AND location_device_in_scope(captured_by_device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id)
    AND location_precision_rank(precision_class)
        >= location_precision_rank(location_map_anchor_class(owner_sub, principal_issuer, tenant_id, captured_by_device_id)));
DROP POLICY IF EXISTS location_map_anchors_delete ON location_map_anchors;
CREATE POLICY location_map_anchors_delete ON location_map_anchors AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON location_map_anchors TO oshal_app;
  END IF;
END $$;

COMMENT ON COLUMN spatial_scans.tenant_id IS
  'ADR-111 amendment (ADR-169 L7): the group that owns the scan, NULL for a person''s own. A group''s scan is reached only by its members; user_sub stays the capturer.';
COMMENT ON COLUMN spatial_scans.capture_session_id IS
  'ADR-169 L7: the guided-capture session whose phone telemetry produced this scan; joins the session''s capture GPS to the scan.';
COMMENT ON TABLE location_map_anchors IS
  'ADR-169 D3/L7: a spatial map''s geodetic anchor, by reference. No geometry is copied here, and the anchor grants nothing on the map. Row-level security has no operator branch (Q2).';
COMMENT ON FUNCTION location_map_anchorable(text, text, text, uuid) IS
  'ADR-169 L7: an anchor references only a map of the same owner (a person''s own scan, or the same group''s scan).';
COMMENT ON FUNCTION location_map_anchor_scan_removed() IS
  'ADR-169 L7: deleting a scan deletes its anchor, whoever deletes it.';
