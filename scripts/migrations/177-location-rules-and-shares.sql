-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-169 L5: proximity reminders and group presence. Six tables, each ENABLE + FORCE row-level security with hand-written policies and no oshal.is_operator branch (Q2): location_rules (a person's or a group's rule: subject, place, enter or exit, once or every visit, cooldown, accuracy floor, a remind or notify action; group rules carry an arm digest), location_rule_state (the per-rule, per-subject enter/exit hysteresis, owned by the SUBJECT), location_rule_fires (the idempotent fire ledger, UNIQUE(rule_id, subject_ref, transition_id), owned by the subject, readable by the rule's actor, with an evidence record that may not carry a coordinate), location_share_presence (a sharing member's, or a guarded minor's, enter/exit state at each approved place; the only rows the grantee projection reads), and location_restricted_invites (a group admin's invitation of one account to join as a restricted member). History rows (state, fires, share presence) have no foreign key to their rule or share, so an admin deleting a rule or a member revoking a share never deletes a subject's history: it stays until they purge it (Q4). Subjects write their own evaluation state only while a SECURITY DEFINER predicate confirms the rule is live for them, which for a group rule means an accepted, unexpired member share whose approved places still carry the approved geometry and include the rule's place. The acceptance function is the only writer of a restriction; the membership fence (migration 174) gains the one branch it needs to let an invited account join as a restricted member, and refuses admin to a restricted member. Grantees read presence only through location_shared_presence(), which re-checks share, membership and restriction on every read and returns places by reference, never coordinates. The dispatch-recovery sweep reads only claimed, undispatched fires, under its own broker GUC. Rules may act only by reminding or notifying in this slice; workflow and device actions widen the CHECK in their own slices.
-- -----------------------------------------------------------------------------

-- ===========================================================================
-- Tables
-- ===========================================================================

