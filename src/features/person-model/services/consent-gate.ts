/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: per-heard-person consent gate. Modeling is default-OFF: only the owner's own voice (implicit) and profiles whose LATEST transcript consent is 'granted' (and not a minor) are enriched. Recording a 'declined' stops future accretion AND purges the already-derived dossier for that profile.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'person-model-consent' });

/** A consent row to append (the ledger is append-only; latest per (profile,scope) is current). */
export interface ConsentInput {
  profileId: string;
  scope: 'transcript' | 'voiceprint';
  status: 'granted' | 'declined' | 'revoked';
  isMinor?: boolean;
  method: 'in_app' | 'owner_attested' | 'written';
  evidenceSegmentId?: string | null;
}

/** One heard person's current modeling posture, for the Manage Voices consent panel. */
export interface PersonConsentStatus {
  profileId: string;
  label: string;
  isSelf: boolean;
  /** Latest transcript-scope decision, or null if never decided (default: not modeled). */
  status: 'granted' | 'declined' | 'revoked' | null;
  isMinor: boolean;
  /** Whether this profile is currently enriched (self implicit, or latest = granted and not minor). */
  eligible: boolean;
}

/**
 * @description Lists every heard voice with its current modeling posture — the read behind the
 * Manage Voices consent controls. The owner's own ('self') voice is always eligible; others show
 * their latest transcript decision (null = never decided = not modeled by default).
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner.
 * @returns One row per profile, ordered by ordinal.
 */
export async function listPersonConsentStatus(pool: Pool, ownerSub: string): Promise<PersonConsentStatus[]> {
  const { rows } = await pool.query(
    `SELECT p.profile_id,
            COALESCE(a.custom_name, m.display_name, 'Unidentified Person ' || p.unidentified_ordinal::text) AS label,
            (a.assignment_kind = 'self') AS is_self, latest.status, COALESCE(latest.is_minor, FALSE) AS is_minor
       FROM ambient_speaker_profiles p
       LEFT JOIN ambient_speaker_assignments a ON a.profile_id = p.profile_id AND a.owner_sub = p.owner_sub
       LEFT JOIN oshal_tenant_memberships m
         ON a.assignment_kind = 'tenant_member' AND m.tenant_id = a.tenant_id AND m.user_sub = a.member_sub
       LEFT JOIN LATERAL (
         SELECT status, is_minor FROM ambient_speaker_consents c
          WHERE c.profile_id = p.profile_id AND c.owner_sub = p.owner_sub AND c.scope = 'transcript'
          ORDER BY recorded_at DESC LIMIT 1
       ) latest ON TRUE
      WHERE p.owner_sub = $1
      ORDER BY p.unidentified_ordinal NULLS LAST`,
    [ownerSub],
  );
  return rows.map((r) => {
    const isSelf = Boolean(r.is_self);
    const status = (r.status ?? null) as PersonConsentStatus['status'];
    return {
      profileId: String(r.profile_id), label: String(r.label), isSelf, status, isMinor: Boolean(r.is_minor),
      eligible: isSelf || (status === 'granted' && !r.is_minor),
    };
  });
}

/**
 * @description The set of voice profiles eligible for enrichment right now: the owner's own
 * ('self') voice is implicitly granted by enabling ambient; every other profile must have a
 * LATEST transcript-scope consent of 'granted' and not be flagged a minor. Declined, revoked,
 * minor, and never-affirmed profiles are excluded — modeling is default-off.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner.
 * @returns Set of eligible profile_id strings.
 */
export async function eligibleProfileIds(pool: Pool, ownerSub: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT profile_id FROM ambient_speaker_assignments WHERE owner_sub = $1 AND assignment_kind = 'self'
     UNION
     SELECT profile_id FROM (
       SELECT DISTINCT ON (profile_id) profile_id, status, is_minor
         FROM ambient_speaker_consents
        WHERE owner_sub = $1 AND scope = 'transcript'
        ORDER BY profile_id, recorded_at DESC
     ) latest
     WHERE status = 'granted' AND is_minor = FALSE`,
    [ownerSub],
  );
  return new Set(rows.map((r) => String(r.profile_id)));
}

/**
 * @description Appends a consent row. A 'declined' (or 'revoked') transcript-scope decision is an
 * opt-out, not merely a stop: it also purges every already-derived row for that profile so a
 * heard person's dossier does not persist after they decline.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner.
 * @param input - The consent decision.
 * @returns Void once recorded (and purged when declining).
 */
export async function recordConsent(pool: Pool, ownerSub: string, input: ConsentInput): Promise<void> {
  await pool.query(
    `INSERT INTO ambient_speaker_consents (owner_sub, profile_id, scope, status, is_minor, method, evidence_segment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ownerSub, input.profileId, input.scope, input.status, input.isMinor ?? false, input.method, input.evidenceSegmentId ?? null],
  );
  if (input.scope === 'transcript' && (input.status === 'declined' || input.status === 'revoked')) {
    await purgeDerivedForProfile(pool, ownerSub, input.profileId);
    logger.info({ operation: 'recordConsent', status: input.status }, 'declined profile — derived person-model data purged');
  }
}

/**
 * @description Deletes all derived person-model rows for one profile (enrichment via its segments,
 * asks, topic rollups, relation occurrences). Canon transcript segments are untouched — only the
 * inference layer is removed. Used on decline and on profile deletion.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Authenticated owner.
 * @param profileId - The profile to scrub.
 * @returns Void.
 */
export async function purgeDerivedForProfile(pool: Pool, ownerSub: string, profileId: string): Promise<void> {
  await pool.query(
    `DELETE FROM ambient_utterance_enrichment e
       USING ambient_transcript_segments s
      WHERE e.segment_id = s.segment_id AND e.user_sub = $1 AND s.speaker_profile_id = $2`,
    [ownerSub, profileId],
  );
  await pool.query('DELETE FROM ambient_person_asks WHERE owner_sub = $1 AND profile_id = $2', [ownerSub, profileId]);
  await pool.query('DELETE FROM ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2', [ownerSub, profileId]);
  await pool.query(
    `DELETE FROM ambient_person_relations
      WHERE owner_sub = $1 AND (profile_from_id = $2 OR profile_to_id = $2 OR from_ref = $3 OR to_ref = $3)`,
    [ownerSub, profileId, `person:${profileId}`],
  );
}
