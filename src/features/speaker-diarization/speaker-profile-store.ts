/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added owner-scoped encrypted speaker profile persistence, monotonic ordinals, private-org assignments, merge/delete, and deterministic centroid matching.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added short-lived per-chunk observation ledger so partial retries cannot update centroids twice.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { SpeakerAuthorizationError, SpeakerInputError } from './speaker-errors';
import {
  decryptSpeakerEmbedding,
  decryptSpeakerEmbeddingForRotation,
  encryptSpeakerEmbedding,
  speakerEmbeddingNeedsRewrap,
} from './speaker-embedding-crypto';
import {
  normalizeSpeakerEmbedding,
  SPEAKER_MATCH_THRESHOLD,
  selectBestSpeakerMatch,
  shouldUpdateSpeakerCentroid,
} from './speaker-matcher';
import { speakerSchemaStatements } from './speaker-schema';
import type {
  SpeakerAssignmentInput,
  SpeakerContext,
  SpeakerMatchResult,
  SpeakerObservationKey,
  SpeakerProfile,
  SpeakerProfileStoreContract,
} from './types';

const logger = createChildLogger({ module: 'speaker-profile-store' });
const PROFILE_SELECT = `SELECT p.*,
  CASE WHEN a.assignment_kind='tenant_member'
         AND (assignment_owner.user_sub IS NULL OR assignment_target.user_sub IS NULL)
       THEN NULL ELSE a.assignment_kind END AS assignment_kind,
  a.custom_name,
  CASE WHEN assignment_owner.user_sub IS NOT NULL AND assignment_target.user_sub IS NOT NULL
       THEN a.tenant_id ELSE NULL END AS tenant_id,
  CASE WHEN assignment_owner.user_sub IS NOT NULL AND assignment_target.user_sub IS NOT NULL
       THEN a.member_sub ELSE NULL END AS member_sub
  ,CASE WHEN assignment_owner.user_sub IS NOT NULL AND assignment_target.user_sub IS NOT NULL
       THEN assignment_target.display_name ELSE NULL END AS member_display_name
  ,COALESCE(segment_stats.segment_count,0)::int AS segment_count
  ,COALESCE(recent_context.excerpts,'[]'::jsonb) AS excerpts
  FROM ambient_speaker_profiles p
  LEFT JOIN ambient_speaker_assignments a ON a.profile_id=p.profile_id AND a.owner_sub=p.owner_sub
  LEFT JOIN oshal_tenant_memberships assignment_owner
    ON assignment_owner.tenant_id=a.tenant_id AND assignment_owner.user_sub=p.owner_sub
  LEFT JOIN oshal_tenant_memberships assignment_target
    ON assignment_target.tenant_id=a.tenant_id AND assignment_target.user_sub=a.member_sub
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS segment_count
    FROM ambient_transcript_segments segment
    JOIN ambient_user_settings settings ON settings.user_sub=segment.user_sub
    WHERE segment.user_sub=p.owner_sub AND segment.speaker_profile_id=p.profile_id
      AND segment.captured_at >= now() - (settings.transcript_retention_days * INTERVAL '1 day')
  ) segment_stats ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'text',recent.transcript_text,'capturedAt',recent.captured_at
    ) ORDER BY recent.captured_at DESC) AS excerpts
    FROM (
      SELECT left(segment.transcript_text,240) AS transcript_text,segment.captured_at
      FROM ambient_transcript_segments segment
      JOIN ambient_user_settings settings ON settings.user_sub=segment.user_sub
      WHERE segment.user_sub=p.owner_sub AND segment.speaker_profile_id=p.profile_id
        AND segment.captured_at >= now() - (settings.transcript_retention_days * INTERVAL '1 day')
      ORDER BY segment.captured_at DESC,segment.created_at DESC LIMIT 2
    ) recent
  ) recent_context ON TRUE`;

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** @description Owner-private Postgres store for encrypted biometric centroids and display assignments. */
export class SpeakerProfileStore implements SpeakerProfileStoreContract {
  private schemaPromise: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  /**
   * @description Lists safe profile metadata for one authenticated owner.
   * @param ownerSub - OIDC subject that owns every returned profile.
   * @returns Profiles without embedding ciphertext.
   */
  async listProfiles(ownerSub: string): Promise<SpeakerProfile[]> {
    return this.tracked('listProfiles', {}, async () => {
      await this.ensureSchema();
      await this.rewrapOwnerProfiles(ownerSub);
      const result = await this.pool.query(`${PROFILE_SELECT} WHERE p.owner_sub=$1 ORDER BY p.unidentified_ordinal`, [ownerSub]);
      return result.rows.map(mapProfile);
    });
  }