CREATE TABLE IF NOT EXISTS location_rules (
  rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  armed_by_sub TEXT NOT NULL,
  armed_by_issuer TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  place_id UUID NOT NULL REFERENCES location_places(place_id) ON DELETE CASCADE,
  on_transition TEXT NOT NULL DEFAULT 'enter',
  repeat_mode TEXT NOT NULL DEFAULT 'once',
  cooldown_sec INTEGER NOT NULL DEFAULT 900,
  accuracy_floor_m DOUBLE PRECISION NOT NULL DEFAULT 50,
  action_kind TEXT NOT NULL DEFAULT 'remind',
  action_text TEXT,
  arm_digest TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_rules_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> ''
      AND armed_by_sub = owner_sub AND armed_by_issuer = principal_issuer)
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_rules_armed_by CHECK (armed_by_sub <> '' AND armed_by_issuer <> ''),
  CONSTRAINT location_rules_subject CHECK (
    (subject_kind = 'person' AND subject_ref = armed_by_sub)
    OR (subject_kind = 'any-member' AND tenant_id IS NOT NULL AND subject_ref = 'tenant:' || tenant_id::text)
    OR (subject_kind = 'device' AND subject_ref ~ '^device:[0-9a-f-]{36}$')),
  CONSTRAINT location_rules_on CHECK (on_transition IN ('enter', 'exit')),
  CONSTRAINT location_rules_repeat CHECK (repeat_mode IN ('once', 'every-visit')),
  CONSTRAINT location_rules_cooldown CHECK (cooldown_sec BETWEEN 0 AND 604800),
  CONSTRAINT location_rules_accuracy CHECK (accuracy_floor_m BETWEEN 5 AND 500),
  CONSTRAINT location_rules_action CHECK (action_kind IN ('remind', 'notify')),
  CONSTRAINT location_rules_text CHECK (action_text IS NULL OR length(action_text) BETWEEN 1 AND 500),
  CONSTRAINT location_rules_group_digest CHECK (tenant_id IS NULL OR arm_digest IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS location_rule_state (
  rule_id UUID NOT NULL,
  subject_ref TEXT NOT NULL,
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  presence TEXT NOT NULL DEFAULT 'unknown',
  presence_since TIMESTAMPTZ,
  enter_candidate_at TIMESTAMPTZ,
  exit_candidate_at TIMESTAMPTZ,
  transition_seq INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0,
  last_fire_at TIMESTAMPTZ,
  last_fix_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (rule_id, subject_ref),
  CONSTRAINT location_rule_state_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_rule_state_presence CHECK (presence IN ('unknown', 'inside', 'outside')),
  CONSTRAINT location_rule_state_counts CHECK (transition_seq >= 0 AND fire_count >= 0)
);

CREATE TABLE IF NOT EXISTS location_rule_fires (
  fire_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL,
  subject_ref TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  owner_sub TEXT,
  principal_issuer TEXT,
  tenant_id UUID REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  actor_sub TEXT,
  actor_issuer TEXT,
  transition TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  place_id UUID,
  place_name TEXT,
  reminder_text TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  outcome TEXT,
  CONSTRAINT location_rule_fires_once UNIQUE (rule_id, subject_ref, transition_id),
  CONSTRAINT location_rule_fires_owner_shape CHECK (
    (tenant_id IS NULL AND COALESCE(owner_sub, '') <> '' AND COALESCE(principal_issuer, '') <> '')
    OR (tenant_id IS NOT NULL AND owner_sub IS NULL AND principal_issuer IS NULL)),
  CONSTRAINT location_rule_fires_actor CHECK ((actor_sub IS NULL) = (actor_issuer IS NULL)),
  CONSTRAINT location_rule_fires_transition CHECK (transition IN ('enter', 'exit')),
  CONSTRAINT location_rule_fires_action CHECK (action_kind IN ('remind', 'notify')),
  CONSTRAINT location_rule_fires_outcome CHECK (outcome IS NULL OR outcome ~ '^[a-z][a-z0-9-]{0,40}$'),
  -- Evidence provenance names the device, source, auth mode, mock flag, accuracy and receipt time;
  -- never a coordinate (ADR-169 D4 gate 5).
  CONSTRAINT location_rule_fires_evidence CHECK (
    jsonb_typeof(evidence) = 'object'
    AND NOT (evidence ?| ARRAY['lat', 'lon', 'latitude', 'longitude', 'point', 'coords', 'position', 'center']))
);

CREATE TABLE IF NOT EXISTS location_share_presence (
  share_kind TEXT NOT NULL,
  share_id UUID NOT NULL,
  place_id UUID NOT NULL,
  owner_sub TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  presence TEXT NOT NULL DEFAULT 'unknown',
  presence_since TIMESTAMPTZ,
  enter_candidate_at TIMESTAMPTZ,
  exit_candidate_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (share_kind, share_id, place_id),
  CONSTRAINT location_share_presence_owner_shape CHECK (owner_sub <> '' AND principal_issuer <> ''),
  CONSTRAINT location_share_presence_kind CHECK (share_kind IN ('member', 'guardian')),
  CONSTRAINT location_share_presence_presence CHECK (presence IN ('unknown', 'inside', 'outside'))
);

CREATE TABLE IF NOT EXISTS location_restricted_invites (
  invite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  user_sub TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  issued_by_sub TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_xact BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT location_restricted_invites_one UNIQUE (tenant_id, user_sub, principal_issuer),
  CONSTRAINT location_restricted_invites_subjects CHECK (user_sub <> '' AND principal_issuer <> '' AND issued_by_sub <> ''),
  CONSTRAINT location_restricted_invites_not_self CHECK (user_sub <> issued_by_sub)
);

CREATE INDEX IF NOT EXISTS location_rules_owner_idx ON location_rules (owner_sub, principal_issuer) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS location_rules_tenant_idx ON location_rules (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_rules_subject_idx ON location_rules (subject_ref);
CREATE INDEX IF NOT EXISTS location_rule_state_owner_idx ON location_rule_state (owner_sub, principal_issuer);
CREATE INDEX IF NOT EXISTS location_rule_fires_owner_idx ON location_rule_fires (owner_sub, principal_issuer, fired_at);
CREATE INDEX IF NOT EXISTS location_rule_fires_actor_idx ON location_rule_fires (actor_sub, actor_issuer, fired_at);
CREATE INDEX IF NOT EXISTS location_rule_fires_pending_idx ON location_rule_fires (claimed_at) WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS location_share_presence_owner_idx ON location_share_presence (owner_sub, principal_issuer);
CREATE INDEX IF NOT EXISTS location_restricted_invites_user_idx ON location_restricted_invites (user_sub, principal_issuer);

-- ===========================================================================
-- Helpers. None reads oshal.is_operator (tests/helpers/location-rls-guard.ts).
-- ===========================================================================

-- The session's verified issuer ('' when unstamped).
CREATE OR REPLACE FUNCTION location_session_issuer()
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT COALESCE(current_setting('oshal.current_issuer', true), '');
$$;

-- A group rule's arm digest: every field that decides whether and when it fires, including its
-- place's geometry. Any edit to any of them, by anyone, leaves the stored digest stale, and a stale
-- digest disarms the rule (ADR-169 D4 gate 4).
CREATE OR REPLACE FUNCTION location_rule_arm_digest(
  p_tenant uuid, p_subject_kind text, p_subject_ref text, p_place uuid, p_on text, p_repeat text,
  p_cooldown integer, p_floor double precision, p_action text)
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\n',
    'tenant:' || COALESCE(p_tenant::text, ''), p_subject_kind, p_subject_ref, p_place::text,
    p.center_lat::text, p.center_lon::text, p.radius_m::text, p_on, p_repeat, p_cooldown::text,
    p_floor::text, p_action), 'UTF8')), 'hex')
  FROM location_places p WHERE p.place_id = p_place;
