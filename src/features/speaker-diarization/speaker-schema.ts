/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added idempotent owner-RLS schema for encrypted speaker profiles, monotonic ordinals, assignments, and trusted transcript profile references.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added owner-private short-lived speaker observation idempotency ledger.
 */

import { buildOwnerRlsPolicyStatements } from '@/shared/services/database';

const SPEAKER_TABLE_STATEMENTS = [
  'ALTER TABLE oshal_tenant_memberships ADD COLUMN IF NOT EXISTS display_name TEXT',
  `CREATE TABLE IF NOT EXISTS ambient_speaker_profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT NOT NULL,
    unidentified_ordinal INTEGER NOT NULL CHECK (unidentified_ordinal > 0),
    embedding_ciphertext TEXT NOT NULL, embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions BETWEEN 2 AND 4096),
    sample_count INTEGER NOT NULL DEFAULT 1 CHECK (sample_count > 0),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_sub, unidentified_ordinal), UNIQUE (profile_id, owner_sub))`,
  `CREATE TABLE IF NOT EXISTS ambient_speaker_ordinal_counters (
    owner_sub TEXT PRIMARY KEY, next_ordinal INTEGER NOT NULL CHECK (next_ordinal > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ambient_speaker_assignments (
    profile_id UUID PRIMARY KEY, owner_sub TEXT NOT NULL,
    assignment_kind TEXT NOT NULL CHECK (assignment_kind IN ('self','custom','tenant_member')),
    custom_name TEXT, tenant_id UUID, member_sub TEXT,
    assigned_by_sub TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ambient_speaker_assignment_profile_fk FOREIGN KEY (profile_id, owner_sub)
      REFERENCES ambient_speaker_profiles(profile_id, owner_sub) ON DELETE CASCADE,
    CONSTRAINT ambient_speaker_assignment_target_membership_fk FOREIGN KEY (tenant_id, member_sub)
      REFERENCES oshal_tenant_memberships(tenant_id, user_sub) ON DELETE CASCADE,
    CONSTRAINT ambient_speaker_assignment_owner_membership_fk FOREIGN KEY (tenant_id, owner_sub)
      REFERENCES oshal_tenant_memberships(tenant_id, user_sub) ON DELETE CASCADE,
    CHECK (
      (assignment_kind='self' AND custom_name IS NULL AND tenant_id IS NULL AND member_sub IS NULL)
      OR (assignment_kind='custom' AND custom_name IS NOT NULL AND tenant_id IS NULL AND member_sub IS NULL)
      OR (assignment_kind='tenant_member' AND custom_name IS NULL AND tenant_id IS NOT NULL AND member_sub IS NOT NULL)
    ))`,
  `CREATE TABLE IF NOT EXISTS ambient_speaker_observations (
    owner_sub TEXT NOT NULL, client_chunk_id TEXT NOT NULL, speaker_key TEXT NOT NULL,
    profile_id UUID NOT NULL, similarity DOUBLE PRECISION NOT NULL,
    created_profile BOOLEAN NOT NULL, observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_sub,client_chunk_id,speaker_key),
    CONSTRAINT ambient_speaker_observation_profile_fk FOREIGN KEY (profile_id,owner_sub)
      REFERENCES ambient_speaker_profiles(profile_id,owner_sub) ON DELETE CASCADE)`,
  'CREATE INDEX IF NOT EXISTS ambient_speaker_profiles_owner_seen ON ambient_speaker_profiles (owner_sub, last_seen_at DESC)',
  'CREATE INDEX IF NOT EXISTS ambient_speaker_assignments_member ON ambient_speaker_assignments (tenant_id, member_sub) WHERE tenant_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ambient_speaker_observations_owner_time ON ambient_speaker_observations (owner_sub,observed_at)',
  "CREATE UNIQUE INDEX IF NOT EXISTS ambient_speaker_one_self_per_owner ON ambient_speaker_assignments (owner_sub) WHERE assignment_kind='self'",
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ambient_speaker_assignment_owner_membership_fk') THEN
      ALTER TABLE ambient_speaker_assignments ADD CONSTRAINT ambient_speaker_assignment_owner_membership_fk
        FOREIGN KEY (tenant_id,owner_sub) REFERENCES oshal_tenant_memberships(tenant_id,user_sub) ON DELETE CASCADE;
    END IF;
  END $$`,
];

const TRANSCRIPT_LINK_STATEMENTS = [
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname='ambient_settings_speaker_membership_fk'
        AND conrelid='ambient_user_settings'::regclass
    ) THEN
      ALTER TABLE ambient_user_settings ADD CONSTRAINT ambient_settings_speaker_membership_fk
        FOREIGN KEY (speaker_tenant_id,user_sub) REFERENCES oshal_tenant_memberships(tenant_id,user_sub)
        ON DELETE SET NULL (speaker_tenant_id);
    END IF;
  END $$`,
  'ALTER TABLE ambient_transcript_segments ADD COLUMN IF NOT EXISTS speaker_profile_id UUID',
  `DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname='ambient_segments_speaker_profile_fk'
        AND conrelid='ambient_transcript_segments'::regclass AND array_length(conkey,1)=1
    ) THEN
      ALTER TABLE ambient_transcript_segments DROP CONSTRAINT ambient_segments_speaker_profile_fk;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname='ambient_segments_speaker_profile_fk'
        AND conrelid='ambient_transcript_segments'::regclass
    ) THEN
      ALTER TABLE ambient_transcript_segments ADD CONSTRAINT ambient_segments_speaker_profile_fk
        FOREIGN KEY (speaker_profile_id,user_sub) REFERENCES ambient_speaker_profiles(profile_id,owner_sub)
        ON DELETE SET NULL (speaker_profile_id);
    END IF;
  END $$`,
  'CREATE INDEX IF NOT EXISTS ambient_segments_speaker_profile ON ambient_transcript_segments (speaker_profile_id) WHERE speaker_profile_id IS NOT NULL',
  `UPDATE ambient_transcript_segments AS segment
   SET speaker_label='Unidentified Person ' || profile.unidentified_ordinal
   FROM ambient_speaker_profiles AS profile
   WHERE segment.speaker_profile_id=profile.profile_id
     AND segment.user_sub=profile.owner_sub
     AND segment.speaker_label IS DISTINCT FROM
         ('Unidentified Person ' || profile.unidentified_ordinal)`,
];

