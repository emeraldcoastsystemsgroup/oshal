/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | User-scoped privacy export/delete routes for
 *                     |               | Own Data evidence gates.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Included ambient transcripts, settings, reviews, speaker-profile metadata, and biometric-template erasure in owner export/delete.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added speaker identity-label export/erasure and audio receipt deletion to the privacy lifecycle.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Included owner-scoped Jarvis work records and persisted visual-response artifacts in privacy export and erasure.
 */

import { Router, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import type { AppContext } from '../composition-root';
import { getCaller } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import { withAmbientOwnerLock } from '@/shared/services/database';
import { emitAuditEvent, queryAuditEvents, type AuditRow } from '@/features/governance';
import { purgeJarvisAskJobsForOwner } from './jarvis-routes';

const logger = createChildLogger({ module: 'privacy-routes' });

export const PRIVACY_DELETE_CONFIRMATION = 'DELETE MY OSHAL DATA';
const MAX_EXPORT_ROWS = 1000;

export function createPrivacyRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/export', handleExport(ctx));
  router.delete('/me', handleDeleteMe(ctx));

  logger.info('Privacy routes registered');
  return router;
}

function handleExport(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const subject = requireSubject(req, res);
    if (!subject) return;

    try {
      const exportData = await collectUserExport(ctx, subject);
      void emitPrivacyAudit(ctx, subject, 'privacy.export', 'privacy_export', subject, {
        tasks: exportData.counts.tasks,
        messages: exportData.counts.messages,
        tickets: exportData.counts.tickets,
        ambientTranscriptSegments: exportData.counts.ambientTranscriptSegments,
        speakerProfiles: exportData.counts.speakerProfiles,
        membershipDisplayNames: exportData.counts.membershipDisplayNames,
        jarvisTasks: exportData.counts.jarvisTasks,
        visualResponseArtifacts: exportData.counts.visualResponseArtifacts,
      });
      res.json(exportData);
    } catch (error) {
      logger.error({ err: error, subject }, 'privacy export failed');
      res.status(500).json({ error: 'Failed to export user data' });
    }
  };
}

function handleDeleteMe(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const subject = requireSubject(req, res);
    if (!subject) return;

    if (String(req.body?.confirm || '') !== PRIVACY_DELETE_CONFIRMATION) {
      res.status(400).json({
        error: 'Confirmation required',
        confirm: PRIVACY_DELETE_CONFIRMATION,
      });
      return;
    }

    try {
      const exportData = await collectUserExport(ctx, subject);
      const ambientDeleted = await deleteAmbientOwnerData(ctx, subject);
      const jarvisDeleted = await deleteJarvisOwnerData(ctx, subject);
      const ephemeralJarvisAnswers = purgeJarvisAskJobsForOwner(subject);
      for (const task of exportData.tasks) {
        await ctx.messageStore.deleteByTask(task.taskId);
        await ctx.taskStore.delete(task.taskId);
      }
      for (const ticket of exportData.tickets) {
        await ctx.ticketService.deleteTicket(ticket.ticketId);
      }

      void emitPrivacyAudit(ctx, subject, 'privacy.delete', 'privacy_export', subject, {
        deletedTasks: exportData.counts.tasks,
        deletedMessages: exportData.counts.messages,
        deletedTickets: exportData.counts.tickets,
        deletedAmbientTranscriptSegments: ambientDeleted.transcriptSegments,
        deletedSpeakerProfiles: ambientDeleted.speakerProfiles,
        deletedAudioChunkReceipts: ambientDeleted.audioChunkReceipts,
        clearedMembershipDisplayNames: ambientDeleted.membershipDisplayNamesCleared,
        deletedJarvisTasks: jarvisDeleted.tasks,
        deletedVisualResponseArtifacts: jarvisDeleted.visualResponseArtifacts,
        deletedEphemeralJarvisAnswers: ephemeralJarvisAnswers,
        retainedAuditEvents: true,
      });

      res.json({
        success: true,
        subject: { sub: subject },
        deleted: {
          tasks: exportData.counts.tasks,
          messages: exportData.counts.messages,
          tickets: exportData.counts.tickets,
          jarvisTasks: jarvisDeleted.tasks,
          visualResponseArtifacts: jarvisDeleted.visualResponseArtifacts,
          ephemeralJarvisAnswers,
        },
        ambientDeleted,
        retained: {
          auditEvents: true,
          reason: 'Compliance audit records are retained separately from user operational data.',
        },
      });
    } catch (error) {
      logger.error({ err: error, subject }, 'privacy delete failed');
      res.status(500).json({ error: 'Failed to delete user data' });
    }
  };
}