$$;

-- The session's active member share with the group covers this place: unrevoked, unexpired, the
-- approved places still carry the approved geometry, the member is still a member and is not
-- restricted there (ADR-169 D6).
CREATE OR REPLACE FUNCTION location_session_shares_place(p_tenant uuid, p_place uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND EXISTS (SELECT 1 FROM location_shares s
                  WHERE s.tenant_id = p_tenant
                    AND s.owner_sub = current_setting('oshal.current_sub', true)
                    AND s.principal_issuer = location_session_issuer()
                    AND s.revoked_at IS NULL
                    AND (s.expires_at IS NULL OR s.expires_at > NOW())
                    AND p_place = ANY (s.place_ids)
                    AND location_places_digest(s.tenant_id, s.place_ids) = s.geometry_digest)
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                  WHERE m.tenant_id = p_tenant AND m.user_sub = current_setting('oshal.current_sub', true))
     AND NOT EXISTS (SELECT 1 FROM location_member_restrictions r
                      WHERE r.tenant_id = p_tenant AND r.user_sub = current_setting('oshal.current_sub', true));
$$;

-- A rule may be written by the session: a person arms their own rule about themself (or their own
-- device) at their own place or a place of a group they belong to; a group admin arms a group rule
-- at one of the group's places about any sharing member, themself, or one of the group's devices.
-- Foreign-key checks bypass row-level security, so this is what stops a rule naming anyone's place
-- or device.
CREATE OR REPLACE FUNCTION location_rule_admissible(
  p_owner_sub text, p_issuer text, p_tenant uuid, p_armed_by text, p_armed_issuer text,
  p_subject_kind text, p_subject_ref text, p_place uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND p_armed_by = current_setting('oshal.current_sub', true)
     AND p_armed_issuer = location_session_issuer()
     AND CASE WHEN p_tenant IS NULL THEN
           location_owner_is_session(p_owner_sub, p_issuer)
           AND EXISTS (SELECT 1 FROM location_places p WHERE p.place_id = p_place
                        AND ((p.tenant_id IS NULL AND p.owner_sub = p_owner_sub AND p.principal_issuer = p_issuer)
                          OR (p.tenant_id IS NOT NULL AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                                WHERE m.tenant_id = p.tenant_id AND m.user_sub = p_owner_sub))))
           AND (p_subject_kind = 'person'
             OR (p_subject_kind = 'device' AND EXISTS (SELECT 1 FROM location_devices d
                  WHERE 'device:' || d.device_id::text = p_subject_ref AND d.tenant_id IS NULL
                    AND d.owner_sub = p_owner_sub AND d.principal_issuer = p_issuer)))
         ELSE
           oshal_is_tenant_admin(p_tenant::text)
           AND EXISTS (SELECT 1 FROM location_places p WHERE p.place_id = p_place AND p.tenant_id = p_tenant)
           AND (p_subject_kind IN ('person', 'any-member')
             OR (p_subject_kind = 'device' AND EXISTS (SELECT 1 FROM location_devices d
                  WHERE 'device:' || d.device_id::text = p_subject_ref AND d.tenant_id = p_tenant)))
         END;
$$;

