-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L2: the location store. Eight tables (settings, devices, observations, current, places, member shares, guardian shares, member restrictions), each ENABLE + FORCE row-level security with hand-written policies and NO oshal.is_operator branch (operator decision Q2): a person's rows match owner_sub AND principal_issuer against the session (the issuer-qualified shape of migration 145); a tenant's rows are readable by its members and writable only by its admins through oshal_is_tenant_admin (migration 174). History is kept until its owner purges it (Q4): there is no expiry column, no retention class and no purge broker; the owner's own DELETE is the purge, and a group admin purges a group device's rows. Any tenant is a swarm group and each member shares with it by their own member share over an explicit set of that group's places (Q1); a restricted (minor) member cannot share, and a group admin may grant a guardian share of that member to named members of the same group (Q5). Restrictions have no INSERT path at all: L5's acceptance function is the only writer. Coordinates are stored already minimised to their precision class, and a CHECK refuses anything finer.
-- -----------------------------------------------------------------------------

-- ===========================================================================
-- Helpers. None of them reads oshal.is_operator; the static guard
-- (tests/helpers/location-rls-guard.ts) fails the build if one ever does.
-- ===========================================================================

-- A stored fix carries no more decimals than its precision class allows (ADR-169 D3 table):
-- exact 5, block 3, city 2, place-only none at all.
CREATE OR REPLACE FUNCTION location_fix_minimised(p_class text, p_lat double precision, p_lon double precision)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT CASE p_class
    WHEN 'place-only' THEN p_lat IS NULL AND p_lon IS NULL
    ELSE p_lat IS NOT NULL AND p_lon IS NOT NULL
      AND p_lat BETWEEN -90 AND 90 AND p_lon BETWEEN -180 AND 180
      AND p_lat = round(p_lat::numeric, CASE p_class WHEN 'exact' THEN 5 WHEN 'block' THEN 3 ELSE 2 END)::double precision
      AND p_lon = round(p_lon::numeric, CASE p_class WHEN 'exact' THEN 5 WHEN 'block' THEN 3 ELSE 2 END)::double precision
  END;
$$;

-- The smallest group-place radius a member at this precision class may be evaluated against
-- (ADR-169 D6): block 110 m, city 1.1 km. exact is bounded only by the 50 m trigger minimum;
-- place-only stores no coordinates at all, so it takes the coarsest floor defined, city's.
CREATE OR REPLACE FUNCTION location_precision_floor_m(p_class text)
  RETURNS double precision
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT CASE p_class WHEN 'exact' THEN 50 WHEN 'block' THEN 110 ELSE 1100 END::double precision;
$$;