const ASSIGNMENT_TARGET_PRIVACY_POLICIES = [
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy
      WHERE polname='ambient_speaker_assignments_target_select'
        AND polrelid='ambient_speaker_assignments'::regclass) THEN
      CREATE POLICY ambient_speaker_assignments_target_select ON ambient_speaker_assignments
        AS PERMISSIVE FOR SELECT USING (
          member_sub=current_setting('oshal.current_sub',true)
          OR current_setting('oshal.is_operator',true)='on');
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy
      WHERE polname='ambient_speaker_assignments_target_delete'
        AND polrelid='ambient_speaker_assignments'::regclass) THEN
      CREATE POLICY ambient_speaker_assignments_target_delete ON ambient_speaker_assignments
        AS PERMISSIVE FOR DELETE USING (
          member_sub=current_setting('oshal.current_sub',true)
          OR current_setting('oshal.is_operator',true)='on');
    END IF;
  END $$`,
];

/**
 * @description Builds runtime bootstrap SQL matching migration 069.
 * @returns Ordered idempotent speaker-profile schema statements.
 */
export function speakerSchemaStatements(): string[] {
  return [
    ...SPEAKER_TABLE_STATEMENTS,
    ...TRANSCRIPT_LINK_STATEMENTS,
    ...buildOwnerRlsPolicyStatements('ambient_speaker_profiles', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_speaker_ordinal_counters', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_speaker_assignments', 'owner_sub'),
    ...ASSIGNMENT_TARGET_PRIVACY_POLICIES,
    ...buildOwnerRlsPolicyStatements('ambient_speaker_observations', 'owner_sub'),
  ];
}