-- The session subject may be evaluated against this rule now. A person's own rule: it is theirs,
-- unfinished, about them. A group rule: unfinished, its arm digest current, its arming admin still an
-- admin, and the subject holds an active member share covering the rule's place. Device subjects are
-- evaluated by the device ingest (slice L6) and are not admitted here.
CREATE OR REPLACE FUNCTION location_rule_evaluable(p_rule uuid, p_subject text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND p_subject = current_setting('oshal.current_sub', true)
     AND EXISTS (
       SELECT 1 FROM location_rules r
        WHERE r.rule_id = p_rule AND r.completed_at IS NULL
          AND ((r.tenant_id IS NULL AND r.subject_kind = 'person'
                AND r.owner_sub = p_subject AND r.principal_issuer = location_session_issuer())
            OR (r.tenant_id IS NOT NULL
                AND (r.subject_kind = 'any-member' OR (r.subject_kind = 'person' AND r.subject_ref = p_subject))
                AND r.arm_digest = location_rule_arm_digest(r.tenant_id, r.subject_kind, r.subject_ref, r.place_id,
                      r.on_transition, r.repeat_mode, r.cooldown_sec, r.accuracy_floor_m, r.action_kind)
                AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                             WHERE m.tenant_id = r.tenant_id AND m.user_sub = r.armed_by_sub AND m.role = 'admin')
                AND location_session_shares_place(r.tenant_id, r.place_id))));
$$;