async function collectUserExport(ctx: AppContext, subject: string) {
  const [tasks, tickets, auditEvents, ambient, jarvis] = await Promise.all([
    ctx.taskStore.list({ ownerSub: subject, limit: MAX_EXPORT_ROWS }),
    ctx.ticketService.listTickets({ ownerSub: subject, limit: MAX_EXPORT_ROWS }),
    safeAuditEvents(ctx, subject),
    collectAmbientOwnerData(ctx, subject),
    collectJarvisOwnerData(ctx, subject),
  ]);

  const messagesByTask = [];
  let messageCount = 0;
  for (const task of tasks) {
    const messages = await ctx.messageStore.getByTask(task.taskId);
    messageCount += messages.length;
    messagesByTask.push({ taskId: task.taskId, messages });
  }

  return {
    generatedAt: new Date().toISOString(),
    subject: { sub: subject },
    counts: {
      tasks: tasks.length,
      messages: messageCount,
      tickets: tickets.length,
      auditEvents: auditEvents.length,
      ambientTranscriptSegments: ambient.transcriptSegments.length,
      ambientDailyReviews: ambient.dailyReviews.length,
      speakerProfiles: ambient.speakerProfiles.length,
      speakerAssignments: ambient.speakerAssignments.length,
      speakerObservations: ambient.speakerObservations.length,
      speakerTargetReferences: ambient.speakerTargetReferences.length,
      membershipDisplayNames: ambient.membershipDisplayNames.length,
      jarvisTasks: jarvis.tasks.length,
      visualResponseArtifacts: jarvis.visualResponseArtifacts.length,
    },
    tasks,
    messagesByTask,
    tickets,
    auditEvents,
    ambient,
    jarvis,
    retention: {
      auditEvents: 'retained for compliance/audit integrity',
    },
  };
}

interface JarvisOwnerData {
  tasks: Array<Record<string, unknown>>;
  visualResponseArtifacts: Array<Record<string, unknown>>;
}

interface JarvisDeleteCounts {
  tasks: number;
  visualResponseArtifacts: number;
}

/**
 * @description Collects the caller's durable Jarvis work and the exact persisted SVG artifacts.
 * Visual bytes are base64 encoded so the privacy export is valid JSON and can reproduce the image.
 */
async function collectJarvisOwnerData(ctx: AppContext, subject: string): Promise<JarvisOwnerData> {
  const [tasks, visualResponseArtifacts] = await Promise.all([
    safePrivacyRows(ctx, subject, `SELECT id, session_id AS "sessionId", title, status, result, error,
      kind, ticket_id AS "ticketId", visual, delivered, created_at AS "createdAt",
      finished_at AS "finishedAt" FROM jarvis_tasks
      WHERE user_sub=$1 ORDER BY created_at LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT artifact_id AS "artifactId", source_surface AS "sourceSurface",
      source_session_id AS "sourceSessionId", source_job_id AS "sourceJobId", mime_type AS "mimeType",
      width, height, alt_text AS alt, encode(content, 'base64') AS "contentBase64",
      content_sha256 AS "contentSha256", provenance, created_at AS "createdAt"
      FROM visual_response_artifacts WHERE user_sub=$1 ORDER BY created_at LIMIT ${MAX_EXPORT_ROWS}`),
  ]);
  return { tasks, visualResponseArtifacts };
}

/** @description Erases durable Jarvis work and owner-scoped visual artifacts. */
async function deleteJarvisOwnerData(ctx: AppContext, subject: string): Promise<JarvisDeleteCounts> {
  const visualResponseArtifacts = await safePrivacyDelete(
    ctx, subject, 'DELETE FROM visual_response_artifacts WHERE user_sub=$1',
  );
  const tasks = await safePrivacyDelete(ctx, subject, 'DELETE FROM jarvis_tasks WHERE user_sub=$1');
  return { tasks, visualResponseArtifacts };
}

interface AmbientOwnerData {
  settings: Record<string, unknown> | null;
  transcriptSegments: Array<Record<string, unknown>>;
  dailyReviews: Array<Record<string, unknown>>;
  speakerProfiles: Array<Record<string, unknown>>;
  speakerAssignments: Array<Record<string, unknown>>;
  speakerObservations: Array<Record<string, unknown>>;
  speakerTargetReferences: Array<Record<string, unknown>>;
  membershipDisplayNames: Array<Record<string, unknown>>;
  sensitiveFieldsOmitted: string[];
}

