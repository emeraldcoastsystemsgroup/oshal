/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added owner-scoped Postgres persistence for opt-in ambient settings, text-only transcript batches, retention, daily retrieval, reviews, and privacy deletion.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persisted daily review schedule/follow-up controls and added the background-safe due-day review sweep.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added speaker diarization/profile settings, private-org selection validation, and an internal trusted speaker-attributed transcript append path.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added short-lived processing/completed audio receipts with stale-lease reclaim, completion, and failure release.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  buildOwnerRlsPolicyStatements,
  runRuntimeSchemaBootstrap,
  withAmbientOwnerLock,
} from '@/shared/services/database';
import {
  buildAmbientDailyReview,
  DEFAULT_AMBIENT_SETTINGS,
  dueAmbientReviewDate,
  normalizeAmbientSegmentBatch,
  normalizeAmbientSettings,
  normalizeLocalDate,
} from './ambient-listening-logic';
import {
  AmbientInputError,
  AmbientModeDisabledError,
  type AmbientAppendResult,
  type AmbientAudioChunkClaim,
  type AmbientAttributedSegmentInput,
  type AmbientClearResult,
  type AmbientDailyReview,
  type AmbientDayTranscript,
  type AmbientDueReview,
  type AmbientSegmentInput,
  type AmbientSettings,
  type AmbientTranscriptSegment,
} from './ambient-listening-types';

const logger = createChildLogger({ module: 'ambient-listening-service' });
const DEFAULT_AUDIO_RECEIPT_TTL_HOURS = 48;
const DEFAULT_AUDIO_RECEIPT_LIMIT = 10_000;
const DEFAULT_AUDIO_LEASE_SECONDS = 300;

/**
 * @description Service contract used by HTTP routes and unit-test adapters.
 */
export interface AmbientListeningServiceContract {
  getSettings(userSub: string): Promise<AmbientSettings>;
  updateSettings(userSub: string, input: unknown): Promise<AmbientSettings>;
  appendSegments(userSub: string, payload: unknown): Promise<AmbientAppendResult>;
  appendAttributedSegments(
    userSub: string,
    segments: AmbientAttributedSegmentInput[],
    mode?: 'ambient' | 'recording_import',
  ): Promise<AmbientAppendResult>;
  claimAudioChunk(userSub: string, clientChunkId: string): Promise<AmbientAudioChunkClaim>;
  completeAudioChunk(userSub: string, clientChunkId: string, claimToken: string): Promise<void>;
  releaseAudioChunk(userSub: string, clientChunkId: string, claimToken: string): Promise<void>;
  getDay(userSub: string, localDate: string): Promise<AmbientDayTranscript>;
  reviewDay(userSub: string, localDate: string): Promise<AmbientDailyReview>;
  deleteDay(userSub: string, localDate: string): Promise<number>;
  clearTranscriptData(userSub: string): Promise<AmbientClearResult>;
  reviewDueDays(now?: Date): Promise<AmbientDueReview[]>;
}

/**
 * @description Durable ambient-listening store. Raw audio has no method, column, or accepted
 * payload shape; only finalized text segments cross this boundary. Every query carries user_sub
 * even though forced RLS independently enforces the same ownership boundary.
 */
export class AmbientListeningService implements AmbientListeningServiceContract {
  private schemaPromise: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  /** @description Idempotently creates/validates the ambient tables and forced owner RLS. */
  async ensureSchema(): Promise<void> {
    return this.tracked('ensureSchema', {}, async () => {
      if (!this.schemaPromise) this.schemaPromise = this.bootstrapSchema();
      await this.schemaPromise.catch((error: unknown) => {
        this.schemaPromise = null;
        throw error;
      });
    });
  }

  /**
   * @description Loads the caller's settings, creating privacy-first defaults when absent.
   * @param userSub - Authenticated owner's OIDC subject.
   * @returns Complete ambient settings.
   */
  async getSettings(userSub: string): Promise<AmbientSettings> {
    return this.tracked('getSettings', {}, async () => {
      await this.ensureSchema();
      return this.ensureDefaultSettings(userSub);
    });
  }