  /**
   * @description Matches or creates an owner profile under a per-owner transaction lock.
   * @param ownerSub - Authenticated profile owner.
   * @param embedding - Sidecar speaker embedding.
   * @param model - Sidecar embedding model/version.
   * @returns Stable profile match plus similarity provenance.
   */
  async identify(
    ownerSub: string,
    embedding: number[],
    model: string,
    observation?: SpeakerObservationKey,
  ): Promise<SpeakerMatchResult> {
    return this.tracked('identify', { model }, async () => {
      await this.ensureSchema();
      const normalized = normalizeSpeakerEmbedding(embedding);
      try {
        return await this.identifyTransaction(ownerSub, normalized, requireModel(model), observation);
      } finally {
        normalized.fill(0);
      }
    });
  }

  /**
   * @description Assigns a safe label to an owner profile after validating any org-member link.
   * @param ownerSub - Authenticated profile owner.
   * @param profileId - Owner profile id.
   * @param input - Discriminated assignment fields.
   * @returns Updated profile, or null when the id is not owned by the caller.
   */
  async assignProfile(
    ownerSub: string,
    profileId: string,
    input: SpeakerAssignmentInput,
  ): Promise<SpeakerProfile | null> {
    return this.tracked('assignProfile', { kind: input.kind }, async () => {
      await this.ensureSchema();
      if (input.kind === 'tenant_member') {
        return this.assignTenantMemberTransaction(ownerSub, profileId, input);
      }
      if (!(await this.profileExists(this.pool, ownerSub, profileId))) return null;
      if (input.kind === 'unassigned') {
        await this.pool.query('DELETE FROM ambient_speaker_assignments WHERE profile_id=$1 AND owner_sub=$2', [profileId, ownerSub]);
      } else {
        await this.upsertAssignment(this.pool, ownerSub, profileId, input);
      }
      return this.selectProfile(this.pool, ownerSub, profileId);
    });
  }