-- A person row belongs to the session only when BOTH the subject and its verified issuer match.
-- A blank sub (SYSTEM, unstamped) or a blank issuer never matches.
CREATE OR REPLACE FUNCTION location_owner_is_session(p_owner_sub text, p_issuer text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT COALESCE(p_owner_sub, '') <> '' AND COALESCE(p_issuer, '') <> ''
     AND p_owner_sub = current_setting('oshal.current_sub', true)
     AND p_issuer = current_setting('oshal.current_issuer', true);
$$;

-- Tenant readers: a signed-in member of the tenant (060's helper, with the blank-sub fence).
CREATE OR REPLACE FUNCTION location_viewer_is_member(p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND p_tenant IS NOT NULL
     AND oshal_is_tenant_member(p_tenant::text);
$$;

-- Read and write predicates for the tables whose rows are a person's or a tenant's.
CREATE OR REPLACE FUNCTION location_row_readable(p_owner_sub text, p_issuer text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT (p_tenant IS NULL AND location_owner_is_session(p_owner_sub, p_issuer))
      OR (p_tenant IS NOT NULL AND location_viewer_is_member(p_tenant));
$$;

CREATE OR REPLACE FUNCTION location_row_writable(p_owner_sub text, p_issuer text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT (p_tenant IS NULL AND location_owner_is_session(p_owner_sub, p_issuer))
      OR (p_tenant IS NOT NULL AND oshal_is_tenant_admin(p_tenant::text));
$$;

-- ===========================================================================
-- Tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS location_settings (
  owner_sub TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  default_precision_class TEXT NOT NULL DEFAULT 'block',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_sub, principal_issuer),
  CONSTRAINT location_settings_owner_shape CHECK (owner_sub <> '' AND principal_issuer <> ''),
  CONSTRAINT location_settings_precision CHECK (default_precision_class IN ('exact', 'block', 'city', 'place-only'))
);

CREATE TABLE IF NOT EXISTS location_places (
  place_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'other',
  center_lat DOUBLE PRECISION NOT NULL,
  center_lon DOUBLE PRECISION NOT NULL,
  radius_m DOUBLE PRECISION NOT NULL,
  address TEXT,
  timezone TEXT,
  created_by_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_places_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_places_name CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT location_places_label CHECK (label IN ('home', 'work', 'grocery', 'other')),
  CONSTRAINT location_places_center CHECK (center_lat BETWEEN -90 AND 90 AND center_lon BETWEEN -180 AND 180),
  CONSTRAINT location_places_radius CHECK (radius_m >= 50 AND radius_m <= 50000),
  CONSTRAINT location_places_address CHECK (address IS NULL OR length(address) <= 500),
  CONSTRAINT location_places_timezone CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT location_places_creator CHECK (created_by_sub <> '')
);

CREATE TABLE IF NOT EXISTS location_devices (
  device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_kind TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  carried_by_sub TEXT,
  place_id UUID REFERENCES location_places(place_id) ON DELETE SET NULL,
  room TEXT,
  reporting_enabled BOOLEAN NOT NULL DEFAULT false,
  precision_class TEXT NOT NULL DEFAULT 'block',
  last_seen_at TIMESTAMPTZ,
  credential_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_devices_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_devices_kind CHECK (device_kind IN ('browser', 'phone', 'node', 'drone', 'camera', 'tv', 'hub')),
  CONSTRAINT location_devices_ref CHECK (length(device_ref) BETWEEN 1 AND 200),
  CONSTRAINT location_devices_carried_by_owner CHECK (
    carried_by_sub IS NULL OR (tenant_id IS NULL AND carried_by_sub = owner_sub)),
  CONSTRAINT location_devices_room CHECK (room IS NULL OR length(room) <= 80),
  CONSTRAINT location_devices_precision CHECK (precision_class IN ('exact', 'block', 'city', 'place-only')),
  CONSTRAINT location_devices_one_record UNIQUE (device_kind, device_ref)
);

-- History. Insert-only for writers; only the owner's purge (or a group admin, for a group
-- device) deletes it. device_id carries no foreign key on purpose: history outlives the
-- device's registry row, and the write policy checks the device's scope at insert time.
CREATE TABLE IF NOT EXISTS location_observations (
  observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL,
  device_id UUID,
  source TEXT NOT NULL,
  precision_class TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_m DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  mock_location BOOLEAN NOT NULL DEFAULT false,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_observations_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_observations_subject CHECK (
    (tenant_id IS NULL AND (subject_ref = owner_sub OR (device_id IS NOT NULL AND subject_ref = 'device:' || device_id::text)))
    OR (tenant_id IS NOT NULL AND device_id IS NOT NULL AND subject_ref = 'device:' || device_id::text)),
  CONSTRAINT location_observations_source CHECK (source IN ('browser', 'android', 'mavlink', 'manual', 'hub')),
  CONSTRAINT location_observations_precision CHECK (precision_class IN ('exact', 'block', 'city', 'place-only')),
  CONSTRAINT location_observations_minimised CHECK (location_fix_minimised(precision_class, lat, lon)),
  CONSTRAINT location_observations_accuracy CHECK (accuracy_m IS NULL OR accuracy_m >= 0)
);

-- Current state (not history): one row per subject, upserted on ingest; opting the device out
-- clears it, and deleting the device removes it.
CREATE TABLE IF NOT EXISTS location_current (
  current_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  subject_ref TEXT NOT NULL,
  device_id UUID REFERENCES location_devices(device_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  precision_class TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  alt_m DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  mock_location BOOLEAN NOT NULL DEFAULT false,
  place_id UUID REFERENCES location_places(place_id) ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_current_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_current_subject CHECK (
    (tenant_id IS NULL AND (subject_ref = owner_sub OR (device_id IS NOT NULL AND subject_ref = 'device:' || device_id::text)))
    OR (tenant_id IS NOT NULL AND device_id IS NOT NULL AND subject_ref = 'device:' || device_id::text)),
  CONSTRAINT location_current_source CHECK (source IN ('browser', 'android', 'mavlink', 'manual', 'hub')),
  CONSTRAINT location_current_precision CHECK (precision_class IN ('exact', 'block', 'city', 'place-only')),
  CONSTRAINT location_current_minimised CHECK (location_fix_minimised(precision_class, lat, lon)),
  CONSTRAINT location_current_accuracy CHECK (accuracy_m IS NULL OR accuracy_m >= 0)
);

-- A member share: a person's own grant of their place transitions to one group, over an
-- explicit set of that group's places (Q1). A person row that names the group it is shared with.
CREATE TABLE IF NOT EXISTS location_shares (
  share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  place_ids UUID[] NOT NULL,
  geometry_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_shares_owner_shape CHECK (owner_sub <> '' AND principal_issuer <> ''),
  CONSTRAINT location_shares_place_count CHECK (cardinality(place_ids) BETWEEN 1 AND 20)
);

-- A restricted (minor) member of one group (Q5). A tenant row naming the member in user_sub.
-- It goes when the membership goes (leaving the group, account erasure).
CREATE TABLE IF NOT EXISTS location_member_restrictions (
  tenant_id UUID NOT NULL,
  user_sub TEXT NOT NULL,
  issued_by_sub TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_sub),
  FOREIGN KEY (tenant_id, user_sub)
    REFERENCES oshal_tenant_memberships(tenant_id, user_sub) ON DELETE CASCADE,
  CONSTRAINT location_member_restrictions_subjects CHECK (user_sub <> '' AND issued_by_sub <> '')
);

-- A guardian share: a group admin's grant of a restricted member's place transitions to named
-- members of the same group (Q5). A tenant row naming the minor in user_sub.
CREATE TABLE IF NOT EXISTS location_guardian_shares (
  share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_sub TEXT NOT NULL,
  granted_by_sub TEXT NOT NULL,
  grantees JSONB NOT NULL,
  place_ids UUID[] NOT NULL,
  geometry_digest TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_sub)
    REFERENCES location_member_restrictions(tenant_id, user_sub) ON DELETE CASCADE,
  CONSTRAINT location_guardian_shares_place_count CHECK (cardinality(place_ids) BETWEEN 1 AND 20),
  CONSTRAINT location_guardian_shares_grantees CHECK (jsonb_typeof(grantees) = 'array' AND jsonb_array_length(grantees) >= 1)
);

CREATE INDEX IF NOT EXISTS location_places_owner_idx ON location_places (owner_sub, principal_issuer) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS location_places_tenant_idx ON location_places (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_devices_owner_idx ON location_devices (owner_sub, principal_issuer) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS location_devices_tenant_idx ON location_devices (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_observations_owner_idx ON location_observations (owner_sub, principal_issuer, received_at) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS location_observations_tenant_idx ON location_observations (tenant_id, received_at) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_observations_subject_idx ON location_observations (subject_ref, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS location_current_subject_uq
  ON location_current (subject_ref, COALESCE(principal_issuer, ''), COALESCE(tenant_id::text, ''));
CREATE INDEX IF NOT EXISTS location_shares_owner_idx ON location_shares (owner_sub, principal_issuer);
CREATE INDEX IF NOT EXISTS location_shares_tenant_idx ON location_shares (tenant_id);
CREATE INDEX IF NOT EXISTS location_guardian_shares_minor_idx ON location_guardian_shares (tenant_id, user_sub);

-- ===========================================================================
-- Predicates that must see past the caller's own rows. SECURITY DEFINER, pinned search_path,
-- and each one re-derives the writer from the session instead of trusting an argument.
-- ===========================================================================

-- A place a device or current row may point at: the same person's own place, the same group's
-- place, or a place of a group the person is a member of. Foreign-key checks bypass row-level
-- security, so without this a row could reference anyone's place id.
CREATE OR REPLACE FUNCTION location_place_assignable(p_place uuid, p_owner_sub text, p_issuer text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p_place IS NULL OR EXISTS (
    SELECT 1 FROM location_places p
     WHERE p.place_id = p_place
       AND (   (p.tenant_id IS NULL AND p_tenant IS NULL
                AND p.owner_sub = p_owner_sub AND p.principal_issuer = p_issuer)
            OR (p.tenant_id IS NOT NULL AND p.tenant_id = p_tenant)
            OR (p.tenant_id IS NOT NULL AND p_tenant IS NULL AND EXISTS (
                  SELECT 1 FROM oshal_tenant_memberships m
                   WHERE m.tenant_id = p.tenant_id AND m.user_sub = p_owner_sub))));
$$;

-- A fix's reporting device must belong to the same owner scope as the fix.
CREATE OR REPLACE FUNCTION location_device_in_scope(p_device uuid, p_owner_sub text, p_issuer text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p_device IS NULL OR EXISTS (
    SELECT 1 FROM location_devices d
     WHERE d.device_id = p_device
       AND (   (d.tenant_id IS NULL AND p_tenant IS NULL
                AND d.owner_sub = p_owner_sub AND d.principal_issuer = p_issuer)
            OR (d.tenant_id IS NOT NULL AND d.tenant_id = p_tenant)));
$$;

-- Digest over the approved places' geometry, or NULL when the set is not exactly distinct places
-- of this group. A share records it at approval; editing an approved place changes it, which is
-- what "changing an approved place's geometry needs re-acceptance" (D6) keys on. Not a definer:
-- a caller who cannot see the group's places gets NULL.
CREATE OR REPLACE FUNCTION location_places_digest(p_tenant uuid, p_places uuid[])
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT CASE
    WHEN p_tenant IS NULL OR p_places IS NULL OR cardinality(p_places) = 0 THEN NULL
    WHEN (SELECT count(DISTINCT x) FROM unnest(p_places) AS x) <> cardinality(p_places) THEN NULL
    WHEN count(*) <> cardinality(p_places) THEN NULL
    ELSE encode(sha256(convert_to(string_agg(
      p.place_id::text || ':' || p.center_lat::text || ':' || p.center_lon::text || ':' || p.radius_m::text,
      ';' ORDER BY p.place_id), 'UTF8')), 'hex')
  END
  FROM location_places p
  WHERE p.tenant_id = p_tenant AND p.place_id = ANY (p_places);
$$;

-- True when every place in the set is a place of the group at least p_floor metres in radius.
CREATE OR REPLACE FUNCTION location_places_meet_floor(p_tenant uuid, p_places uuid[], p_floor double precision)
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(p_places) AS x
     WHERE NOT EXISTS (SELECT 1 FROM location_places p
                        WHERE p.place_id = x AND p.tenant_id = p_tenant AND p.radius_m >= p_floor));
$$;

-- The session member's own precision floor (their settings row, block when they have none).
CREATE OR REPLACE FUNCTION location_session_floor_m()
  RETURNS double precision
  LANGUAGE sql
  STABLE
AS $$
  SELECT location_precision_floor_m(COALESCE((
    SELECT s.default_precision_class FROM location_settings s
     WHERE s.owner_sub = current_setting('oshal.current_sub', true)
       AND s.principal_issuer = current_setting('oshal.current_issuer', true)), 'block'));
$$;

-- A member's floor when only their sub is known (memberships are sub-only): the coarsest class
-- any of their settings rows names, block when there is none.
CREATE OR REPLACE FUNCTION location_member_floor_m(p_sub text)
  RETURNS double precision
  LANGUAGE sql
  STABLE
AS $$
  SELECT COALESCE((SELECT max(location_precision_floor_m(s.default_precision_class))
                     FROM location_settings s WHERE s.owner_sub = p_sub),
                  location_precision_floor_m('block'));
$$;

-- A member share is admissible when its grantor (the session) is a member of the group, is not
-- restricted there, and approves 1-20 distinct places of that group, each at least as coarse as
-- the grantor's precision class, with the digest of their current geometry.
CREATE OR REPLACE FUNCTION location_member_share_admissible(p_tenant uuid, p_places uuid[], p_digest text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.user_sub = current_setting('oshal.current_sub', true))
     AND NOT EXISTS (SELECT 1 FROM location_member_restrictions r
                      WHERE r.tenant_id = p_tenant AND r.user_sub = current_setting('oshal.current_sub', true))
     AND cardinality(p_places) BETWEEN 1 AND 20
     AND p_digest IS NOT NULL
     AND location_places_digest(p_tenant, p_places) = p_digest
     AND location_places_meet_floor(p_tenant, p_places, location_session_floor_m());
$$;

-- A guardian share is admissible when the writer is an admin of the group, the member it names is
-- restricted there, every grantee is a distinct current member of the same group other than the
-- minor, and the 1-20 approved places are that group's, at least as coarse as the minor's floor,
-- with the digest of their current geometry.
CREATE OR REPLACE FUNCTION location_guardian_share_admissible(
  p_tenant uuid, p_minor text, p_grantees jsonb, p_places uuid[], p_digest text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT oshal_is_tenant_admin(p_tenant::text)
     AND EXISTS (SELECT 1 FROM location_member_restrictions r
                  WHERE r.tenant_id = p_tenant AND r.user_sub = p_minor)
     AND jsonb_typeof(p_grantees) = 'array'
     AND jsonb_array_length(p_grantees) >= 1
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_grantees) AS g
        WHERE jsonb_typeof(g) <> 'object'
           OR jsonb_typeof(g -> 'sub') IS DISTINCT FROM 'string'
           OR jsonb_typeof(g -> 'issuer') IS DISTINCT FROM 'string'
           OR COALESCE(g ->> 'sub', '') = ''
           OR COALESCE(g ->> 'issuer', '') = ''
           OR g ->> 'sub' = p_minor
           OR NOT EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                           WHERE m.tenant_id = p_tenant AND m.user_sub = g ->> 'sub'))
     AND (SELECT count(DISTINCT (g ->> 'sub', g ->> 'issuer')) FROM jsonb_array_elements(p_grantees) AS g)
         = jsonb_array_length(p_grantees)
     AND cardinality(p_places) BETWEEN 1 AND 20
     AND p_digest IS NOT NULL
     AND location_places_digest(p_tenant, p_places) = p_digest
     AND location_places_meet_floor(p_tenant, p_places, location_member_floor_m(p_minor));
$$;

-- A restriction names one member of one group for good: an update may not re-point it at another
-- member (that would restrict an existing member without an accepted invitation).
CREATE OR REPLACE FUNCTION location_restriction_key_fence()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_sub IS DISTINCT FROM OLD.user_sub THEN
    RAISE EXCEPTION 'location_member_restrictions: a restriction cannot be moved to another member'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS location_restriction_key_fence ON location_member_restrictions;
CREATE TRIGGER location_restriction_key_fence
  BEFORE UPDATE OF tenant_id, user_sub ON location_member_restrictions
  FOR EACH ROW EXECUTE FUNCTION location_restriction_key_fence();

-- ===========================================================================
-- Row-level security: ENABLE + FORCE on every table, no oshal.is_operator branch anywhere.
-- ===========================================================================

ALTER TABLE location_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE location_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_places FORCE ROW LEVEL SECURITY;
ALTER TABLE location_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE location_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE location_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_current FORCE ROW LEVEL SECURITY;
ALTER TABLE location_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE location_member_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_member_restrictions FORCE ROW LEVEL SECURITY;
ALTER TABLE location_guardian_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_guardian_shares FORCE ROW LEVEL SECURITY;

-- Settings: the person's own row only.
DROP POLICY IF EXISTS location_settings_owner ON location_settings;
CREATE POLICY location_settings_owner ON location_settings AS PERMISSIVE FOR ALL
  USING (location_owner_is_session(owner_sub, principal_issuer))
  WITH CHECK (location_owner_is_session(owner_sub, principal_issuer));

-- Places: the owner, or the group (members read, admins write). The creator is the writer.
DROP POLICY IF EXISTS location_places_read ON location_places;
CREATE POLICY location_places_read ON location_places AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_places_insert ON location_places;
CREATE POLICY location_places_insert ON location_places AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND created_by_sub = current_setting('oshal.current_sub', true));
DROP POLICY IF EXISTS location_places_update ON location_places;
CREATE POLICY location_places_update ON location_places AS PERMISSIVE FOR UPDATE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id))
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_places_delete ON location_places;
CREATE POLICY location_places_delete ON location_places AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

-- Devices: as places, and an assigned place must be one the device's owner may use.
DROP POLICY IF EXISTS location_devices_read ON location_devices;
CREATE POLICY location_devices_read ON location_devices AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_devices_insert ON location_devices;
CREATE POLICY location_devices_insert ON location_devices AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_devices_update ON location_devices;
CREATE POLICY location_devices_update ON location_devices AS PERMISSIVE FOR UPDATE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id))
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_devices_delete ON location_devices;
CREATE POLICY location_devices_delete ON location_devices AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

