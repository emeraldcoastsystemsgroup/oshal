/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: owner-scoped recall query — resolves a spoken name to voice profiles (custom name / tenant display name / "Unidentified Person N" / self), then counts + quotes matching utterances via the generated tsvector column, bounded to the owner's local day.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { ensurePersonModelSchema } from './person-model-schema';
import type { RecallIntent, RecallResult, RecallReceipt } from './person-model-types';

const logger = createChildLogger({ module: 'person-model-recall' });
const RECEIPT_CAP = 12;

/** A resolved voice profile matching a spoken name. */
interface ResolvedProfile {
  profileId: string;
  label: string;
}

/**
 * @description Resolves a spoken person name to owner-private voice profiles, matching a custom name,
 * a tenant member's display name, the "Unidentified Person N" label, or the owner's own ("me") voice.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param personName - The name as spoken (e.g. "Ella", "me").
 * @returns Matching profiles (possibly several if a name is ambiguous); empty if none match.
 */
export async function resolvePersonProfiles(pool: Pool, ownerSub: string, personName: string): Promise<ResolvedProfile[]> {
  const name = personName.trim();
  if (!name) return [];
  const isSelf = /^(me|myself|i)$/i.test(name);
  const { rows } = await pool.query(
    `SELECT p.profile_id,
       COALESCE(a.custom_name, m.display_name, 'Unidentified Person ' || p.unidentified_ordinal::text) AS label
     FROM ambient_speaker_profiles p
     LEFT JOIN ambient_speaker_assignments a ON a.profile_id = p.profile_id AND a.owner_sub = p.owner_sub
     LEFT JOIN oshal_tenant_memberships m
       ON a.assignment_kind = 'tenant_member' AND m.tenant_id = a.tenant_id AND m.user_sub = a.member_sub
     WHERE p.owner_sub = $1 AND (
        ($3::boolean AND a.assignment_kind = 'self')
        OR a.custom_name ILIKE $2
        OR m.display_name ILIKE $2
        OR ('unidentified person ' || p.unidentified_ordinal::text) ILIKE $2
     )
     ORDER BY p.unidentified_ordinal NULLS LAST`,
    [ownerSub, name, isSelf],
  );
  return rows.map((r) => ({ profileId: String(r.profile_id), label: String(r.label ?? name) }));
}

/**
 * @description Answers an ambient-recall intent with a LITERAL count and quoted receipts. The count is
 * a direct SQL aggregate over the canonical transcript segments (FTS-filtered when a topic is given),
 * never a model estimate; receipts are the matching verbatim lines with owner-local timestamps.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param intent - The parsed recall intent.
 * @returns The recall result (count + receipts + resolved label).
 */
export async function recallQuery(pool: Pool, ownerSub: string, intent: RecallIntent): Promise<RecallResult> {
  await ensurePersonModelSchema(pool);
  const anyone = !intent.personName || intent.personName === 'anyone';
  const profiles = anyone ? [] : await resolvePersonProfiles(pool, ownerSub, intent.personName);
  if (!anyone && profiles.length === 0) {
    logger.info({ operation: 'recallQuery', resolved: false }, 'recall name did not resolve to a voice');
    return { personLabel: null, personResolved: false, count: 0, receipts: [], terms: intent.terms, range: intent.range };
  }

  const params: unknown[] = [ownerSub];
  const conditions = ['s.user_sub = $1'];
  if (!anyone) {
    params.push(profiles.map((p) => p.profileId));
    conditions.push(`s.speaker_profile_id = ANY($${params.length}::uuid[])`);
  }
  if (intent.range === 'today') {
    params.push(await ownerTimeZone(pool, ownerSub));
    const tz = params.length;
    conditions.push(`(s.captured_at AT TIME ZONE $${tz})::date = (now() AT TIME ZONE $${tz})::date`);
  }
  if (intent.terms) {
    params.push(intent.terms);
    conditions.push(`s.fts @@ websearch_to_tsquery('english', $${params.length})`);
  }

  const { rows } = await pool.query(
    `SELECT s.segment_id, s.transcript_text, s.captured_at
       FROM ambient_transcript_segments s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.captured_at ASC`,
    params,
  );
  const receipts: RecallReceipt[] = rows.slice(0, RECEIPT_CAP).map((r) => ({
    segmentId: String(r.segment_id),
    quote: String(r.transcript_text),
    capturedAt: new Date(r.captured_at).toISOString(),
  }));
  return {
    personLabel: anyone ? 'Anyone' : dedupeLabels(profiles),
    personResolved: true,
    count: rows.length,
    receipts,
    terms: intent.terms,
    range: intent.range,
  };
}

/**
 * @description Whether this owner has any captured ambient transcript at all — the gate for treating
 * a recall-shaped chat message as an ambient recall. Owners who have never used ambient listening
 * fall through to normal Jarvis, so a question like "what did John say about the meeting?" is never
 * wrongly answered from an empty transcript store. Fails closed (returns false) on any error.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @returns True when at least one transcript segment exists for this owner.
 */
export async function ownerHasAmbientData(pool: Pool, ownerSub: string): Promise<boolean> {
  try {
    await ensurePersonModelSchema(pool);
    const { rows } = await pool.query(
      'SELECT 1 FROM ambient_transcript_segments WHERE user_sub = $1 LIMIT 1', [ownerSub],
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, operation: 'ownerHasAmbientData' }, 'ambient-data gate check failed');
    return false;
  }
}

/** Reads the owner's IANA time zone (defaults to UTC), used for the owner-local "today" boundary. */
async function ownerTimeZone(pool: Pool, ownerSub: string): Promise<string> {
  const { rows } = await pool.query('SELECT time_zone FROM ambient_user_settings WHERE user_sub = $1', [ownerSub]);
  const tz = rows[0]?.time_zone;
  return typeof tz === 'string' && tz.trim() ? tz : 'UTC';
}

/** Joins distinct resolved labels (a spoken name can be ambiguous across profiles). */
function dedupeLabels(profiles: ResolvedProfile[]): string {
  return [...new Set(profiles.map((p) => p.label))].join(', ');
}