  private async assignTenantMemberTransaction(
    ownerSub: string,
    profileId: string,
    input: SpeakerAssignmentInput,
  ): Promise<SpeakerProfile | null> {
    assertTenantMemberInput(ownerSub, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [speakerMemberLock(input.memberSub!)]);
      if (!(await this.profileExists(client, ownerSub, profileId))) {
        await client.query('ROLLBACK');
        return null;
      }
      await this.assertPrivateOrgLink(client, ownerSub, input);
      await this.upsertAssignment(client, ownerSub, profileId, input);
      const profile = await this.selectProfile(client, ownerSub, profileId);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await rollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Merges a source centroid into a target while preserving the target ordinal/label.
   * @param ownerSub - Authenticated profile owner.
   * @param targetProfileId - Profile that survives.
   * @param sourceProfileId - Profile folded into the target and deleted.
   * @returns Merged target, or null when either id is not owner-visible.
   */
  async mergeProfiles(ownerSub: string, targetProfileId: string, sourceProfileId: string): Promise<SpeakerProfile | null> {
    return this.tracked('mergeProfiles', {}, async () => {
      if (targetProfileId === sourceProfileId) throw new SpeakerInputError('source profile must differ from target profile');
      await this.ensureSchema();
      return this.mergeTransaction(ownerSub, targetProfileId, sourceProfileId);
    });
  }

  /**
   * @description Deletes an owner profile; its ordinal remains consumed forever.
   * @param ownerSub - Authenticated profile owner.
   * @param profileId - Profile to erase.
   * @returns Whether an owner-visible row was deleted.
   */
  async deleteProfile(ownerSub: string, profileId: string): Promise<boolean> {
    return this.tracked('deleteProfile', {}, async () => {
      await this.ensureSchema();
      const result = await this.pool.query(
        'DELETE FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2', [profileId, ownerSub],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * @description Lists only membership-private `org` contexts and minimal co-member identity.
   * @param ownerSub - Authenticated caller.
   * @param selectedTenantId - Optional explicitly selected organization.
   * @returns Capability, private organizations, and selected organization members.
   */
  async speakerContext(
    ownerSub: string,
    selectedTenantId?: string | null,
    callerDisplayName?: string | null,
  ): Promise<SpeakerContext> {
    return this.tracked('speakerContext', {}, async () => {
      await this.ensureSchema();
      await this.rememberCallerDisplayName(ownerSub, callerDisplayName);
      const organizations = await this.listOrganizations(ownerSub);
      const selected = chooseSelectedTenant(organizations, selectedTenantId);
      const allMembers = selected ? await this.listMembers(selected, ownerSub) : [];
      const currentUser = await this.currentUser(ownerSub, callerDisplayName, allMembers);
      const peerMembers = allMembers.filter((member) => member.userSub !== ownerSub);
      const members = peerMembers.filter((member) => member.identityAvailable);
      return {
        available: organizations.length > 0,
        voiceProfilesAvailable: true,
        guest: false,
        tenantMemberAssignmentAvailable: members.some((member) => member.identityAvailable),
        reason: organizations.length > 0 ? 'private_org_available' : 'no_private_org',
        selectedTenantId: selected,
        organizations,
        members,
        currentUser,
        unavailableMemberCount: peerMembers.length - members.length,
      };
    });
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = runRuntimeSchemaBootstrap({
        pool: this.pool,
        moduleName: 'speaker diarization',
        statements: speakerSchemaStatements(),
        requirements: [
          { table: 'ambient_speaker_profiles', columns: ['profile_id', 'owner_sub', 'unidentified_ordinal', 'embedding_ciphertext', 'embedding_model', 'sample_count'] },
          { table: 'ambient_speaker_ordinal_counters', columns: ['owner_sub', 'next_ordinal'] },
          { table: 'ambient_speaker_assignments', columns: ['profile_id', 'owner_sub', 'assignment_kind', 'tenant_id', 'member_sub'] },
          { table: 'ambient_speaker_observations', columns: ['owner_sub', 'client_chunk_id', 'speaker_key', 'profile_id', 'similarity', 'created_profile', 'observed_at'] },
          { table: 'oshal_tenant_memberships', columns: ['tenant_id', 'user_sub', 'display_name'] },
        ],
      }).then(() => undefined);
    }
    await this.schemaPromise.catch((error: unknown) => {
      this.schemaPromise = null;
      throw error;
    });
  }

  private async identifyTransaction(
    ownerSub: string,
    embedding: number[],
    model: string,
    observation?: SpeakerObservationKey,
  ): Promise<SpeakerMatchResult> {
    const client = await this.pool.connect();
    let candidates: Array<{ id: string; embedding: number[]; sampleCount: number }> = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`speaker:${ownerSub}`]);
      const replay = observation ? await this.replayObservation(client, ownerSub, observation) : null;
      if (replay) { await client.query('COMMIT'); return replay; }
      candidates = await this.loadCandidates(client, ownerSub, model, embedding.length);
      const match = selectBestSpeakerMatch(embedding, candidates, SPEAKER_MATCH_THRESHOLD);
      const result = match
        ? await this.updateMatchedProfile(client, ownerSub, match.id, match.similarity, embedding)
        : await this.createProfile(client, ownerSub, embedding, model);
      if (observation) await this.recordObservation(client, ownerSub, observation, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client, error);
      throw error;
    } finally {
      candidates.forEach((candidate) => candidate.embedding.fill(0));
      client.release();
    }
  }

  private async replayObservation(
    client: PoolClient,
    ownerSub: string,
    observation: SpeakerObservationKey,
  ): Promise<SpeakerMatchResult | null> {
    await client.query(
      `DELETE FROM ambient_speaker_observations WHERE owner_sub=$1
       AND observed_at < now() - ($2 * INTERVAL '1 hour')`,
      [ownerSub, speakerObservationTtlHours()],
    );
    const row = (await client.query(
      `SELECT profile_id,similarity,created_profile FROM ambient_speaker_observations
       WHERE owner_sub=$1 AND client_chunk_id=$2 AND speaker_key=$3`,
      [ownerSub, observation.clientChunkId, observation.speakerKey],
    )).rows[0];
    if (!row) return null;
    const profile = await this.selectProfileRequired(client, ownerSub, String(row.profile_id));
    return { profile, similarity: Number(row.similarity), created: Boolean(row.created_profile) };
  }

  private async recordObservation(
    client: PoolClient,
    ownerSub: string,
    observation: SpeakerObservationKey,
    result: SpeakerMatchResult,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ambient_speaker_observations
       (owner_sub,client_chunk_id,speaker_key,profile_id,similarity,created_profile)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ownerSub, observation.clientChunkId, observation.speakerKey,
        result.profile.profileId, result.similarity, result.created],
    );
  }

  private async loadCandidates(client: PoolClient, ownerSub: string, model: string, dimensions: number) {
    const result = await client.query(
      `SELECT profile_id,embedding_ciphertext,sample_count FROM ambient_speaker_profiles
       WHERE owner_sub=$1 AND embedding_model=$2 AND embedding_dimensions=$3 FOR UPDATE`,
      [ownerSub, model, dimensions],
    );
    const candidates = [];
    for (const row of result.rows) {
      const encrypted = String(row.embedding_ciphertext);
      const decoded = decryptSpeakerEmbeddingForRotation(ownerSub, encrypted);
      try {
        if (decoded.requiresRewrap) {
          await client.query(
            `UPDATE ambient_speaker_profiles SET embedding_ciphertext=$3,updated_at=now()
             WHERE profile_id=$1 AND owner_sub=$2 AND embedding_ciphertext=$4`,
            [row.profile_id, ownerSub, encryptSpeakerEmbedding(ownerSub, decoded.embedding), encrypted],
          );
        }
        candidates.push({
          id: String(row.profile_id), embedding: decoded.embedding, sampleCount: Number(row.sample_count),
        });
      } catch (error) {
        decoded.embedding.fill(0);
        throw error;
      }
    }
    return candidates;
  }

  private async rewrapOwnerProfiles(ownerSub: string): Promise<void> {
    const rows = (await this.pool.query(
      `SELECT profile_id,embedding_ciphertext FROM ambient_speaker_profiles
       WHERE owner_sub=$1 ORDER BY profile_id`, [ownerSub],
    )).rows;
    let rewrapped = 0;
    for (const row of rows) {
      const encrypted = String(row.embedding_ciphertext);
      if (!speakerEmbeddingNeedsRewrap(encrypted)) continue;
      const decoded = decryptSpeakerEmbeddingForRotation(ownerSub, encrypted);
      try {
        await this.persistRewrappedProfile(ownerSub, String(row.profile_id), encrypted, decoded.embedding);
      } finally {
        decoded.embedding.fill(0);
      }
      rewrapped += 1;
    }
    if (rewrapped > 0) logger.info({ rewrapped }, 'Speaker profiles rewrapped with current key');
  }

  private async persistRewrappedProfile(
    ownerSub: string,
    profileId: string,
    previousEnvelope: string,
    embedding: number[],
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ambient_speaker_profiles SET embedding_ciphertext=$3,updated_at=now()
       WHERE profile_id=$1 AND owner_sub=$2 AND embedding_ciphertext=$4`,
      [profileId, ownerSub, encryptSpeakerEmbedding(ownerSub, embedding), previousEnvelope],
    );
  }

  private async updateMatchedProfile(
    client: PoolClient,
    ownerSub: string,
    profileId: string,
    similarity: number,
    embedding: number[],
  ): Promise<SpeakerMatchResult> {
    if (!shouldUpdateSpeakerCentroid(similarity)) {
      await client.query(
        'UPDATE ambient_speaker_profiles SET last_seen_at=now(),updated_at=now() WHERE profile_id=$1 AND owner_sub=$2',
        [profileId, ownerSub],
      );
      const profile = await this.selectProfileRequired(client, ownerSub, profileId);
      return { profile, similarity, created: false };
    }
    const current = (await client.query(
      'SELECT embedding_ciphertext,sample_count FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2',
      [profileId, ownerSub],
    )).rows[0];
    const previous = decryptSpeakerEmbedding(ownerSub, String(current.embedding_ciphertext));
    let centroid: number[] = [];
    try {
      centroid = weightedCentroid(previous, Number(current.sample_count), embedding, 1);
      await client.query(
        `UPDATE ambient_speaker_profiles SET embedding_ciphertext=$3,sample_count=sample_count+1,
         last_seen_at=now(),updated_at=now() WHERE profile_id=$1 AND owner_sub=$2`,
        [profileId, ownerSub, encryptSpeakerEmbedding(ownerSub, centroid)],
      );
      const profile = await this.selectProfileRequired(client, ownerSub, profileId);
      return { profile, similarity, created: false };
    } finally {
      previous.fill(0);
      centroid.fill(0);
    }
  }

  private async createProfile(
    client: PoolClient,
    ownerSub: string,
    embedding: number[],
    model: string,
  ): Promise<SpeakerMatchResult> {
    const ordinal = await allocateOrdinal(client, ownerSub);
    const profileId = randomUUID();
    await client.query(
      `INSERT INTO ambient_speaker_profiles
       (profile_id,owner_sub,unidentified_ordinal,embedding_ciphertext,embedding_model,embedding_dimensions)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [profileId, ownerSub, ordinal, encryptSpeakerEmbedding(ownerSub, embedding), model, embedding.length],
    );
    const profile = await this.selectProfileRequired(client, ownerSub, profileId);
    return { profile, similarity: 1, created: true };
  }

  private async mergeTransaction(ownerSub: string, targetId: string, sourceId: string): Promise<SpeakerProfile | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`speaker:${ownerSub}`]);
      const rows = await this.lockMergeRows(client, ownerSub, targetId, sourceId);
      if (rows.length !== 2) { await client.query('ROLLBACK'); return null; }
      await this.applyMerge(client, ownerSub, targetId, sourceId, rows);
      const profile = await this.selectProfileRequired(client, ownerSub, targetId);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await rollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockMergeRows(client: PoolClient, ownerSub: string, targetId: string, sourceId: string) {
    return (await client.query(
      `SELECT * FROM ambient_speaker_profiles WHERE owner_sub=$1 AND profile_id=ANY($2::uuid[])
       ORDER BY profile_id FOR UPDATE`, [ownerSub, [targetId, sourceId]],
    )).rows;
  }

  private async applyMerge(
    client: PoolClient,
    ownerSub: string,
    targetId: string,
    sourceId: string,
    rows: QueryResultRow[],
  ): Promise<void> {
    const target = rows.find((row) => String(row.profile_id) === targetId)!;
    const source = rows.find((row) => String(row.profile_id) === sourceId)!;
    assertMergeCompatible(target, source);
    const targetEmbedding = decryptSpeakerEmbedding(ownerSub, String(target.embedding_ciphertext));
    let sourceEmbedding: number[] = [];
    let centroid: number[] = [];
    try {
      sourceEmbedding = decryptSpeakerEmbedding(ownerSub, String(source.embedding_ciphertext));
      centroid = weightedCentroid(
        targetEmbedding, Number(target.sample_count), sourceEmbedding, Number(source.sample_count),
      );
      await this.transferAssignment(client, ownerSub, targetId, sourceId);
      await client.query(
        `UPDATE ambient_speaker_profiles SET embedding_ciphertext=$3,sample_count=$4,
         first_seen_at=LEAST(first_seen_at,$5),last_seen_at=GREATEST(last_seen_at,$6),updated_at=now()
         WHERE profile_id=$1 AND owner_sub=$2`,
        [targetId, ownerSub, encryptSpeakerEmbedding(ownerSub, centroid),
          Number(target.sample_count) + Number(source.sample_count), source.first_seen_at, source.last_seen_at],
      );
      await client.query(
        'UPDATE ambient_transcript_segments SET speaker_profile_id=$3 WHERE user_sub=$1 AND speaker_profile_id=$2',
        [ownerSub, sourceId, targetId],
      );
      await client.query('DELETE FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2', [sourceId, ownerSub]);
    } finally {
      targetEmbedding.fill(0);
      sourceEmbedding.fill(0);
      centroid.fill(0);
    }
  }

  private async transferAssignment(client: PoolClient, ownerSub: string, targetId: string, sourceId: string): Promise<void> {
    await moveSpeakerAssignment(client, ownerSub, targetId, sourceId);
  }

  private async assertPrivateOrgLink(
    queryable: Queryable,
    ownerSub: string,
    input: SpeakerAssignmentInput,
  ): Promise<void> {
    assertTenantMemberInput(ownerSub, input);
    if (!(await isPrivateOrgMemberPair(queryable, input.tenantId, ownerSub, input.memberSub))) {
      throw new SpeakerAuthorizationError(
        'the selected private-organization member must have a verified display name',
        'private_org_named_member_required',
      );
    }
  }

  private async upsertAssignment(
    queryable: Queryable,
    ownerSub: string,
    profileId: string,
    input: SpeakerAssignmentInput,
  ): Promise<void> {
    const values = assignmentValues(input);
    const prefix = input.kind === 'self'
      ? `WITH removed AS (
           DELETE FROM ambient_speaker_assignments
           WHERE owner_sub=$2 AND assignment_kind='self' AND profile_id<>$1
         )`
      : '';
    await queryable.query(
      `${prefix} INSERT INTO ambient_speaker_assignments
       (profile_id,owner_sub,assignment_kind,custom_name,tenant_id,member_sub,assigned_by_sub)
       VALUES ($1,$2,$3,$4,$5,$6,$2)
       ON CONFLICT (profile_id) DO UPDATE SET assignment_kind=$3,custom_name=$4,tenant_id=$5,
         member_sub=$6,assigned_by_sub=$2,assigned_at=now()`,
      [profileId, ownerSub, ...values],
    );
  }

  private async profileExists(queryable: Queryable, ownerSub: string, profileId: string): Promise<boolean> {
    return (await queryable.query(
      'SELECT 1 FROM ambient_speaker_profiles WHERE profile_id=$1 AND owner_sub=$2', [profileId, ownerSub],
    )).rows.length > 0;
  }

  private async selectProfile(queryable: Queryable, ownerSub: string, profileId: string): Promise<SpeakerProfile | null> {
    const row = (await queryable.query(
      `${PROFILE_SELECT} WHERE p.owner_sub=$1 AND p.profile_id=$2`, [ownerSub, profileId],
    )).rows[0];
    return row ? mapProfile(row) : null;
  }

  private async selectProfileRequired(queryable: Queryable, ownerSub: string, profileId: string): Promise<SpeakerProfile> {
    const profile = await this.selectProfile(queryable, ownerSub, profileId);
    if (!profile) throw new Error('speaker profile disappeared during transaction');
    return profile;
  }

  private async listOrganizations(ownerSub: string) {
    const result = await this.pool.query(
      `SELECT t.tenant_id,t.name,m.role FROM oshal_tenant_memberships m
       JOIN oshal_tenants t ON t.tenant_id=m.tenant_id
       WHERE m.user_sub=$1 AND t.kind='org' ORDER BY t.created_at,t.tenant_id`, [ownerSub],
    );
    return result.rows.map((row) => ({
      tenantId: String(row.tenant_id), name: String(row.name || 'Organization'), role: String(row.role),
    }));
  }

  private async listMembers(tenantId: string, ownerSub: string) {
    const result = await this.pool.query(
      `SELECT target.user_sub,target.role,target.display_name FROM oshal_tenant_memberships caller
       JOIN oshal_tenants t ON t.tenant_id=caller.tenant_id AND t.kind='org'
       JOIN oshal_tenant_memberships target ON target.tenant_id=caller.tenant_id
       WHERE caller.tenant_id=$1 AND caller.user_sub=$2
       ORDER BY (target.role='admin') DESC,target.created_at`, [tenantId, ownerSub],
    );
    return result.rows.map((row, index) => ({
      userSub: String(row.user_sub),
      displayName: safeMemberDisplayName(row.display_name, ownerSub, String(row.user_sub), index),
      identityAvailable: Boolean(safeStoredDisplayName(row.display_name)),
      role: String(row.role),
    }));
  }

  private async rememberCallerDisplayName(ownerSub: string, value?: string | null): Promise<void> {
    const displayName = safeStoredDisplayName(value);
    if (!displayName) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [speakerMemberLock(ownerSub)]);
      await client.query(
        `UPDATE oshal_tenant_memberships SET display_name=$2
         WHERE user_sub=$1 AND display_name IS DISTINCT FROM $2
         AND EXISTS (SELECT 1 FROM oshal_tenants tenant
           WHERE tenant.tenant_id=oshal_tenant_memberships.tenant_id AND tenant.kind='org')`,
        [ownerSub, displayName],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async currentUser(
    ownerSub: string,
    callerDisplayName: string | null | undefined,
    members: Array<{ userSub: string; displayName: string }>,
  ) {
    const row = (await this.pool.query(
      `SELECT profile_id FROM ambient_speaker_assignments
       WHERE owner_sub=$1 AND assignment_kind='self' LIMIT 1`, [ownerSub],
    )).rows[0];
    const member = members.find((candidate) => candidate.userSub === ownerSub);
    return {
      userSub: ownerSub,
      displayName: safeStoredDisplayName(callerDisplayName) || member?.displayName || 'You',
      profileId: row?.profile_id ? String(row.profile_id) : null,
    };
  }

  private async tracked<T>(operation: string, params: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    logger.info({ operation, ...params }, 'Speaker profile store entered');
    try {
      const result = await work();
      logger.info({ operation, durationMs: Date.now() - startedAt }, 'Speaker profile store completed');
      return result;
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Speaker profile store failed');
      throw error;
    }
  }
}