-- Observations: read by the owner (or the group), inserted by the owner (or a group admin) for a
-- device in the same scope, never updated, deleted only by the owner's purge.
DROP POLICY IF EXISTS location_observations_read ON location_observations;
CREATE POLICY location_observations_read ON location_observations AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_observations_insert ON location_observations;
CREATE POLICY location_observations_insert ON location_observations AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_device_in_scope(device_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_observations_purge ON location_observations;
CREATE POLICY location_observations_purge ON location_observations AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

-- Current: as observations, but upserted in place.
DROP POLICY IF EXISTS location_current_read ON location_current;
CREATE POLICY location_current_read ON location_current AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_current_insert ON location_current;
CREATE POLICY location_current_insert ON location_current AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_device_in_scope(device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_current_update ON location_current;
CREATE POLICY location_current_update ON location_current AS PERMISSIVE FOR UPDATE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id))
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_device_in_scope(device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_current_delete ON location_current;
CREATE POLICY location_current_delete ON location_current AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

-- Member shares: the grantor's own rows. Creating or reinstating one must be admissible; a
-- revoked share need not be (revoking must work after the approved places changed).
DROP POLICY IF EXISTS location_shares_read ON location_shares;
CREATE POLICY location_shares_read ON location_shares AS PERMISSIVE FOR SELECT
  USING (location_owner_is_session(owner_sub, principal_issuer));
DROP POLICY IF EXISTS location_shares_insert ON location_shares;
CREATE POLICY location_shares_insert ON location_shares AS PERMISSIVE FOR INSERT
  WITH CHECK (location_owner_is_session(owner_sub, principal_issuer)
    AND revoked_at IS NULL
    AND location_member_share_admissible(tenant_id, place_ids, geometry_digest));
DROP POLICY IF EXISTS location_shares_update ON location_shares;
CREATE POLICY location_shares_update ON location_shares AS PERMISSIVE FOR UPDATE
  USING (location_owner_is_session(owner_sub, principal_issuer))
  WITH CHECK (location_owner_is_session(owner_sub, principal_issuer)
    AND (revoked_at IS NOT NULL OR location_member_share_admissible(tenant_id, place_ids, geometry_digest)));
DROP POLICY IF EXISTS location_shares_delete ON location_shares;
CREATE POLICY location_shares_delete ON location_shares AS PERMISSIVE FOR DELETE
  USING (location_owner_is_session(owner_sub, principal_issuer));

-- Restrictions: no INSERT policy at all (L5's acceptance function is the only writer). The
-- member and the group's admins read; only admins update or delete; the member cannot delete it.
DROP POLICY IF EXISTS location_member_restrictions_read ON location_member_restrictions;
CREATE POLICY location_member_restrictions_read ON location_member_restrictions AS PERMISSIVE FOR SELECT
  USING ((user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
    OR oshal_is_tenant_admin(tenant_id::text));
DROP POLICY IF EXISTS location_member_restrictions_update ON location_member_restrictions;
CREATE POLICY location_member_restrictions_update ON location_member_restrictions AS PERMISSIVE FOR UPDATE
  USING (oshal_is_tenant_admin(tenant_id::text))
  WITH CHECK (oshal_is_tenant_admin(tenant_id::text));
DROP POLICY IF EXISTS location_member_restrictions_delete ON location_member_restrictions;
CREATE POLICY location_member_restrictions_delete ON location_member_restrictions AS PERMISSIVE FOR DELETE
  USING (oshal_is_tenant_admin(tenant_id::text));

-- Guardian shares: written and revoked only by the minor's group admins; the minor reads (and
-- cannot delete) the shares naming them; grantees read nothing here (L5's projection).
DROP POLICY IF EXISTS location_guardian_shares_read ON location_guardian_shares;
CREATE POLICY location_guardian_shares_read ON location_guardian_shares AS PERMISSIVE FOR SELECT
  USING ((user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
    OR oshal_is_tenant_admin(tenant_id::text));
DROP POLICY IF EXISTS location_guardian_shares_insert ON location_guardian_shares;
CREATE POLICY location_guardian_shares_insert ON location_guardian_shares AS PERMISSIVE FOR INSERT
  WITH CHECK (granted_by_sub = current_setting('oshal.current_sub', true)
    AND revoked_at IS NULL
    AND location_guardian_share_admissible(tenant_id, user_sub, grantees, place_ids, geometry_digest));
DROP POLICY IF EXISTS location_guardian_shares_update ON location_guardian_shares;
CREATE POLICY location_guardian_shares_update ON location_guardian_shares AS PERMISSIVE FOR UPDATE
  USING (oshal_is_tenant_admin(tenant_id::text))
  WITH CHECK (oshal_is_tenant_admin(tenant_id::text)
    AND (revoked_at IS NOT NULL
      OR location_guardian_share_admissible(tenant_id, user_sub, grantees, place_ids, geometry_digest)));
DROP POLICY IF EXISTS location_guardian_shares_delete ON location_guardian_shares;
CREATE POLICY location_guardian_shares_delete ON location_guardian_shares AS PERMISSIVE FOR DELETE
  USING (oshal_is_tenant_admin(tenant_id::text));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      location_settings, location_places, location_devices, location_current, location_shares,
      location_member_restrictions, location_guardian_shares TO oshal_app;
    GRANT SELECT, INSERT, DELETE ON location_observations TO oshal_app;
  END IF;
END $$;

COMMENT ON TABLE location_observations IS
  'ADR-169 D3: minimised fixes, kept until their owner purges them (Q4). Row-level security has no operator branch (Q2).';
COMMENT ON TABLE location_member_restrictions IS
  'ADR-169 D6/Q5: a restricted (minor) member of one group. No INSERT policy: the L5 acceptance function is the only writer.';
COMMENT ON TABLE location_guardian_shares IS
  'ADR-169 D6/Q5: a group admin''s grant of a restricted member''s place transitions to named members of the same group.';