-- A fire row may be claimed by the subject for a live rule, naming the rule's own actor.
CREATE OR REPLACE FUNCTION location_fire_admissible(p_rule uuid, p_subject text, p_actor text, p_actor_issuer text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT location_rule_evaluable(p_rule, p_subject)
     AND EXISTS (SELECT 1 FROM location_rules r
                  WHERE r.rule_id = p_rule AND r.armed_by_sub = p_actor AND r.armed_by_issuer = p_actor_issuer);
$$;

-- The session subject may keep presence for this share and place: an active member share of theirs
-- covering the place, or an unrevoked guardian share naming them while they are still a restricted
-- member of its group.
CREATE OR REPLACE FUNCTION location_share_presence_writable(p_kind text, p_share uuid, p_place uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(current_setting('oshal.current_sub', true), '') <> ''
     AND CASE p_kind
       WHEN 'member' THEN EXISTS (SELECT 1 FROM location_shares s WHERE s.share_id = p_share
                                    AND location_session_shares_place(s.tenant_id, p_place)
                                    AND s.owner_sub = current_setting('oshal.current_sub', true)
                                    AND s.principal_issuer = location_session_issuer()
                                    AND s.revoked_at IS NULL AND p_place = ANY (s.place_ids))
       WHEN 'guardian' THEN EXISTS (SELECT 1 FROM location_guardian_shares g
                                     WHERE g.share_id = p_share AND g.revoked_at IS NULL
                                       AND g.user_sub = current_setting('oshal.current_sub', true)
                                       AND p_place = ANY (g.place_ids)
                                       AND location_places_digest(g.tenant_id, g.place_ids) = g.geometry_digest
                                       AND EXISTS (SELECT 1 FROM location_member_restrictions r
                                                    WHERE r.tenant_id = g.tenant_id AND r.user_sub = g.user_sub))
       ELSE false
     END;
$$;

-- An invitation may name only an account that holds no admin role in the group.
CREATE OR REPLACE FUNCTION location_invite_admissible(p_tenant uuid, p_user text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT oshal_is_tenant_admin(p_tenant::text)
     AND NOT EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                      WHERE m.tenant_id = p_tenant AND m.user_sub = p_user AND m.role = 'admin');
$$;

-- The one writer of a restriction (ADR-169 D3/D6, Q5). The invited account (subject AND issuer)
-- accepts an unexpired invitation that a CURRENT admin of the group issued; an account that holds
-- admin in the group is refused. It joins the group as a member if it is not one (the membership
-- fence admits exactly this row, keyed on the invitation accepted in this transaction), the
-- restriction is written, and the invitation is removed. Returns a status word, never raises for a
-- refusal the caller should explain.
CREATE OR REPLACE FUNCTION location_accept_restricted_invite(p_invite uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  writer text := COALESCE(current_setting('oshal.current_sub', true), '');
  writer_issuer text := location_session_issuer();
  inv location_restricted_invites%ROWTYPE;
BEGIN
  IF writer = '' OR writer_issuer = '' THEN
    RETURN 'not-found';
  END IF;
  SELECT * INTO inv FROM location_restricted_invites WHERE invite_id = p_invite FOR UPDATE;
  IF NOT FOUND OR inv.user_sub <> writer OR inv.principal_issuer <> writer_issuer THEN
    RETURN 'not-found';
  END IF;
  IF inv.expires_at <= NOW() THEN
    RETURN 'expired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                  WHERE m.tenant_id = inv.tenant_id AND m.user_sub = inv.issued_by_sub AND m.role = 'admin') THEN
    RETURN 'issuer-not-admin';
  END IF;
  IF EXISTS (SELECT 1 FROM oshal_tenant_memberships m
              WHERE m.tenant_id = inv.tenant_id AND m.user_sub = writer AND m.role = 'admin') THEN
    RETURN 'is-admin';
  END IF;
  UPDATE location_restricted_invites SET accepted_xact = txid_current() WHERE invite_id = p_invite;
  IF NOT EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = inv.tenant_id AND m.user_sub = writer) THEN
    INSERT INTO oshal_tenant_memberships (tenant_id, user_sub, role) VALUES (inv.tenant_id, writer, 'member');
  END IF;
  INSERT INTO location_member_restrictions (tenant_id, user_sub, issued_by_sub)
    VALUES (inv.tenant_id, writer, inv.issued_by_sub)
    ON CONFLICT (tenant_id, user_sub) DO NOTHING;
  DELETE FROM location_restricted_invites WHERE invite_id = p_invite;
  RETURN 'accepted';
END;
$$;

REVOKE ALL ON FUNCTION location_accept_restricted_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_accept_restricted_invite(uuid) TO PUBLIC;

-- The membership fence (migration 174), with the two L5 branches: a restricted member cannot be
-- given admin (an admin removes the restriction first), and the invited account's own member row
-- is admitted while the acceptance function redeems its invitation in this transaction.
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
  IF NEW.role = 'admin' AND EXISTS (SELECT 1 FROM location_member_restrictions r
                                     WHERE r.tenant_id = NEW.tenant_id AND r.user_sub = NEW.user_sub) THEN
    RAISE EXCEPTION 'oshal_tenant_memberships: a restricted member cannot hold admin; remove the restriction first'
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
  -- Redeeming a restricted invitation: the invited account's own member row, in the transaction in
  -- which location_accept_restricted_invite accepted an invitation a current admin issued to it.
  IF TG_OP = 'INSERT'
     AND NEW.user_sub = writer
     AND NEW.role = 'member'
     AND EXISTS (SELECT 1 FROM location_restricted_invites i
                  WHERE i.tenant_id = NEW.tenant_id AND i.user_sub = writer
                    AND i.principal_issuer = COALESCE(current_setting('oshal.current_issuer', true), '')
                    AND i.accepted_xact = txid_current()
                    AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m
                                 WHERE m.tenant_id = i.tenant_id AND m.user_sub = i.issued_by_sub AND m.role = 'admin')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'oshal_tenant_memberships: only an admin of the tenant may add or change a membership'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION oshal_tenant_membership_fence() FROM PUBLIC;

-- What the session may read of other people's presence (ADR-169 D3 "Grantees read a projection"):
-- a member share's presence to the CURRENT members of its group, a guardian share's to its named
-- grantees while they are members. Every read re-checks the share (unrevoked, unexpired, geometry
-- as approved), the place (in the approved set, the group's own), the grantor's membership and,
-- for a guardian share, that the minor is still a restricted member. Places by reference only.
CREATE OR REPLACE FUNCTION location_shared_presence()
  RETURNS TABLE (share_kind text, share_id uuid, tenant_id uuid, subject_sub text, place_id uuid,
                 place_name text, place_label text, transition text, since timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  WITH reader AS (
    SELECT COALESCE(current_setting('oshal.current_sub', true), '') AS sub, location_session_issuer() AS issuer
  )
  SELECT 'member'::text, s.share_id, s.tenant_id, s.owner_sub, p.place_id, p.name, p.label,
         CASE sp.presence WHEN 'inside' THEN 'enter' ELSE 'exit' END, sp.presence_since
    FROM reader, location_share_presence sp
    JOIN location_shares s ON sp.share_kind = 'member' AND s.share_id = sp.share_id
    JOIN location_places p ON p.place_id = sp.place_id AND p.tenant_id = s.tenant_id
   WHERE reader.sub <> '' AND reader.issuer <> ''
     AND sp.presence IN ('inside', 'outside')
     AND sp.owner_sub = s.owner_sub AND sp.principal_issuer = s.principal_issuer
     AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW())
     AND sp.place_id = ANY (s.place_ids)
     AND location_places_digest(s.tenant_id, s.place_ids) = s.geometry_digest
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = s.tenant_id AND m.user_sub = reader.sub)
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = s.tenant_id AND m.user_sub = s.owner_sub)
     AND NOT EXISTS (SELECT 1 FROM location_member_restrictions r WHERE r.tenant_id = s.tenant_id AND r.user_sub = s.owner_sub)
  UNION ALL
  SELECT 'guardian'::text, g.share_id, g.tenant_id, g.user_sub, p.place_id, p.name, p.label,
         CASE sp.presence WHEN 'inside' THEN 'enter' ELSE 'exit' END, sp.presence_since
    FROM reader, location_share_presence sp
    JOIN location_guardian_shares g ON sp.share_kind = 'guardian' AND g.share_id = sp.share_id
    JOIN location_places p ON p.place_id = sp.place_id AND p.tenant_id = g.tenant_id
   WHERE reader.sub <> '' AND reader.issuer <> ''
     AND sp.presence IN ('inside', 'outside')
     AND sp.owner_sub = g.user_sub
     AND g.revoked_at IS NULL
     AND sp.place_id = ANY (g.place_ids)
     AND location_places_digest(g.tenant_id, g.place_ids) = g.geometry_digest
     AND g.grantees @> jsonb_build_array(jsonb_build_object('sub', reader.sub, 'issuer', reader.issuer))
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = g.tenant_id AND m.user_sub = reader.sub)
     AND EXISTS (SELECT 1 FROM oshal_tenant_memberships m WHERE m.tenant_id = g.tenant_id AND m.user_sub = g.user_sub)
     AND EXISTS (SELECT 1 FROM location_member_restrictions r WHERE r.tenant_id = g.tenant_id AND r.user_sub = g.user_sub);