const storeInstances = new WeakMap<Pool, SpeakerProfileStore>();

/**
 * @description Returns the process-local speaker store for the shared pool.
 * @param pool - GUC-aware Postgres pool.
 * @returns Stable speaker profile store.
 */
export function speakerProfilesFor(pool: Pool): SpeakerProfileStore {
  let store = storeInstances.get(pool);
  if (!store) { store = new SpeakerProfileStore(pool); storeInstances.set(pool, store); }
  return store;
}

/**
 * @description Proves both caller and target membership in the same membership-private org.
 * @param queryable - Postgres query boundary.
 * @param tenantId - Explicit organization id.
 * @param callerSub - Authenticated owner making the assignment.
 * @param memberSub - Target tenant member.
 * @returns Whether the exact private-org membership pair exists.
 */
export async function isPrivateOrgMemberPair(
  queryable: Queryable,
  tenantId: string,
  callerSub: string,
  memberSub: string,
): Promise<boolean> {
  const result = await queryable.query(
    `SELECT 1 FROM oshal_tenants t
     JOIN oshal_tenant_memberships caller ON caller.tenant_id=t.tenant_id AND caller.user_sub=$2
     JOIN oshal_tenant_memberships target ON target.tenant_id=t.tenant_id AND target.user_sub=$3
     WHERE t.tenant_id=$1 AND t.kind='org'
       AND char_length(btrim(target.display_name)) BETWEEN 1 AND 120
       AND target.display_name !~ '[[:cntrl:]]' LIMIT 1`,
    [tenantId, callerSub, memberSub],
  );
  return Boolean(result.rows[0]);
}

