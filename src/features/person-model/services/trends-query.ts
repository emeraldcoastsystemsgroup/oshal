/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 3/4: pure-SQL reads over the person-model rollups — weekly topic trends (date_trunc over ambient_person_topic_daily), the topics connecting two people (self-join on shared topic refs in ambient_person_relations), the heard-people list, and a per-person profile summary (topics / presence / open asks / consent) for the profile surface. No LLM anywhere: every number is a SQL aggregate and every ask is returned beside its verbatim source quote.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { ensurePersonModelSchema } from './person-model-schema';
import { resolvePersonProfiles, ownerTimeZone } from './recall-query';
import { getOpenAsks } from './asks-query';
import { listPersonConsentStatus } from './consent-gate';
import type {
  HeardPerson, PersonConnection, PersonPresenceDay, PersonProfileSummary, PersonTopic, TopicTrendRow, TopicTrendResult,
} from './person-model-types';

const logger = createChildLogger({ module: 'person-model-trends' });
const MAX_WEEKS = 12;
const DEFAULT_WEEKS = 4;
const PRESENCE_DAYS = 30;
const TOPIC_LIMIT = 12;

/** The display-label expression shared with recall/asks (custom name → tenant member → ordinal). */
const LABEL_SQL = `COALESCE(a.custom_name, m.display_name, 'Unidentified Person ' || p.unidentified_ordinal::text)`;
const LABEL_JOINS = `LEFT JOIN ambient_speaker_assignments a ON a.profile_id = p.profile_id AND a.owner_sub = p.owner_sub
       LEFT JOIN oshal_tenant_memberships m
         ON a.assignment_kind = 'tenant_member' AND m.tenant_id = a.tenant_id AND m.user_sub = a.member_sub`;

/**
 * @description Clamps a requested week window to the retention-bounded range the rollups can answer.
 * @param weeks - Requested window (undefined → default).
 * @returns An integer in [1, MAX_WEEKS].
 */
export function clampWeeks(weeks: number | undefined): number {
  const n = Number(weeks);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WEEKS;
  return Math.min(MAX_WEEKS, Math.floor(n));
}

/**
 * @description Weekly topic trend for one person (or everyone) from the daily rollup — a literal
 * `date_trunc('week', …)` over `ambient_person_topic_daily`, never a model summary.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param opts - Optional person name (empty/anyone = every modeled voice) and week window.
 * @returns Resolved label + rows ordered newest week first, most-mentioned topic first.
 */
