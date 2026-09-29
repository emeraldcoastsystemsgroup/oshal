-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L6: the location credential and the device subject. oshal_cli_tokens gains location_device_id, a second nullable binding beside node_client_id: a token bound to a location device authenticates only on POST /api/location/devices/<its device id>/presence (the token-auth middleware applies the scope before the account-PAT path), and a CHECK keeps the two bindings exclusive, so decideNodeTokenScope never sees a location token and the worker plane never admits one. The device subject 'device:<id>' is what the core device ingest route stamps after it has verified the credential against location_devices.credential_id; the policies here let exactly that subject insert observations and upsert the current row whose owner columns match its device's, read the places its device's owner may use (the L4 assignability rule) and touch its own last_seen_at through a definer function; it reads no observations and no device row. location_revoke_device_credential() revokes the credential a device row names when the caller may write that row (the owner, or a group admin), which is what rotation, opting out, removing the record and the erase use. location_device_named() lets /api/join/enroll refuse a client id that names a location device, so a node token can never be minted for a location device id. Like every location helper, nothing here reads oshal.is_operator (operator decision Q2).
-- -----------------------------------------------------------------------------

-- ===========================================================================
-- The location credential: a second binding on oshal_cli_tokens (recorded form of the lazy DDL in
-- src/app/routes/cli-token-routes.ts, ensureCliTokenSchema). NULL = not a location credential, which
-- every pre-existing row is, so this is behaviour-neutral on apply.
-- ===========================================================================

ALTER TABLE oshal_cli_tokens ADD COLUMN IF NOT EXISTS location_device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oshal_cli_tokens_location_device
  ON oshal_cli_tokens (location_device_id) WHERE location_device_id IS NOT NULL;

-- A token is bound to a node's worker plane or to a location device, never both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'oshal_cli_tokens_one_binding'
                    AND conrelid = 'oshal_cli_tokens'::regclass) THEN
    ALTER TABLE oshal_cli_tokens ADD CONSTRAINT oshal_cli_tokens_one_binding
      CHECK (node_client_id IS NULL OR location_device_id IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN oshal_cli_tokens.location_device_id IS
  'ADR-169 L6: the location device this credential is confined to (location_devices.device_id as text). NULL = not a location credential. A bound token authenticates ONLY on POST /api/location/devices/<id>/presence - see features/location/services/location-token-scope.ts.';

-- ===========================================================================
-- Helpers. None of them reads oshal.is_operator; the static guard
-- (tests/helpers/location-rls-guard.ts) fails the build if one ever does.
-- ===========================================================================

-- The device subject of the session, or NULL: 'device:<uuid>' as the core device ingest route stamps
-- it after verifying the credential binding. Any other subject, including a blank one, is not a device.
CREATE OR REPLACE FUNCTION location_device_subject_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('oshal.current_sub', true), '')
         ~ '^device:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN substr(current_setting('oshal.current_sub', true), 8)::uuid
    ELSE NULL
  END;
$$;