interface AmbientDeleteCounts {
  transcriptSegments: number;
  dailyReviews: number;
  speakerAssignments: number;
  speakerObservations: number;
  targetSpeakerReferences: number;
  speakerProfiles: number;
  speakerOrdinalCounters: number;
  audioChunkReceipts: number;
  membershipDisplayNamesCleared: number;
  settings: number;
}

/**
 * @description Collects owner-visible ambient data without exporting encrypted biometric vectors.
 * The template ciphertext is deliberately non-portable; account deletion still erases it.
 */
async function collectAmbientOwnerData(ctx: AppContext, subject: string): Promise<AmbientOwnerData> {
  const [settings, speakerSettings, transcriptSegments, dailyReviews, speakerProfiles, speakerAssignments,
    speakerObservations, speakerTargetReferences, membershipDisplayNames] = await Promise.all([
    safePrivacyRows(ctx, subject, `SELECT assistant_name AS "assistantName", wake_phrases AS "wakePhrases",
      ambient_enabled AS "ambientEnabled", transcript_retention_days AS "transcriptRetentionDays",
      time_zone AS "timeZone", daily_review_enabled AS "dailyReviewEnabled",
      daily_review_time AS "dailyReviewTime", suggest_follow_ups AS "suggestFollowUps",
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM ambient_user_settings WHERE user_sub=$1 LIMIT 1`),
    safePrivacyRows(ctx, subject, `SELECT speaker_diarization_enabled AS "speakerDiarizationEnabled",
      remember_speakers AS "rememberSpeakers", speaker_tenant_id AS "speakerTenantId"
      FROM ambient_user_settings WHERE user_sub=$1 LIMIT 1`),
    safePrivacyRows(ctx, subject, `SELECT segment_id AS "segmentId", transcript_text AS text,
      captured_at AS "capturedAt", ended_at AS "endedAt", speaker_label AS "speakerLabel",
      wake_phrase_detected AS "wakePhraseDetected", matched_wake_phrase AS "matchedWakePhrase", session_id AS "sessionId",
      client_segment_id AS "clientSegmentId", created_at AS "createdAt"
      FROM ambient_transcript_segments WHERE user_sub=$1 ORDER BY captured_at LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT review_id AS "reviewId", local_date AS "localDate",
      time_zone AS "timeZone", summary, suggestions, source_segment_count AS "sourceSegmentCount",
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM ambient_daily_reviews WHERE user_sub=$1 ORDER BY local_date LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT profile_id AS "profileId", unidentified_ordinal AS ordinal,
      embedding_model AS "embeddingModel", embedding_dimensions AS "embeddingDimensions",
      sample_count AS "sampleCount", first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
      updated_at AS "updatedAt" FROM ambient_speaker_profiles
      WHERE owner_sub=$1 ORDER BY unidentified_ordinal LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT profile_id AS "profileId", assignment_kind AS kind,
      custom_name AS "customName", tenant_id AS "tenantId", member_sub AS "memberSub",
      assigned_at AS "assignedAt" FROM ambient_speaker_assignments
      WHERE owner_sub=$1 ORDER BY assigned_at LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT client_chunk_id AS "clientChunkId", speaker_key AS "speakerKey",
      profile_id AS "profileId", similarity, created_profile AS "createdProfile", observed_at AS "observedAt"
      FROM ambient_speaker_observations WHERE owner_sub=$1 ORDER BY observed_at LIMIT ${MAX_EXPORT_ROWS}`),
    safePrivacyRows(ctx, subject, `SELECT tenant_id AS "tenantId", assigned_at AS "assignedAt"
      FROM ambient_speaker_assignments WHERE member_sub=$1 AND owner_sub<>$1
      ORDER BY assigned_at LIMIT ${MAX_EXPORT_ROWS}`),
    collectMembershipDisplayNames(ctx, subject),
  ]);
  return {
    settings: settings[0] || speakerSettings[0] ? { ...(settings[0] || {}), ...(speakerSettings[0] || {}) } : null,
    transcriptSegments,
    dailyReviews,
    speakerProfiles,
    speakerAssignments,
    speakerObservations,
    speakerTargetReferences,
    membershipDisplayNames,
    sensitiveFieldsOmitted: ['speakerProfiles.embeddingCiphertext'],
  };
}

/** @description Exports only identity labels stored on the caller's own organization memberships. */
async function collectMembershipDisplayNames(
  ctx: AppContext,
  subject: string,
): Promise<Array<Record<string, unknown>>> {
  return safePrivacyRows(ctx, subject, `SELECT tenant_id AS "tenantId", display_name AS "displayName"
    FROM oshal_tenant_memberships WHERE user_sub=$1 AND display_name IS NOT NULL
    ORDER BY tenant_id LIMIT ${MAX_EXPORT_ROWS}`);
}