/**
 * @description Moves a source label onto an unassigned merge target without duplicating `self`.
 * @param queryable - Transaction-scoped Postgres query boundary.
 * @param ownerSub - Authenticated profile owner.
 * @param targetProfileId - Surviving profile.
 * @param sourceProfileId - Profile whose assignment will otherwise be cascade-deleted.
 * @returns Void after preserving the target assignment when present, otherwise moving the source row.
 */
export async function moveSpeakerAssignment(
  queryable: Queryable,
  ownerSub: string,
  targetProfileId: string,
  sourceProfileId: string,
): Promise<void> {
  const target = await queryable.query(
    'SELECT 1 FROM ambient_speaker_assignments WHERE profile_id=$1 AND owner_sub=$2',
    [targetProfileId, ownerSub],
  );
  if (target.rows[0]) {
    await queryable.query(
      'DELETE FROM ambient_speaker_assignments WHERE profile_id=$1 AND owner_sub=$2',
      [sourceProfileId, ownerSub],
    );
    return;
  }
  await queryable.query(
    'UPDATE ambient_speaker_assignments SET profile_id=$1 WHERE profile_id=$2 AND owner_sub=$3',
    [targetProfileId, sourceProfileId, ownerSub],
  );
}

function mapProfile(row: QueryResultRow): SpeakerProfile {
  const kind = row.assignment_kind ? String(row.assignment_kind) as SpeakerProfile['assignment']['kind'] : 'unassigned';
  const assignment = {
    kind,
    customName: row.custom_name ? String(row.custom_name) : null,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    memberSub: row.member_sub ? String(row.member_sub) : null,
  };
  return {
    profileId: String(row.profile_id), ordinal: Number(row.unidentified_ordinal),
    label: profileLabel(
      Number(row.unidentified_ordinal), assignment, safeStoredDisplayName(row.member_display_name),
    ), assignment,
    embeddingModel: String(row.embedding_model), sampleCount: Number(row.sample_count),
    segmentCount: Number(row.segment_count || 0), excerpts: mapExcerpts(row.excerpts),
    firstSeenAt: new Date(row.first_seen_at), lastSeenAt: new Date(row.last_seen_at), updatedAt: new Date(row.updated_at),
  };
}