-- True when the session is the device subject of THIS device, the device reports, it has a recorded
-- credential, and its owner columns are exactly the row's. A definer: the device subject reads no
-- location_devices row of its own, so the predicate reads it on the subject's behalf.
CREATE OR REPLACE FUNCTION location_device_subject_owns(p_device uuid, p_owner_sub text, p_issuer text, p_tenant uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p_device IS NOT NULL
     AND p_device = location_device_subject_id()
     AND EXISTS (
       SELECT 1 FROM location_devices d
        WHERE d.device_id = p_device
          AND d.reporting_enabled
          AND d.credential_id IS NOT NULL
          AND d.owner_sub IS NOT DISTINCT FROM p_owner_sub
          AND d.principal_issuer IS NOT DISTINCT FROM p_issuer
          AND d.tenant_id IS NOT DISTINCT FROM p_tenant);
$$;

-- A place the device subject may read: one its device's owner may use (the L4 assignability rule),
-- so a fix can be placed against the owner's places and nobody else's.
CREATE OR REPLACE FUNCTION location_device_subject_place_readable(p_place uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT p_place IS NOT NULL AND EXISTS (
    SELECT 1 FROM location_devices d
     WHERE d.device_id = location_device_subject_id()
       AND d.reporting_enabled
       AND d.credential_id IS NOT NULL
       AND location_place_assignable(p_place, d.owner_sub, d.principal_issuer, d.tenant_id));
$$;

-- The device subject records when it last reported, and nothing else about its row.
CREATE OR REPLACE FUNCTION location_device_touch(p_device uuid, p_seen timestamptz)
  RETURNS boolean
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE location_devices
     SET last_seen_at = p_seen, updated_at = NOW()
   WHERE device_id = p_device
     AND device_id = location_device_subject_id()
     AND reporting_enabled
     AND credential_id IS NOT NULL
  RETURNING true;
$$;

-- Revoke the credential a device row names, when the session may write that row (its owner, or an
-- admin of its group). The token row belongs to whichever admin minted it, which is why this runs as
-- the definer: a group admin must be able to retire a credential another admin issued. Returns how
-- many token rows were revoked (0 when the device has none, or is not the session's to change).
CREATE OR REPLACE FUNCTION location_revoke_device_credential(p_device uuid)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  cred text;
  revoked integer := 0;
BEGIN
  SELECT d.credential_id INTO cred
    FROM location_devices d
   WHERE d.device_id = p_device
     AND location_row_writable(d.owner_sub, d.principal_issuer, d.tenant_id);
  IF cred IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE oshal_cli_tokens
     SET revoked_at = NOW()
   WHERE id = cred
     AND revoked_at IS NULL
     AND location_device_id = p_device::text;
  GET DIAGNOSTICS revoked = ROW_COUNT;
  UPDATE location_devices SET credential_id = NULL, updated_at = NOW() WHERE device_id = p_device;
  RETURN revoked;
END;
$$;

-- Whether a text names a location device by id. /api/join/enroll refuses such a client id, so a
-- node-bound token can never be minted for a location device's id. A definer so the answer does
-- not depend on whose device it is; it discloses only that a UUID is taken.
CREATE OR REPLACE FUNCTION location_device_named(p_ref text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN COALESCE(p_ref, '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN EXISTS (SELECT 1 FROM location_devices WHERE device_id = lower(p_ref)::uuid)
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION location_device_subject_owns(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION location_device_subject_place_readable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION location_device_touch(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION location_revoke_device_credential(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION location_device_named(text) FROM PUBLIC;

-- ===========================================================================
-- The device subject's policies. PERMISSIVE beside the person and tenant policies of migration 175;
-- a device subject matches none of those (its subject is no person's and no member's), so these are
-- the only rows it reaches.
-- ===========================================================================

-- Observations: the device inserts its own fixes and reads none.
DROP POLICY IF EXISTS location_observations_device_insert ON location_observations;
CREATE POLICY location_observations_device_insert ON location_observations AS PERMISSIVE FOR INSERT
  WITH CHECK (device_id IS NOT NULL
    AND subject_ref = 'device:' || device_id::text
    AND location_device_subject_owns(device_id, owner_sub, principal_issuer, tenant_id));

-- Current: the device reads and upserts its own row only.
DROP POLICY IF EXISTS location_current_device_read ON location_current;
CREATE POLICY location_current_device_read ON location_current AS PERMISSIVE FOR SELECT
  USING (device_id IS NOT NULL
    AND subject_ref = 'device:' || device_id::text
    AND location_device_subject_owns(device_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_current_device_insert ON location_current;
CREATE POLICY location_current_device_insert ON location_current AS PERMISSIVE FOR INSERT
  WITH CHECK (device_id IS NOT NULL
    AND subject_ref = 'device:' || device_id::text
    AND location_device_subject_owns(device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));
DROP POLICY IF EXISTS location_current_device_update ON location_current;
CREATE POLICY location_current_device_update ON location_current AS PERMISSIVE FOR UPDATE
  USING (device_id IS NOT NULL
    AND subject_ref = 'device:' || device_id::text
    AND location_device_subject_owns(device_id, owner_sub, principal_issuer, tenant_id))
  WITH CHECK (device_id IS NOT NULL
    AND subject_ref = 'device:' || device_id::text
    AND location_device_subject_owns(device_id, owner_sub, principal_issuer, tenant_id)
    AND location_place_assignable(place_id, owner_sub, principal_issuer, tenant_id));

-- Places: the device reads the places its owner may use, to place a fix. Never writes one.
DROP POLICY IF EXISTS location_places_device_read ON location_places;
CREATE POLICY location_places_device_read ON location_places AS PERMISSIVE FOR SELECT
  USING (location_device_subject_place_readable(place_id));

COMMENT ON FUNCTION location_device_subject_owns(uuid, text, text, uuid) IS
  'ADR-169 L6: the session is the device subject of this reporting, credentialed device and the row''s owner columns are the device''s.';
COMMENT ON FUNCTION location_revoke_device_credential(uuid) IS
  'ADR-169 L6: revoke the credential a device row names when the session may write the row (owner or group admin); clears credential_id.';
COMMENT ON FUNCTION location_device_named(text) IS
  'ADR-169 L6: whether a text is a location device id; /api/join/enroll refuses to mint a node token for one.';