$$;

REVOKE ALL ON FUNCTION location_shared_presence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_shared_presence() TO PUBLIC;

-- Mark one claimed fire dispatched. Only the fire's actor may, under their own identity (the
-- dispatcher switches to it per fire, ADR-169 D3 "Dispatch identity"); the recovery sweep, under
-- its broker GUC, may only close a fire whose actor was erased (it can never be delivered).
CREATE OR REPLACE FUNCTION location_mark_fire_dispatched(p_fire uuid, p_outcome text)
  RETURNS boolean
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  WITH done AS (
    UPDATE location_rule_fires f SET dispatched_at = NOW(), outcome = p_outcome
     WHERE f.fire_id = p_fire AND f.dispatched_at IS NULL
       AND ((COALESCE(current_setting('oshal.current_sub', true), '') <> ''
             AND f.actor_sub = current_setting('oshal.current_sub', true)
             AND f.actor_issuer = location_session_issuer())
         OR (f.actor_sub IS NULL AND p_outcome = 'actor-erased'
             AND COALESCE(current_setting('oshal.location_dispatch_broker', true), '') = 'on'))
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM done);
$$;

REVOKE ALL ON FUNCTION location_mark_fire_dispatched(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_mark_fire_dispatched(uuid, text) TO PUBLIC;

-- The group-rule half of a person's location erase (ADR-169 D6): the group rules the session armed
-- or names as their subject are deleted, and their name is taken off fires they were the actor of,
-- so no group's rule tables name them afterwards. Acts only for the session's own subject.
CREATE OR REPLACE FUNCTION location_erase_session_rule_references()
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  writer text := COALESCE(current_setting('oshal.current_sub', true), '');
  writer_issuer text := location_session_issuer();
  removed integer := 0;
  cleared integer := 0;
BEGIN
  IF writer = '' OR writer_issuer = '' THEN
    RETURN 0;
  END IF;
  DELETE FROM location_rules r
   WHERE r.tenant_id IS NOT NULL
     AND ((r.armed_by_sub = writer AND r.armed_by_issuer = writer_issuer)
       OR (r.subject_kind = 'person' AND r.subject_ref = writer));
  GET DIAGNOSTICS removed = ROW_COUNT;
  UPDATE location_rule_fires f SET actor_sub = NULL, actor_issuer = NULL
   WHERE f.actor_sub = writer AND f.actor_issuer = writer_issuer;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN removed + cleared;
END;
$$;

REVOKE ALL ON FUNCTION location_erase_session_rule_references() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_erase_session_rule_references() TO PUBLIC;

-- ===========================================================================
-- Row-level security: ENABLE + FORCE, no oshal.is_operator branch anywhere.
-- ===========================================================================

ALTER TABLE location_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE location_rule_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_rule_state FORCE ROW LEVEL SECURITY;
ALTER TABLE location_rule_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_rule_fires FORCE ROW LEVEL SECURITY;
ALTER TABLE location_share_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_share_presence FORCE ROW LEVEL SECURITY;
ALTER TABLE location_restricted_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_restricted_invites FORCE ROW LEVEL SECURITY;

-- Rules: the owner, or the group (members read, admins write), plus the subject a rule names.
DROP POLICY IF EXISTS location_rules_read ON location_rules;
CREATE POLICY location_rules_read ON location_rules AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id)
    OR (subject_ref <> '' AND subject_ref = current_setting('oshal.current_sub', true)));