function mapExcerpts(value: unknown): SpeakerProfile['excerpts'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    const capturedAt = new Date(String(row.capturedAt || ''));
    return text && !Number.isNaN(capturedAt.getTime()) ? [{ text, capturedAt }] : [];
  });
}

function profileLabel(
  ordinal: number,
  assignment: SpeakerProfile['assignment'],
  memberDisplayName: string | null,
): string {
  if (assignment.kind === 'self') return 'You';
  if (assignment.kind === 'custom' && assignment.customName) return assignment.customName;
  if (assignment.kind === 'tenant_member' && assignment.memberSub) {
    return memberDisplayName || 'Organization member';
  }
  return `Unidentified Person ${ordinal}`;
}

function safeMemberDisplayName(
  value: unknown,
  ownerSub: string,
  memberSub: string,
  index: number,
): string {
  const displayName = safeStoredDisplayName(value);
  if (displayName) return displayName;
  return ownerSub === memberSub ? 'You' : `Organization member ${index + 1}`;
}

function safeStoredDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const displayName = value.trim().replace(/\s+/g, ' ');
  if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f]/u.test(displayName)) return null;
  return displayName;
}

function assignmentValues(input: SpeakerAssignmentInput): [string, string | null, string | null, string | null] {
  if (input.kind === 'custom') {
    const customName = normalizeCustomName(input.customName);
    return ['custom', customName, null, null];
  }
  if (input.kind === 'tenant_member') return ['tenant_member', null, input.tenantId || null, input.memberSub || null];
  if (input.kind === 'self') return ['self', null, null, null];
  throw new SpeakerInputError('unassigned must delete the assignment instead of upserting it');
}

