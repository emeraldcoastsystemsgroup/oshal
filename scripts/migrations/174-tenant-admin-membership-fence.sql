-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L2: the tenant admin helper and the membership fence. oshal_is_tenant_admin(tenant) is the SECURITY DEFINER twin of 060's oshal_is_tenant_member, restricted to role 'admin', and is what every location tenant-row write policy calls. The fence is a BEFORE INSERT / BEFORE UPDATE OF tenant_id, user_sub, role trigger on oshal_tenant_memberships: a membership change needs a writer who is already an admin of the target tenant, whatever oshal.is_operator says, except the creator's own first admin row of a tenant it just created. Without it, the membership policy's operator branch and its `user_sub = current_sub` WITH CHECK let an operator-stamped session, or any signed-in session for its own sub, join any tenant and then read every tenant row there. created_by_sub on oshal_tenants becomes fixed at creation, because the creator exception is keyed on it: an operator-stamped session could otherwise empty a tenant's memberships, rewrite its creator to itself and re-enter as the "first row". Both core writers already satisfy the fence (connector-tenancy.ts createTenant inserts the creator's admin row right after the tenant; addMember and setMemberRole run after the app-level admin check), and self-service display_name updates do not fire it.
-- -----------------------------------------------------------------------------

-- Admin twin of oshal_is_tenant_member (060). SECURITY DEFINER so the membership lookup is not
-- itself subject to the membership policy (no recursion), sub-only like its sibling because
-- memberships carry no issuer (ADR-169 D3). A blank session sub is never an admin: SYSTEM and
-- unstamped sessions carry '' and must never pass a tenant write policy.
CREATE OR REPLACE FUNCTION oshal_is_tenant_admin(p_tenant text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND EXISTS (
       SELECT 1
         FROM oshal_tenant_memberships m
        WHERE m.tenant_id::text = p_tenant
          AND m.user_sub = current_setting('oshal.current_sub', true)
          AND m.role = 'admin'
     );
$$;

REVOKE ALL ON FUNCTION oshal_is_tenant_admin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_is_tenant_admin(text) TO PUBLIC;

-- The membership fence. It reads memberships and tenants as the definer, so a policy that
-- filters the writer's view can never make "is there already an admin / a first row" answer
-- wrongly. It deliberately ignores oshal.is_operator: a swarm root is not a household admin.
CREATE OR REPLACE FUNCTION oshal_tenant_membership_fence()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  writer text := COALESCE(current_setting('oshal.current_sub', true), '');
BEGIN
  IF writer = '' THEN
    RAISE EXCEPTION 'oshal_tenant_memberships: a membership change needs a signed-in writer'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(NEW.user_sub, '') = '' THEN
    RAISE EXCEPTION 'oshal_tenant_memberships: a membership names a subject'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     AND NOT oshal_is_tenant_admin(OLD.tenant_id::text) THEN
    RAISE EXCEPTION 'oshal_tenant_memberships: only an admin of the tenant may move a membership out of it'
      USING ERRCODE = '42501';
  END IF;
  IF oshal_is_tenant_admin(NEW.tenant_id::text) THEN
    RETURN NEW;
  END IF;
  -- The creator's own first row: a tenant it created, with no membership yet, joined as admin.
  IF TG_OP = 'INSERT'
     AND NEW.user_sub = writer
     AND NEW.role = 'admin'
     AND EXISTS (SELECT 1 FROM oshal_tenants t
                  WHERE t.tenant_id = NEW.tenant_id AND t.created_by_sub = writer)
     AND NOT EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                      WHERE m.tenant_id = NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'oshal_tenant_memberships: only an admin of the tenant may add or change a membership'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION oshal_tenant_membership_fence() FROM PUBLIC;

DROP TRIGGER IF EXISTS oshal_tenant_membership_fence ON oshal_tenant_memberships;
CREATE TRIGGER oshal_tenant_membership_fence
  BEFORE INSERT OR UPDATE OF tenant_id, user_sub, role ON oshal_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION oshal_tenant_membership_fence();

-- created_by_sub is the creator exception's key, so it is fixed once the tenant exists.
CREATE OR REPLACE FUNCTION oshal_tenant_creator_fence()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.created_by_sub IS DISTINCT FROM OLD.created_by_sub THEN
    RAISE EXCEPTION 'oshal_tenants: created_by_sub is fixed when the tenant is created'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION oshal_tenant_creator_fence() FROM PUBLIC;

DROP TRIGGER IF EXISTS oshal_tenant_creator_fence ON oshal_tenants;
CREATE TRIGGER oshal_tenant_creator_fence
  BEFORE UPDATE OF created_by_sub ON oshal_tenants
  FOR EACH ROW EXECUTE FUNCTION oshal_tenant_creator_fence();

COMMENT ON FUNCTION oshal_is_tenant_admin(text) IS
  'ADR-169 D3: true when the session sub holds role admin in the tenant. Sub-only like oshal_is_tenant_member; a blank sub (SYSTEM, unstamped) is never an admin, and oshal.is_operator is not consulted.';
COMMENT ON FUNCTION oshal_tenant_membership_fence() IS
  'ADR-169 D3 membership fence: an insert or a tenant_id/user_sub/role update needs a writer who is already an admin of the tenant (and of the tenant a row leaves), regardless of oshal.is_operator, except the creator''s own first admin row of a tenant it created.';