DROP POLICY IF EXISTS location_rules_insert ON location_rules;
CREATE POLICY location_rules_insert ON location_rules AS PERMISSIVE FOR INSERT
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_rule_admissible(owner_sub, principal_issuer, tenant_id, armed_by_sub, armed_by_issuer,
                                 subject_kind, subject_ref, place_id));
DROP POLICY IF EXISTS location_rules_update ON location_rules;
CREATE POLICY location_rules_update ON location_rules AS PERMISSIVE FOR UPDATE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id))
  WITH CHECK (location_row_writable(owner_sub, principal_issuer, tenant_id)
    AND location_rule_admissible(owner_sub, principal_issuer, tenant_id, armed_by_sub, armed_by_issuer,
                                 subject_kind, subject_ref, place_id));
DROP POLICY IF EXISTS location_rules_delete ON location_rules;
CREATE POLICY location_rules_delete ON location_rules AS PERMISSIVE FOR DELETE
  USING (location_row_writable(owner_sub, principal_issuer, tenant_id));

-- Rule state: the subject's own rows; written only while the rule is live for them; deleted only
-- by the subject's purge.
DROP POLICY IF EXISTS location_rule_state_read ON location_rule_state;
CREATE POLICY location_rule_state_read ON location_rule_state AS PERMISSIVE FOR SELECT
  USING (location_row_readable(owner_sub, principal_issuer, tenant_id) AND tenant_id IS NULL);
DROP POLICY IF EXISTS location_rule_state_insert ON location_rule_state;
CREATE POLICY location_rule_state_insert ON location_rule_state AS PERMISSIVE FOR INSERT
  WITH CHECK (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer)
    AND location_rule_evaluable(rule_id, subject_ref));
DROP POLICY IF EXISTS location_rule_state_update ON location_rule_state;
CREATE POLICY location_rule_state_update ON location_rule_state AS PERMISSIVE FOR UPDATE
  USING (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer))
  WITH CHECK (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer)
    AND location_rule_evaluable(rule_id, subject_ref));
DROP POLICY IF EXISTS location_rule_state_purge ON location_rule_state;
CREATE POLICY location_rule_state_purge ON location_rule_state AS PERMISSIVE FOR DELETE
  USING (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer));

-- Fires: the subject's own rows and the rows naming the session as actor; claimed only by the
-- subject for a live rule; read by the recovery sweep only while claimed and undispatched; no
-- UPDATE policy (location_mark_fire_dispatched is the only way a fire is marked); deleted only by
-- the subject's purge.
DROP POLICY IF EXISTS location_rule_fires_read ON location_rule_fires;
CREATE POLICY location_rule_fires_read ON location_rule_fires AS PERMISSIVE FOR SELECT
  USING ((tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer))
    OR (COALESCE(actor_sub, '') <> '' AND actor_sub = current_setting('oshal.current_sub', true)
        AND actor_issuer = location_session_issuer())
    OR (COALESCE(current_setting('oshal.location_dispatch_broker', true), '') = 'on' AND dispatched_at IS NULL));
DROP POLICY IF EXISTS location_rule_fires_insert ON location_rule_fires;
CREATE POLICY location_rule_fires_insert ON location_rule_fires AS PERMISSIVE FOR INSERT
  WITH CHECK (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer)
    AND dispatched_at IS NULL
    AND location_fire_admissible(rule_id, subject_ref, actor_sub, actor_issuer));