function normalizeCustomName(value: unknown): string {
  if (typeof value !== 'string') throw new SpeakerInputError('customName is required');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new SpeakerInputError('customName must contain 1-80 printable characters');
  }
  return name;
}

function requireModel(value: string): string {
  const model = String(value || '').trim();
  if (!model || model.length > 120) throw new SpeakerInputError('embedding model must contain 1-120 characters');
  return model;
}

function assertTenantMemberInput(
  ownerSub: string,
  input: SpeakerAssignmentInput,
): asserts input is SpeakerAssignmentInput & { tenantId: string; memberSub: string } {
  if (!input.tenantId || !input.memberSub) throw new SpeakerInputError('tenantId and memberSub are required');
  if (input.memberSub === ownerSub) {
    throw new SpeakerInputError('use the self assignment for your own voice', 'speaker_self_assignment_required');
  }
}

function speakerMemberLock(memberSub: string): string {
  return `speaker-target:${memberSub}`;
}

function speakerObservationTtlHours(): number {
  const value = Number(process.env.SPEAKER_AUDIO_RECEIPT_TTL_HOURS ?? 48);
  return Number.isFinite(value) ? Math.min(168, Math.max(1, Math.floor(value))) : 48;
}

async function allocateOrdinal(client: PoolClient, ownerSub: string): Promise<number> {
  const row = (await client.query(
    `INSERT INTO ambient_speaker_ordinal_counters (owner_sub,next_ordinal) VALUES ($1,2)
     ON CONFLICT (owner_sub) DO UPDATE SET next_ordinal=ambient_speaker_ordinal_counters.next_ordinal+1,updated_at=now()
     RETURNING next_ordinal-1 AS ordinal`, [ownerSub],
  )).rows[0];
  return Number(row.ordinal);
}

function weightedCentroid(left: number[], leftCount: number, right: number[], rightCount: number): number[] {
  if (left.length !== right.length) throw new SpeakerInputError('speaker profile embedding dimensions do not match');
  const total = leftCount + rightCount;
  return normalizeSpeakerEmbedding(left.map((value, index) => ((value * leftCount) + (right[index] * rightCount)) / total));
}

function assertMergeCompatible(target: QueryResultRow, source: QueryResultRow): void {
  if (String(target.embedding_model) !== String(source.embedding_model)
      || Number(target.embedding_dimensions) !== Number(source.embedding_dimensions)) {
    throw new SpeakerInputError('speaker profiles from different embedding models cannot be merged');
  }
}

function chooseSelectedTenant(
  organizations: Array<{ tenantId: string }>,
  requested: string | null | undefined,
): string | null {
  if (requested && organizations.some((organization) => organization.tenantId === requested)) return requested;
  return organizations.length === 1 ? organizations[0].tenantId : null;
}

async function rollback(client: PoolClient, cause: unknown): Promise<void> {
  try { await client.query('ROLLBACK'); }
  catch (error) { logger.error({ err: error, cause }, 'Speaker profile transaction rollback failed'); }
}