  /**
   * @description Validates and persists the caller's own settings, then enforces the new retention.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param input - Untrusted partial settings payload.
   * @returns Updated settings.
   */
  async updateSettings(userSub: string, input: unknown): Promise<AmbientSettings> {
    return this.tracked('updateSettings', {}, async () => {
      const current = await this.getSettings(userSub);
      const settings = normalizeAmbientSettings(current, input);
      await this.assertSpeakerTenantSelection(userSub, settings.speakerTenantId);
      const result = await this.pool.query(
        `UPDATE ambient_user_settings SET assistant_name=$2, wake_phrases=$3::jsonb,
           ambient_enabled=$4, transcript_retention_days=$5, time_zone=$6,
           daily_review_enabled=$7, daily_review_time=$8::time, suggest_follow_ups=$9,
           speaker_diarization_enabled=$10,remember_speakers=$11,speaker_tenant_id=$12,updated_at=$13
         WHERE user_sub=$1 RETURNING *`,
        [userSub, settings.assistantName, JSON.stringify(settings.wakePhrases), settings.ambientEnabled,
          settings.transcriptRetentionDays, settings.timeZone, settings.dailyReviewEnabled,
          settings.dailyReviewTime, settings.suggestFollowUps, settings.speakerDiarizationEnabled,
          settings.rememberSpeakers, settings.speakerTenantId, settings.updatedAt],
      );
      await this.purgeExpired(userSub, settings);
      return mapSettings(requireRow(result.rows[0], 'settings update did not return a row'));
    });
  }

  /**
   * @description Atomically appends an idempotent text-only batch only while ambient mode is enabled.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param payload - One transcript object or a `{segments}` batch.
   * @returns Counts and newly stored segments; retry duplicates are not returned as accepted.
   */
  async appendSegments(userSub: string, payload: unknown): Promise<AmbientAppendResult> {
    return this.tracked('appendSegments', {}, async () => {
      const segments = normalizeAmbientSegmentBatch(payload);
      await this.ensureSchema();
      await this.ensureDefaultSettings(userSub);
      return this.appendInTransaction(userSub, segments);
    });
  }

  /**
   * @description Persists attribution produced inside the authenticated audio pipeline.
   * @param userSub - Authenticated transcript owner.
   * @param segments - Server-constructed turns carrying optional trusted profile ids.
   * @returns Idempotent append counts and stored segments.
   */
  async appendAttributedSegments(
    userSub: string,
    segments: AmbientAttributedSegmentInput[],
    mode: 'ambient' | 'recording_import' = 'ambient',
  ): Promise<AmbientAppendResult> {
    return this.tracked('appendAttributedSegments', { mode }, async () => {
      const trusted = validateAttributedSegments(segments);
      await this.ensureSchema();
      await this.ensureDefaultSettings(userSub);
      return this.appendInTransaction(userSub, trusted, mode === 'recording_import');
    });
  }

  /**
   * @description Atomically claims an owner chunk before biometric matching so retries are no-ops.
   * @param userSub - Authenticated audio owner.
   * @param clientChunkId - Validated idempotency key supplied by the client.
   * @returns Whether this request owns processing, is concurrent, or replays completed work.
   */
  async claimAudioChunk(userSub: string, clientChunkId: string): Promise<AmbientAudioChunkClaim> {
    return this.tracked('claimAudioChunk', {}, async () => {
      await this.ensureSchema();
      await this.pruneAudioChunkReceipts(userSub);
      const claimToken = randomUUID();
      const result = await this.pool.query(
        `INSERT INTO ambient_audio_chunk_receipts
           (user_sub,client_chunk_id,status,claim_token,created_at,updated_at)
         VALUES ($1,$2,'processing',$4::uuid,now(),now())
         ON CONFLICT (user_sub,client_chunk_id) DO UPDATE
           SET status='processing',claim_token=$4::uuid,updated_at=now(),completed_at=NULL
         WHERE ambient_audio_chunk_receipts.status='processing'
           AND ambient_audio_chunk_receipts.updated_at < now() - ($3 * INTERVAL '1 second')
         RETURNING client_chunk_id`,
        [userSub, clientChunkId, audioLeaseSeconds(), claimToken],
      );
      if (result.rows[0]) return { state: 'claimed', claimToken };
      const current = await this.pool.query(
        `SELECT status FROM ambient_audio_chunk_receipts
         WHERE user_sub=$1 AND client_chunk_id=$2 LIMIT 1`, [userSub, clientChunkId],
      );
      return { state: current.rows[0]?.status === 'completed' ? 'completed' : 'in_progress' };
    });
  }