DROP POLICY IF EXISTS location_rule_fires_purge ON location_rule_fires;
CREATE POLICY location_rule_fires_purge ON location_rule_fires AS PERMISSIVE FOR DELETE
  USING (tenant_id IS NULL AND location_owner_is_session(owner_sub, principal_issuer));

-- Share presence: the subject's own rows, written only while the share is live for them; grantees
-- have no policy here and read location_shared_presence().
DROP POLICY IF EXISTS location_share_presence_read ON location_share_presence;
CREATE POLICY location_share_presence_read ON location_share_presence AS PERMISSIVE FOR SELECT
  USING (location_owner_is_session(owner_sub, principal_issuer));
DROP POLICY IF EXISTS location_share_presence_insert ON location_share_presence;
CREATE POLICY location_share_presence_insert ON location_share_presence AS PERMISSIVE FOR INSERT
  WITH CHECK (location_owner_is_session(owner_sub, principal_issuer)
    AND location_share_presence_writable(share_kind, share_id, place_id));
DROP POLICY IF EXISTS location_share_presence_update ON location_share_presence;
CREATE POLICY location_share_presence_update ON location_share_presence AS PERMISSIVE FOR UPDATE
  USING (location_owner_is_session(owner_sub, principal_issuer))
  WITH CHECK (location_owner_is_session(owner_sub, principal_issuer)
    AND location_share_presence_writable(share_kind, share_id, place_id));
DROP POLICY IF EXISTS location_share_presence_purge ON location_share_presence;
CREATE POLICY location_share_presence_purge ON location_share_presence AS PERMISSIVE FOR DELETE
  USING (location_owner_is_session(owner_sub, principal_issuer));

-- Restricted invitations: issued only by a group admin to an account that holds no admin there;
-- read by the invited account and the group's admins; declined by the invited account or withdrawn
-- by an admin; no UPDATE policy (location_accept_restricted_invite is the only way one is accepted).
DROP POLICY IF EXISTS location_restricted_invites_read ON location_restricted_invites;
CREATE POLICY location_restricted_invites_read ON location_restricted_invites AS PERMISSIVE FOR SELECT
  USING ((user_sub = current_setting('oshal.current_sub', true) AND principal_issuer = location_session_issuer())
    OR oshal_is_tenant_admin(tenant_id::text));
DROP POLICY IF EXISTS location_restricted_invites_insert ON location_restricted_invites;
CREATE POLICY location_restricted_invites_insert ON location_restricted_invites AS PERMISSIVE FOR INSERT
  WITH CHECK (issued_by_sub = current_setting('oshal.current_sub', true)
    AND accepted_xact IS NULL
    AND location_invite_admissible(tenant_id, user_sub));
DROP POLICY IF EXISTS location_restricted_invites_delete ON location_restricted_invites;
CREATE POLICY location_restricted_invites_delete ON location_restricted_invites AS PERMISSIVE FOR DELETE
  USING ((user_sub = current_setting('oshal.current_sub', true) AND principal_issuer = location_session_issuer())
    OR oshal_is_tenant_admin(tenant_id::text));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON location_rules, location_rule_state, location_share_presence TO oshal_app;
    GRANT SELECT, INSERT, DELETE ON location_rule_fires, location_restricted_invites TO oshal_app;
  END IF;
END $$;

COMMENT ON TABLE location_rules IS
  'ADR-169 D4/L5: proximity rules (remind or notify on enter or exit). A group rule carries an arm digest; any edit disarms it. Row-level security has no operator branch (Q2).';
COMMENT ON TABLE location_rule_fires IS
  'ADR-169 D4/L5: the fire ledger, owned by the subject, readable by the rule''s actor. Records outside the location tables carry only rule and fire ids.';
COMMENT ON FUNCTION location_shared_presence() IS
  'ADR-169 D3/L5: the grantee projection. Place transitions of sharing members (to current members) and of guarded minors (to named grantees), re-checked on every read; never coordinates.';
COMMENT ON FUNCTION location_accept_restricted_invite(uuid) IS
  'ADR-169 D6/Q5: the only writer of location_member_restrictions. The invited account accepts an unexpired invitation a current admin issued; an admin of the group is refused.';