export async function weeklyTopicTrends(
  pool: Pool, ownerSub: string, opts: { personName?: string; weeks?: number } = {},
): Promise<TopicTrendResult> {
  await ensurePersonModelSchema(pool);
  const weeks = clampWeeks(opts.weeks);
  const anyone = !opts.personName || /^(anyone|everyone)$/i.test(opts.personName.trim());
  const profiles = anyone ? [] : await resolvePersonProfiles(pool, ownerSub, opts.personName as string);
  if (!anyone && profiles.length === 0) {
    return { personLabel: null, personResolved: false, weeks, rows: [] };
  }
  const params: unknown[] = [ownerSub, weeks];
  let personFilter = '';
  if (!anyone) {
    params.push(profiles.map((p) => p.profileId));
    personFilter = `AND d.profile_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await pool.query(
    `SELECT (date_trunc('week', d.local_date))::date AS week_start, d.topic,
            SUM(d.mention_count)::int AS mentions, ${LABEL_SQL} AS person_label
       FROM ambient_person_topic_daily d
       JOIN ambient_speaker_profiles p ON p.profile_id = d.profile_id AND p.owner_sub = d.owner_sub
       ${LABEL_JOINS}
      WHERE d.owner_sub = $1 AND d.local_date >= (CURRENT_DATE - ($2::int * 7)) ${personFilter}
      GROUP BY 1, 2, 4
      ORDER BY 1 DESC, 3 DESC, 2 ASC
      LIMIT 200`,
    params,
  );
  const trend: TopicTrendRow[] = rows.map((r) => ({
    weekStart: toIsoDate(r.week_start), topic: String(r.topic), mentions: Number(r.mentions), personLabel: String(r.person_label),
  }));
  return {
    personLabel: anyone ? 'Anyone' : [...new Set(profiles.map((p) => p.label))].join(', '),
    personResolved: true, weeks, rows: trend,
  };
}

/**
 * @description The topics two people both mention — a self-join over `ambient_person_relations` on
 * shared `topic:*` refs, dated by `observed_on`. Days are counted distinctly per person so a busy
 * day never inflates the overlap.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param personA - First spoken name.
 * @param personB - Second spoken name.
 * @returns Which names resolved and the shared topics, most-shared first.
 */
export async function topicsConnecting(
  pool: Pool, ownerSub: string, personA: string, personB: string,
): Promise<{ labelA: string | null; labelB: string | null; resolved: boolean; topics: PersonConnection[] }> {
  await ensurePersonModelSchema(pool);
  const [a, b] = await Promise.all([
    resolvePersonProfiles(pool, ownerSub, personA), resolvePersonProfiles(pool, ownerSub, personB),
  ]);
  if (a.length === 0 || b.length === 0) {
    return { labelA: a[0]?.label ?? null, labelB: b[0]?.label ?? null, resolved: false, topics: [] };
  }
  const { rows } = await pool.query(
    `WITH ra AS (
       SELECT to_ref, observed_on FROM ambient_person_relations
        WHERE owner_sub = $1 AND rel_type = 'mentions' AND to_ref LIKE 'topic:%' AND profile_from_id = ANY($2::uuid[])
     ), rb AS (
       SELECT to_ref, observed_on FROM ambient_person_relations
        WHERE owner_sub = $1 AND rel_type = 'mentions' AND to_ref LIKE 'topic:%' AND profile_from_id = ANY($3::uuid[])
     )
     SELECT substr(ra.to_ref, 7) AS topic,
            COUNT(DISTINCT ra.observed_on)::int AS days_a, COUNT(DISTINCT rb.observed_on)::int AS days_b,
            GREATEST(MAX(ra.observed_on), MAX(rb.observed_on)) AS last_on
       FROM ra JOIN rb ON rb.to_ref = ra.to_ref
      GROUP BY 1
      ORDER BY (COUNT(DISTINCT ra.observed_on) + COUNT(DISTINCT rb.observed_on)) DESC, 1 ASC
      LIMIT 50`,
    [ownerSub, a.map((p) => p.profileId), b.map((p) => p.profileId)],
  );
  return {
    labelA: dedupe(a), labelB: dedupe(b), resolved: true,
    topics: rows.map((r) => ({
      topic: String(r.topic), daysA: Number(r.days_a), daysB: Number(r.days_b), lastObservedOn: toIsoDate(r.last_on),
    })),
  };
}

/**
 * @description Every voice this owner has heard, with its display label, utterance count, and the
 * span it was heard over — the People list of the profile surface.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @returns Heard people, most recently heard first.
 */
export async function listHeardPeople(pool: Pool, ownerSub: string): Promise<HeardPerson[]> {
  await ensurePersonModelSchema(pool);
  const { rows } = await pool.query(
    `SELECT p.profile_id, ${LABEL_SQL} AS label, COALESCE(a.assignment_kind = 'self', FALSE) AS is_self,
            COUNT(s.segment_id)::int AS utterances, MIN(s.captured_at) AS first_heard_at, MAX(s.captured_at) AS last_heard_at
       FROM ambient_speaker_profiles p
       ${LABEL_JOINS}
       LEFT JOIN ambient_transcript_segments s ON s.speaker_profile_id = p.profile_id AND s.user_sub = p.owner_sub
      WHERE p.owner_sub = $1
      GROUP BY p.profile_id, p.unidentified_ordinal, a.custom_name, a.assignment_kind, m.display_name
      ORDER BY MAX(s.captured_at) DESC NULLS LAST, p.unidentified_ordinal NULLS LAST`,
    [ownerSub],
  );
  return rows.map((r) => ({
    profileId: String(r.profile_id), label: String(r.label), isSelf: r.is_self === true,
    utterances: Number(r.utterances), firstHeardAt: toIsoOrNull(r.first_heard_at), lastHeardAt: toIsoOrNull(r.last_heard_at),
  }));
}

/**
 * @description One person's profile: identity, presence over the last month, top topics, open asks
 * (each beside its verbatim quote), and current consent posture. Topics and asks are OSHAL's read
 * and are flagged as inferences; presence and utterance counts are transcript facts.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param profileId - The voice profile id (owner-private).
 * @returns The summary, or null when the profile is not this owner's.
 */
export async function personProfileSummary(pool: Pool, ownerSub: string, profileId: string): Promise<PersonProfileSummary | null> {
  const people = await listHeardPeople(pool, ownerSub);
  const person = people.find((p) => p.profileId === profileId);
  if (!person) {
    logger.info({ operation: 'personProfileSummary', found: false }, 'profile not found for owner');
    return null;
  }
  const tz = await ownerTimeZone(pool, ownerSub);
  const [topics, presence, asks, consents] = await Promise.all([
    topTopics(pool, ownerSub, profileId),
    presenceDays(pool, ownerSub, profileId, tz),
    getOpenAsks(pool, ownerSub, { profileId }),
    listPersonConsentStatus(pool, ownerSub),
  ]);
  const consent = consents.find((c) => c.profileId === profileId) ?? null;
  return { ...person, timeZone: tz, topics, presence, asks, consent };
}

/** Top topics for one profile from the daily rollup (sum of mentions, last day seen). */
async function topTopics(pool: Pool, ownerSub: string, profileId: string): Promise<PersonTopic[]> {
  const { rows } = await pool.query(
    `SELECT topic, SUM(mention_count)::int AS mentions, MAX(local_date) AS last_on
       FROM ambient_person_topic_daily WHERE owner_sub = $1 AND profile_id = $2
      GROUP BY topic ORDER BY 2 DESC, 1 ASC LIMIT $3`,
    [ownerSub, profileId, TOPIC_LIMIT],
  );
  return rows.map((r) => ({ topic: String(r.topic), mentions: Number(r.mentions), lastOn: toIsoDate(r.last_on) }));
}

/** Utterances per owner-local day over the presence window — a transcript fact, not an inference. */
async function presenceDays(pool: Pool, ownerSub: string, profileId: string, tz: string): Promise<PersonPresenceDay[]> {
  const { rows } = await pool.query(
    `SELECT (captured_at AT TIME ZONE $3)::date AS local_date, COUNT(*)::int AS utterances
       FROM ambient_transcript_segments
      WHERE user_sub = $1 AND speaker_profile_id = $2 AND captured_at >= now() - ($4::int * interval '1 day')
      GROUP BY 1 ORDER BY 1 DESC`,
    [ownerSub, profileId, tz, PRESENCE_DAYS],
  );
  return rows.map((r) => ({ localDate: toIsoDate(r.local_date), utterances: Number(r.utterances) }));
}

function dedupe(profiles: Array<{ label: string }>): string {
  return [...new Set(profiles.map((p) => p.label))].join(', ');
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '').slice(0, 10);
}

function toIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  return new Date(value as string).toISOString();
}