/** @description Erases all ambient text and encrypted biometric material owned by one subject. */
async function deleteAmbientOwnerData(ctx: AppContext, subject: string): Promise<AmbientDeleteCounts> {
  return withAmbientOwnerLock(ctx.pool, subject, () => deleteAmbientOwnerDataLocked(ctx, subject), true);
}

async function deleteAmbientOwnerDataLocked(ctx: AppContext, subject: string): Promise<AmbientDeleteCounts> {
  const targetIdentity = await deleteTargetSpeakerIdentity(ctx, subject);
  const dailyReviews = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_daily_reviews WHERE user_sub=$1');
  const transcriptSegments = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_transcript_segments WHERE user_sub=$1');
  const targetSpeakerReferences = targetIdentity.targetSpeakerReferences;
  const speakerAssignments = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_speaker_assignments WHERE owner_sub=$1');
  const speakerObservations = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_speaker_observations WHERE owner_sub=$1');
  const speakerProfiles = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_speaker_profiles WHERE owner_sub=$1');
  const speakerOrdinalCounters = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_speaker_ordinal_counters WHERE owner_sub=$1');
  const audioChunkReceipts = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_audio_chunk_receipts WHERE user_sub=$1');
  const settings = await safePrivacyDelete(ctx, subject, 'DELETE FROM ambient_user_settings WHERE user_sub=$1');
  const membershipDisplayNamesCleared = targetIdentity.membershipDisplayNamesCleared;
  return {
    transcriptSegments, dailyReviews, targetSpeakerReferences, speakerAssignments, speakerObservations,
    speakerProfiles, speakerOrdinalCounters,
    audioChunkReceipts, membershipDisplayNamesCleared, settings,
  };
}

async function deleteTargetSpeakerIdentity(ctx: AppContext, subject: string): Promise<{
  targetSpeakerReferences: number;
  membershipDisplayNamesCleared: number;
}> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`speaker-target:${subject}`]);
    const available = await client.query("SELECT to_regclass('ambient_speaker_assignments') AS assignments");
    const targetSpeakerReferences = available.rows[0]?.assignments
      ? (await client.query('DELETE FROM ambient_speaker_assignments WHERE member_sub=$1', [subject])).rowCount ?? 0
      : 0;
    const membershipDisplayNamesCleared = (await client.query(
      'UPDATE oshal_tenant_memberships SET display_name=NULL WHERE user_sub=$1 AND display_name IS NOT NULL',
      [subject],
    )).rowCount ?? 0;
    await client.query('COMMIT');
    return { targetSpeakerReferences, membershipDisplayNamesCleared };
  } catch (error) {
    await rollbackPrivacyClient(client, subject, error);
    if (isUndefinedTableOrColumn(error)) return {
      targetSpeakerReferences: 0, membershipDisplayNamesCleared: 0,
    };
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackPrivacyClient(
  client: PoolClient,
  subject: string,
  cause: unknown,
): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    logger.error({ err: error, cause, subject }, 'privacy identity transaction rollback failed');
  }
}

async function safePrivacyRows(ctx: AppContext, subject: string, sql: string): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await ctx.pool.query(sql, [subject]);
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    if (isUndefinedTableOrColumn(error)) {
      logger.warn({ subject }, 'privacy export skipped optional schema not yet installed');
      return [];
    }
    throw error;
  }
}

async function safePrivacyDelete(ctx: AppContext, subject: string, sql: string): Promise<number> {
  try {
    const result = await ctx.pool.query(sql, [subject]);
    return result.rowCount ?? 0;
  } catch (error) {
    if (isUndefinedTableOrColumn(error)) {
      logger.warn({ subject }, 'privacy deletion skipped optional schema not yet installed');
      return 0;
    }
    throw error;
  }
}

function isUndefinedTableOrColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703';
}

async function safeAuditEvents(ctx: AppContext, subject: string): Promise<AuditRow[]> {
  try {
    return await queryAuditEvents(ctx.pool, { actorSub: subject, limit: MAX_EXPORT_ROWS });
  } catch (error) {
    logger.warn({ err: error, subject }, 'privacy export skipped unavailable audit events');
    return [];
  }
}

async function emitPrivacyAudit(
  ctx: AppContext,
  subject: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await emitAuditEvent(ctx.pool, {
    actorSub: subject,
    action,
    resourceType,
    resourceId,
    decision: 'allow',
    metadata,
  });
}

function requireSubject(req: Request, res: Response): string | null {
  const subject = getCaller(req).sub;
  if (!subject) {
    res.status(401).json({ error: 'Authenticated subject required' });
    return null;
  }
  return subject;
}
