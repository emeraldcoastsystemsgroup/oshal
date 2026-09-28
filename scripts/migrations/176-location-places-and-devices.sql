-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L4: places and device enrolment. Two "since" columns: location_current.place_since (when the subject's latest fixes began falling in the place they are in now) and location_devices.place_assigned_at (when a stationary device's owner set its place), which the kernel read currentPlace reports. Cameras and drones have no owner record (D1), so a CHECK keeps their rows group-owned. The device identity fence is a BEFORE INSERT / BEFORE UPDATE OF kind, reference and owner columns trigger on location_devices: a device's kind and reference are fixed once enrolled; a node's location data may be enrolled, or moved between the person and a group, only by the node's ADR-114 owner (the remote_task_journal_client_owners binding, read as the definer); a TV's or hub's reference must carry the writer's own namespace key, so nobody can claim another person's TV room or hub device, and the global one-record-per-device constraint cannot be used to squat one. Row-level security still decides who may write the row at all (the owner, or a group admin for a group row): the fence decides only whose device it is. Like every location helper it never reads oshal.is_operator (operator decision Q2), and a blank writer (SYSTEM, unstamped) is refused.
-- -----------------------------------------------------------------------------

ALTER TABLE location_current ADD COLUMN IF NOT EXISTS place_since TIMESTAMPTZ;
ALTER TABLE location_devices ADD COLUMN IF NOT EXISTS place_assigned_at TIMESTAMPTZ;

-- Cameras and drones have no owner record: only a group admin enrols one, and only to that group (D1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'location_devices_group_only_kinds'
                    AND conrelid = 'location_devices'::regclass) THEN
    ALTER TABLE location_devices ADD CONSTRAINT location_devices_group_only_kinds
      CHECK (device_kind NOT IN ('camera', 'drone') OR tenant_id IS NOT NULL);
  END IF;
END $$;

-- The namespace key a person's TV and hub references carry: 16 hex characters of a digest of
-- the verified issuer and subject. The app computes the same key; NULL for a blank subject or
-- issuer, which therefore never matches any reference.
CREATE OR REPLACE FUNCTION location_owner_ref_key(p_sub text, p_issuer text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_sub, '') = '' OR COALESCE(p_issuer, '') = '' THEN NULL
    ELSE left(encode(sha256(convert_to(p_issuer || E'\n' || p_sub, 'UTF8')), 'hex'), 16)
  END;
$$;

-- Whose device a row is about. Runs as the definer so the node binding is read past its own
-- row-level security; the writer is always re-derived from the session, never from the row.
CREATE OR REPLACE FUNCTION location_device_identity_fence()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  writer text := COALESCE(current_setting('oshal.current_sub', true), '');
  writer_issuer text := COALESCE(current_setting('oshal.current_issuer', true), '');
  prefix text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.device_kind IS DISTINCT FROM OLD.device_kind OR NEW.device_ref IS DISTINCT FROM OLD.device_ref THEN
      RAISE EXCEPTION 'location_devices: a device''s kind and reference are fixed when it is enrolled'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.owner_sub IS NOT DISTINCT FROM OLD.owner_sub
       AND NEW.principal_issuer IS NOT DISTINCT FROM OLD.principal_issuer
       AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.device_kind = 'node' THEN
    IF writer = '' OR NOT EXISTS (SELECT 1 FROM remote_task_journal_client_owners o
                                   WHERE o.client_id = NEW.device_ref AND o.owner_sub = writer) THEN
      RAISE EXCEPTION 'location_devices: only the node''s owner may enrol its location data or move it'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.device_kind IN ('tv', 'hub') THEN
    prefix := NEW.device_kind || ':' || location_owner_ref_key(writer, writer_issuer) || ':';
    IF prefix IS NULL OR left(NEW.device_ref, length(prefix)) <> prefix THEN
      RAISE EXCEPTION 'location_devices: a TV or hub reference must be in the writer''s own namespace'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION location_device_identity_fence() FROM PUBLIC;

DROP TRIGGER IF EXISTS location_device_identity_fence ON location_devices;
CREATE TRIGGER location_device_identity_fence
  BEFORE INSERT OR UPDATE OF device_kind, device_ref, owner_sub, principal_issuer, tenant_id ON location_devices
  FOR EACH ROW EXECUTE FUNCTION location_device_identity_fence();

COMMENT ON FUNCTION location_device_identity_fence() IS
  'ADR-169 L4: a device''s kind and reference are fixed; a node''s location data is enrolled or moved only by its ADR-114 owner; a TV or hub reference carries the writer''s own namespace key. Row-level security still decides who may write the row.';
COMMENT ON COLUMN location_current.place_since IS
  'ADR-169 L4: when the subject''s latest fixes began falling in place_id (currentPlace "since").';
COMMENT ON COLUMN location_devices.place_assigned_at IS
  'ADR-169 L4: when the owner last set this stationary device''s place (currentPlace "since" for an assigned place).';