  /** @description Marks a claimed audio key complete only after all durable text work succeeds. */
  async completeAudioChunk(userSub: string, clientChunkId: string, claimToken: string): Promise<void> {
    return this.tracked('completeAudioChunk', {}, async () => {
      await this.ensureSchema();
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const result = await this.pool.query(
            `UPDATE ambient_audio_chunk_receipts SET status='completed',
               completed_at=COALESCE(completed_at,now()),updated_at=now()
             WHERE user_sub=$1 AND client_chunk_id=$2 AND claim_token=$3::uuid
               AND status IN ('processing','completed')`,
            [userSub, clientChunkId, claimToken],
          );
          if (result.rowCount === 1) return;
          throw new Error('audio chunk claim was not available to complete');
        } catch (error) {
          lastError = error;
          logger.warn({ err: error, attempt }, 'Audio receipt completion attempt failed');
        }
      }
      throw lastError;
    });
  }

  /** @description Releases a failed in-progress claim so the same audio id may be retried. */
  async releaseAudioChunk(userSub: string, clientChunkId: string, claimToken: string): Promise<void> {
    return this.tracked('releaseAudioChunk', {}, async () => {
      await this.ensureSchema();
      await this.pool.query(
        `DELETE FROM ambient_audio_chunk_receipts
         WHERE user_sub=$1 AND client_chunk_id=$2 AND claim_token=$3::uuid AND status='processing'`,
        [userSub, clientChunkId, claimToken],
      );
    });
  }

  /**
   * @description Returns one local calendar day's text segments and latest review.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param localDate - YYYY-MM-DD in the owner's configured time zone.
   * @returns Owner-scoped daily transcript.
   */
  async getDay(userSub: string, localDate: string): Promise<AmbientDayTranscript> {
    return this.tracked('getDay', { localDate }, async () => {
      const date = normalizeLocalDate(localDate);
      const settings = await this.getSettings(userSub);
      await this.purgeExpired(userSub, settings);
      const segments = await this.selectDaySegments(userSub, date, settings.timeZone);
      const review = await this.selectReview(userSub, date);
      return { localDate: date, timeZone: settings.timeZone, segments, review };
    });
  }

  /**
   * @description Creates and persists an extractive daily review with proposals only.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param localDate - YYYY-MM-DD in the owner's configured time zone.
   * @returns Summary and confirmation-required proposed actions; no action is executed.
   */
  async reviewDay(userSub: string, localDate: string): Promise<AmbientDailyReview> {
    return this.tracked('reviewDay', { localDate }, async () => {
      const day = await this.getDay(userSub, localDate);
      const settings = await this.getSettings(userSub);
      const review = buildAmbientDailyReview(
        day.localDate, day.timeZone, day.segments, new Date(), settings.suggestFollowUps,
      );
      const result = await this.pool.query(
        `INSERT INTO ambient_daily_reviews
           (review_id,user_sub,local_date,time_zone,summary,suggestions,source_segment_count,created_at,updated_at)
         VALUES ($1,$2,$3::date,$4,$5,$6::jsonb,$7,$8,$8)
         ON CONFLICT (user_sub,local_date) DO UPDATE SET time_zone=$4, summary=$5,
           suggestions=$6::jsonb, source_segment_count=$7, updated_at=$8
         RETURNING *`,
        [randomUUID(), userSub, day.localDate, day.timeZone, review.summary,
          JSON.stringify(review.suggestions), review.sourceSegmentCount, review.updatedAt],
      );
      return mapReview(requireRow(result.rows[0], 'review upsert did not return a row'));
    });
  }

  /**
   * @description Deletes one local day of transcript and its review for the caller only.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param localDate - YYYY-MM-DD in the owner's configured time zone.
   * @returns Number of transcript segments removed.
   */
  async deleteDay(userSub: string, localDate: string): Promise<number> {
    return this.tracked('deleteDay', { localDate }, async () => {
      const date = normalizeLocalDate(localDate);
      const settings = await this.getSettings(userSub);
      const result = await this.pool.query(
        `DELETE FROM ambient_transcript_segments
         WHERE user_sub=$1 AND (captured_at AT TIME ZONE $2)::date=$3::date`,
        [userSub, settings.timeZone, date],
      );
      await this.pool.query('DELETE FROM ambient_daily_reviews WHERE user_sub=$1 AND local_date=$2::date', [userSub, date]);
      return result.rowCount ?? 0;
    });
  }

  /**
   * @description Disables ambient capture and erases transcript, reviews, and remembered voice profiles.
   * @param userSub - Authenticated owner's OIDC subject.
   * @returns Counts of text segments and encrypted speaker profiles removed.
   */
  async clearTranscriptData(userSub: string): Promise<AmbientClearResult> {
    return this.tracked('clearTranscriptData', {}, async () => {
      await this.ensureSchema();
      return withAmbientOwnerLock(this.pool, userSub, async () => {
        await this.ensureDefaultSettings(userSub);
        await this.pool.query(
          `UPDATE ambient_user_settings SET ambient_enabled=FALSE,speaker_diarization_enabled=FALSE,
           remember_speakers=FALSE,updated_at=now() WHERE user_sub=$1`, [userSub],
        );
        const result = await this.pool.query('DELETE FROM ambient_transcript_segments WHERE user_sub=$1', [userSub]);
        await this.pool.query('DELETE FROM ambient_daily_reviews WHERE user_sub=$1', [userSub]);
        await this.pool.query('DELETE FROM ambient_audio_chunk_receipts WHERE user_sub=$1', [userSub]);
        const deletedSpeakerProfiles = await clearSpeakerDataIfPresent(this.pool, userSub);
        return { deletedSegments: result.rowCount ?? 0, deletedSpeakerProfiles };
      }, true);
    });
  }

  /**
   * @description Finds enabled owners whose configured local review time has passed and creates
   * at most one review per local day. Intended for the controller's background scheduler only.
   * @param now - Sweep instant, injectable for deterministic tests.
   * @returns Newly created owner/review pairs for proposal-inbox delivery.
   */
  async reviewDueDays(now = new Date()): Promise<AmbientDueReview[]> {
    return this.tracked('reviewDueDays', {}, async () => {
      await this.ensureSchema();
      await this.purgeAllExpired();
      const result = await this.pool.query(
        'SELECT * FROM ambient_user_settings WHERE ambient_enabled=TRUE AND daily_review_enabled=TRUE',
      );
      const due: AmbientDueReview[] = [];
      for (const row of result.rows) {
        const settings = mapSettings(row);
        const localDate = dueAmbientReviewDate(settings, now);
        if (!localDate || await this.reviewExists(String(row.user_sub), localDate)) continue;
        due.push({ userSub: String(row.user_sub), review: await this.reviewDay(String(row.user_sub), localDate) });
      }
      return due;
    });
  }

  private async pruneAudioChunkReceipts(userSub: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ambient_audio_chunk_receipts WHERE user_sub=$1
       AND created_at < now() - ($2 * INTERVAL '1 hour')`,
      [userSub, audioReceiptTtlHours()],
    );
    await this.pool.query(
      `DELETE FROM ambient_audio_chunk_receipts WHERE user_sub=$1 AND client_chunk_id IN (
         SELECT client_chunk_id FROM ambient_audio_chunk_receipts WHERE user_sub=$1
         ORDER BY created_at DESC OFFSET $2
       )`,
      [userSub, audioReceiptLimit()],
    );
  }

  private async bootstrapSchema(): Promise<void> {
    await runRuntimeSchemaBootstrap({
      pool: this.pool,
      moduleName: 'ambient-listening',
      statements: ambientSchemaStatements(),
      requirements: [
        { table: 'ambient_user_settings', columns: ['user_sub', 'assistant_name', 'wake_phrases', 'ambient_enabled', 'transcript_retention_days', 'time_zone', 'daily_review_enabled', 'daily_review_time', 'suggest_follow_ups', 'speaker_diarization_enabled', 'remember_speakers', 'speaker_tenant_id'] },
        { table: 'ambient_transcript_segments', columns: ['segment_id', 'user_sub', 'transcript_text', 'captured_at', 'client_segment_id', 'speaker_profile_id'] },
          { table: 'ambient_daily_reviews', columns: ['review_id', 'user_sub', 'local_date', 'summary', 'suggestions'] },
          { table: 'ambient_audio_chunk_receipts', columns: ['user_sub', 'client_chunk_id', 'status', 'claim_token', 'created_at', 'updated_at', 'completed_at'] },
          { table: 'oshal_tenant_memberships', columns: ['tenant_id', 'user_sub', 'display_name'] },
      ],
    });
  }

  private async ensureDefaultSettings(userSub: string): Promise<AmbientSettings> {
    await this.pool.query(
      `INSERT INTO ambient_user_settings
         (user_sub,assistant_name,wake_phrases,ambient_enabled,transcript_retention_days,time_zone,
          daily_review_enabled,daily_review_time,suggest_follow_ups,speaker_diarization_enabled,
          remember_speakers,speaker_tenant_id)
       VALUES ($1,$2,$3::jsonb,FALSE,$4,$5,$6,$7::time,$8,$9,$10,$11) ON CONFLICT (user_sub) DO NOTHING`,
      [userSub, DEFAULT_AMBIENT_SETTINGS.assistantName, JSON.stringify(DEFAULT_AMBIENT_SETTINGS.wakePhrases),
        DEFAULT_AMBIENT_SETTINGS.transcriptRetentionDays, DEFAULT_AMBIENT_SETTINGS.timeZone,
        DEFAULT_AMBIENT_SETTINGS.dailyReviewEnabled, DEFAULT_AMBIENT_SETTINGS.dailyReviewTime,
        DEFAULT_AMBIENT_SETTINGS.suggestFollowUps, DEFAULT_AMBIENT_SETTINGS.speakerDiarizationEnabled,
        DEFAULT_AMBIENT_SETTINGS.rememberSpeakers, DEFAULT_AMBIENT_SETTINGS.speakerTenantId],
    );
    const result = await this.pool.query('SELECT * FROM ambient_user_settings WHERE user_sub=$1', [userSub]);
    return mapSettings(requireRow(result.rows[0], 'settings row is unavailable'));
  }

  private async appendInTransaction(
    userSub: string,
    segments: AmbientSegmentInput[],
    allowWhenAmbientDisabled = false,
  ): Promise<AmbientAppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const settingsResult = await client.query('SELECT * FROM ambient_user_settings WHERE user_sub=$1 FOR UPDATE', [userSub]);
      const settings = mapSettings(requireRow(settingsResult.rows[0], 'settings row is unavailable'));
      if (!settings.ambientEnabled && !allowWhenAmbientDisabled) throw new AmbientModeDisabledError();
      const query = buildSegmentInsert(userSub, segments);
      const result = await client.query(query.text, query.values);
      await purgeExpiredWith(client, userSub, settings);
      await client.query('COMMIT');
      const stored = result.rows.map(mapSegment);
      return { accepted: stored.length, duplicates: segments.length - stored.length, segments: stored };
    } catch (error) {
      logger.error({ err: error, operation: 'appendSegmentsTransaction' }, 'Ambient segment transaction failed');
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        logger.error({ err: rollbackError }, 'Ambient segment transaction rollback failed');
      });
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectDaySegments(userSub: string, localDate: string, timeZone: string): Promise<AmbientTranscriptSegment[]> {
    const withSpeakers = await speakerTablesAvailable(this.pool);
    const sql = withSpeakers ? speakerAwareDayQuery() : plainDayQuery();
    const result = await this.pool.query(sql, [userSub, timeZone, localDate]);
    return result.rows.map(mapSegment);
  }

  private async selectReview(userSub: string, localDate: string): Promise<AmbientDailyReview | null> {
    const result = await this.pool.query(
      'SELECT * FROM ambient_daily_reviews WHERE user_sub=$1 AND local_date=$2::date',
      [userSub, localDate],
    );
    return result.rows[0] ? mapReview(result.rows[0]) : null;
  }

  private async reviewExists(userSub: string, localDate: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM ambient_daily_reviews WHERE user_sub=$1 AND local_date=$2::date LIMIT 1',
      [userSub, localDate],
    );
    return result.rows.length > 0;
  }

  private async purgeExpired(userSub: string, settings: AmbientSettings): Promise<void> {
    await purgeExpiredWith(this.pool, userSub, settings);
  }

  private async purgeAllExpired(): Promise<void> {
    await this.pool.query(
      `DELETE FROM ambient_transcript_segments AS segment USING ambient_user_settings AS settings
       WHERE segment.user_sub=settings.user_sub
         AND segment.captured_at < now() - (settings.transcript_retention_days * INTERVAL '1 day')`,
    );
    await this.pool.query(
      `DELETE FROM ambient_daily_reviews AS review USING ambient_user_settings AS settings
       WHERE review.user_sub=settings.user_sub
         AND review.local_date < ((now() AT TIME ZONE settings.time_zone)::date - settings.transcript_retention_days)`,
    );
    await this.purgeAllAudioRetryLedgers();
  }

  private async purgeAllAudioRetryLedgers(): Promise<void> {
    await this.pool.query(
      `DELETE FROM ambient_audio_chunk_receipts
       WHERE created_at < now() - ($1 * INTERVAL '1 hour')`,
      [audioReceiptTtlHours()],
    );
    await this.pool.query(
      `DELETE FROM ambient_audio_chunk_receipts receipt USING (
         SELECT ctid,row_number() OVER (PARTITION BY user_sub ORDER BY created_at DESC) AS owner_rank
         FROM ambient_audio_chunk_receipts
       ) ranked WHERE receipt.ctid=ranked.ctid AND ranked.owner_rank>$1`,
      [audioReceiptLimit()],
    );
    const available = await this.pool.query(
      "SELECT to_regclass('ambient_speaker_observations') AS observations",
    );
    if (!available.rows[0]?.observations) return;
    await this.pool.query(
      `DELETE FROM ambient_speaker_observations
       WHERE observed_at < now() - ($1 * INTERVAL '1 hour')`,
      [audioReceiptTtlHours()],
    );
  }

  private async assertSpeakerTenantSelection(userSub: string, tenantId: string | null): Promise<void> {
    if (!tenantId) return;
    const result = await this.pool.query(
      `SELECT 1 FROM oshal_tenants t JOIN oshal_tenant_memberships m ON m.tenant_id=t.tenant_id
       WHERE t.tenant_id=$1 AND t.kind='org' AND m.user_sub=$2 LIMIT 1`, [tenantId, userSub],
    );
    if (!result.rows[0]) {
      throw new AmbientInputError('speakerTenantId must identify a private organization the caller belongs to');
    }
  }

  private async tracked<T>(operation: string, params: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    logger.info({ operation, ...params }, 'Ambient service entered');
    try {
      const result = await work();
      logger.info({ operation, durationMs: Date.now() - startedAt }, 'Ambient service completed');
      return result;
    } catch (error) {
      logger.error({ err: error, operation, durationMs: Date.now() - startedAt }, 'Ambient service failed');
      throw error;
    }
  }
}

function speakerAwareDayQuery(): string {
  return `SELECT segment.*,
         COALESCE(
           CASE assignment.assignment_kind
             WHEN 'self' THEN 'You'
             WHEN 'custom' THEN assignment.custom_name
             WHEN 'tenant_member' THEN CASE
               WHEN assignment_owner.user_sub IS NOT NULL AND assignment_target.user_sub IS NOT NULL
                 AND char_length(btrim(assignment_target.display_name)) BETWEEN 1 AND 120
                 AND assignment_target.display_name !~ '[[:cntrl:]]'
                 THEN assignment_target.display_name
               ELSE 'Unidentified Person ' || profile.unidentified_ordinal::text END
             ELSE CASE WHEN profile.profile_id IS NOT NULL
               THEN 'Unidentified Person ' || profile.unidentified_ordinal::text ELSE NULL END
           END,
           segment.speaker_label
         ) AS resolved_speaker_label
       FROM ambient_transcript_segments segment
       LEFT JOIN ambient_speaker_profiles profile
         ON profile.profile_id=segment.speaker_profile_id AND profile.owner_sub=segment.user_sub
       LEFT JOIN ambient_speaker_assignments assignment
         ON assignment.profile_id=profile.profile_id AND assignment.owner_sub=segment.user_sub
       LEFT JOIN oshal_tenant_memberships assignment_owner
         ON assignment_owner.tenant_id=assignment.tenant_id AND assignment_owner.user_sub=segment.user_sub
       LEFT JOIN oshal_tenant_memberships assignment_target
         ON assignment_target.tenant_id=assignment.tenant_id AND assignment_target.user_sub=assignment.member_sub
       WHERE segment.user_sub=$1 AND (segment.captured_at AT TIME ZONE $2)::date=$3::date
       ORDER BY segment.captured_at ASC, segment.created_at ASC`;
}

function plainDayQuery(): string {
  return `SELECT * FROM ambient_transcript_segments
    WHERE user_sub=$1 AND (captured_at AT TIME ZONE $2)::date=$3::date
    ORDER BY captured_at ASC, created_at ASC`;
}

async function speakerTablesAvailable(pool: Pool): Promise<boolean> {
  const row = (await pool.query(
    `SELECT to_regclass('ambient_speaker_profiles') AS profiles,
            to_regclass('ambient_speaker_assignments') AS assignments`,
  )).rows[0];
  return Boolean(row?.profiles && row?.assignments);
}

async function clearSpeakerDataIfPresent(pool: Pool, ownerSub: string): Promise<number> {
  if (!(await speakerTablesAvailable(pool))) return 0;
  const result = await pool.query('DELETE FROM ambient_speaker_profiles WHERE owner_sub=$1', [ownerSub]);
  return result.rowCount ?? 0;
}

const instances = new WeakMap<Pool, AmbientListeningService>();

/**
 * @description Returns the process-local ambient service bound to the shared pool.
 * @param pool - Shared GUC-aware Postgres pool.
 * @returns Stable service instance for the pool.
 */
export function ambientListeningFor(pool: Pool): AmbientListeningService {
  let service = instances.get(pool);
  if (!service) {
    service = new AmbientListeningService(pool);
    instances.set(pool, service);
  }
  return service;
}

function buildSegmentInsert(userSub: string, segments: AmbientSegmentInput[]): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const rows = segments.map((segment) => {
    const offset = values.length;
    values.push(randomUUID(), userSub, segment.text, segment.capturedAt, segment.endedAt,
      segment.speakerLabel, segment.wakePhraseDetected, segment.matchedWakePhrase,
      segment.sessionId, segment.clientSegmentId, segment.speakerProfileId);
    return `(${Array.from({ length: 11 }, (_, index) => `$${offset + index + 1}`).join(',')})`;
  });
  return {
    text: `INSERT INTO ambient_transcript_segments
      (segment_id,user_sub,transcript_text,captured_at,ended_at,speaker_label,wake_phrase_detected,
       matched_wake_phrase,session_id,client_segment_id,speaker_profile_id)
      VALUES ${rows.join(',')} ON CONFLICT DO NOTHING RETURNING *`,
    values,
  };
}

async function purgeExpiredWith(
  queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  userSub: string,
  settings: AmbientSettings,
): Promise<void> {
  await queryable.query(
    `DELETE FROM ambient_transcript_segments
     WHERE user_sub=$1 AND captured_at < now() - ($2::int * INTERVAL '1 day')`,
    [userSub, settings.transcriptRetentionDays],
  );
  await queryable.query(
    `DELETE FROM ambient_daily_reviews
     WHERE user_sub=$1 AND local_date < ((now() AT TIME ZONE $3)::date - $2::int)`,
    [userSub, settings.transcriptRetentionDays, settings.timeZone],
  );
}

function mapSettings(row: QueryResultRow): AmbientSettings {
  const wakePhrases = Array.isArray(row.wake_phrases) ? row.wake_phrases.map(String) : [];
  return {
    assistantName: String(row.assistant_name),
    wakePhrases,
    ambientEnabled: Boolean(row.ambient_enabled),
    transcriptRetentionDays: Number(row.transcript_retention_days),
    timeZone: String(row.time_zone),
    dailyReviewEnabled: Boolean(row.daily_review_enabled),
    dailyReviewTime: String(row.daily_review_time).slice(0, 5),
    suggestFollowUps: Boolean(row.suggest_follow_ups),
    speakerDiarizationEnabled: Boolean(row.speaker_diarization_enabled),
    rememberSpeakers: Boolean(row.remember_speakers),
    speakerTenantId: row.speaker_tenant_id ? String(row.speaker_tenant_id) : null,
    updatedAt: new Date(row.updated_at),
  };
}

function mapSegment(row: QueryResultRow): AmbientTranscriptSegment {
  return {
    segmentId: String(row.segment_id),
    text: String(row.transcript_text),
    capturedAt: new Date(row.captured_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : null,
    speakerLabel: row.resolved_speaker_label
      ? String(row.resolved_speaker_label) : row.speaker_label ? String(row.speaker_label) : null,
    wakePhraseDetected: Boolean(row.wake_phrase_detected),
    matchedWakePhrase: row.matched_wake_phrase ? String(row.matched_wake_phrase) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    clientSegmentId: row.client_segment_id ? String(row.client_segment_id) : null,
    speakerProfileId: row.speaker_profile_id ? String(row.speaker_profile_id) : null,
    createdAt: new Date(row.created_at),
  };
}

function mapReview(row: QueryResultRow): AmbientDailyReview {
  const suggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
  return {
    localDate: dateOnly(row.local_date),
    timeZone: String(row.time_zone),
    summary: String(row.summary),
    sourceSegmentCount: Number(row.source_segment_count),
    suggestions,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  } as AmbientDailyReview;
}

function audioReceiptTtlHours(): number {
  return boundedEnvironmentInteger('SPEAKER_AUDIO_RECEIPT_TTL_HOURS', DEFAULT_AUDIO_RECEIPT_TTL_HOURS, 1, 168);
}

function audioReceiptLimit(): number {
  return boundedEnvironmentInteger('SPEAKER_AUDIO_RECEIPT_LIMIT', DEFAULT_AUDIO_RECEIPT_LIMIT, 1_000, 20_000);
}

function audioLeaseSeconds(): number {
  return boundedEnvironmentInteger('SPEAKER_AUDIO_LEASE_SECONDS', DEFAULT_AUDIO_LEASE_SECONDS, 120, 1_800);
}

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function requireRow(row: QueryResultRow | undefined, message: string): QueryResultRow {
  if (!row) throw new Error(message);
  return row;
}

function validateAttributedSegments(segments: AmbientAttributedSegmentInput[]): AmbientAttributedSegmentInput[] {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 100) {
    throw new AmbientInputError('attributed segments must contain between 1 and 100 items');
  }
  return segments.map((segment, index) => validateAttributedSegment(segment, index));
}

function validateAttributedSegment(
  segment: AmbientAttributedSegmentInput,
  index: number,
): AmbientAttributedSegmentInput {
  if (!segment || typeof segment.text !== 'string' || segment.text.length < 1 || segment.text.length > 8_000) {
    throw new AmbientInputError(`attributed segment ${index} text is invalid`);
  }
  if (!(segment.capturedAt instanceof Date) || !Number.isFinite(segment.capturedAt.getTime())) {
    throw new AmbientInputError(`attributed segment ${index} capturedAt is invalid`);
  }
  if (segment.endedAt && segment.endedAt < segment.capturedAt) {
    throw new AmbientInputError(`attributed segment ${index} ends before it starts`);
  }
  if (segment.speakerProfileId && !/^[0-9a-f-]{36}$/i.test(segment.speakerProfileId)) {
    throw new AmbientInputError(`attributed segment ${index} speaker profile is invalid`);
  }
  return { ...segment, text: segment.text.trim().replace(/\s+/g, ' ') };
}

function ambientSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ambient_user_settings (
      user_sub TEXT PRIMARY KEY, assistant_name TEXT NOT NULL DEFAULT 'Jarvis',
      wake_phrases JSONB NOT NULL DEFAULT '["hey jarvis"]'::jsonb,
      ambient_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      transcript_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (transcript_retention_days BETWEEN 1 AND 365),
      time_zone TEXT NOT NULL DEFAULT 'UTC', daily_review_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      daily_review_time TIME NOT NULL DEFAULT '21:00', suggest_follow_ups BOOLEAN NOT NULL DEFAULT TRUE,
      speaker_diarization_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      remember_speakers BOOLEAN NOT NULL DEFAULT FALSE, speaker_tenant_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (char_length(assistant_name) BETWEEN 1 AND 40), CHECK (jsonb_typeof(wake_phrases) = 'array'))`,
    'ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS daily_review_enabled BOOLEAN NOT NULL DEFAULT FALSE',
    "ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS daily_review_time TIME NOT NULL DEFAULT '21:00'",
    'ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS suggest_follow_ups BOOLEAN NOT NULL DEFAULT TRUE',
    'ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS speaker_diarization_enabled BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS remember_speakers BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE ambient_user_settings ADD COLUMN IF NOT EXISTS speaker_tenant_id UUID',
    'ALTER TABLE oshal_tenant_memberships ADD COLUMN IF NOT EXISTS display_name TEXT',
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
    'CREATE INDEX IF NOT EXISTS ambient_settings_review_due ON ambient_user_settings (daily_review_time) WHERE ambient_enabled=TRUE AND daily_review_enabled=TRUE',
    `CREATE TABLE IF NOT EXISTS ambient_transcript_segments (
      segment_id TEXT PRIMARY KEY, user_sub TEXT NOT NULL, transcript_text TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, speaker_label TEXT,
      wake_phrase_detected BOOLEAN NOT NULL DEFAULT FALSE, matched_wake_phrase TEXT,
      session_id TEXT, client_segment_id TEXT, speaker_profile_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (char_length(transcript_text) BETWEEN 1 AND 8000),
      CHECK (ended_at IS NULL OR ended_at >= captured_at))`,
    'CREATE INDEX IF NOT EXISTS ambient_segments_owner_time ON ambient_transcript_segments (user_sub, captured_at DESC)',
    'ALTER TABLE ambient_transcript_segments ADD COLUMN IF NOT EXISTS speaker_profile_id UUID',
    'CREATE UNIQUE INDEX IF NOT EXISTS ambient_segments_owner_client_id ON ambient_transcript_segments (user_sub, client_segment_id) WHERE client_segment_id IS NOT NULL',
    `CREATE TABLE IF NOT EXISTS ambient_daily_reviews (
      review_id TEXT PRIMARY KEY, user_sub TEXT NOT NULL, local_date DATE NOT NULL,
      time_zone TEXT NOT NULL, summary TEXT NOT NULL, suggestions JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_segment_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (user_sub, local_date))`,
    'CREATE INDEX IF NOT EXISTS ambient_reviews_owner_date ON ambient_daily_reviews (user_sub, local_date DESC)',
    `CREATE TABLE IF NOT EXISTS ambient_audio_chunk_receipts (
      user_sub TEXT NOT NULL, client_chunk_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed')),
      claim_token UUID NOT NULL DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ, PRIMARY KEY (user_sub,client_chunk_id))`,
    "ALTER TABLE ambient_audio_chunk_receipts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing'",
    'ALTER TABLE ambient_audio_chunk_receipts ADD COLUMN IF NOT EXISTS claim_token UUID NOT NULL DEFAULT gen_random_uuid()',
    'ALTER TABLE ambient_audio_chunk_receipts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    'ALTER TABLE ambient_audio_chunk_receipts ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ',
    'CREATE INDEX IF NOT EXISTS ambient_audio_receipts_owner_time ON ambient_audio_chunk_receipts (user_sub,created_at)',
    ...buildOwnerRlsPolicyStatements('ambient_user_settings', 'user_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_transcript_segments', 'user_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_daily_reviews', 'user_sub'),
    ...buildOwnerRlsPolicyStatements('ambient_audio_chunk_receipts', 'user_sub'),
  ];
}
