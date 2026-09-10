/** Read-only coverage view over the existing archive and its subject head. No lazy schema work. */
import type { Pool, QueryConfig } from 'pg';

/** Bounded subject-index scans; callers choose coverage, never a global archive sort. */
export async function readWorldCoverage(pool: Pool, at = new Date(), subjects?: readonly string[]) {
  if (subjects && (!subjects.length || subjects.length > 16 || subjects.some(s => typeof s !== 'string' || !s.startsWith('world:') || s.length > 128))) {
    throw new Error('Expected 1–16 world subject IDs');
  }
  // pg supports a per-query timeout; its separately versioned QueryConfig type omits it.
  const timed = (text: string): QueryConfig & { query_timeout: number } => ({ text, values: [at], query_timeout: 1600 });
  const results = await Promise.allSettled([
    pool.query(timed(`SELECT count(*)::text AS pulls, coalesce(sum(fetched),0)::text AS fetched,
      coalesce(sum(new_items),0)::text AS new_subject_items, count(DISTINCT entity_id)::text AS subjects,
      max(ts) AS last_pull FROM world_pulls
      WHERE ts > $1::timestamptz - interval '24 hours' AND ts <= $1`)),
    pool.query({ ...timed(`SELECT s.entity, s.label, a.title, a.description, a.link, a.outlet,
      a.first_seen_at, a.pub_date FROM
      (SELECT entity, label FROM world_subjects WHERE last_seen <= $1 AND last_seen > $1::timestamptz - interval '24 hours'
       AND ($2::text[] IS NULL OR entity = ANY($2::text[]))
       ORDER BY last_seen DESC, entity LIMIT 16) s
      CROSS JOIN LATERAL (SELECT * FROM (SELECT title, description, link, outlet, first_seen_at, pub_date
        FROM world_items WHERE entity_id = s.entity AND first_seen_at <= $1
          AND first_seen_at > $1::timestamptz - interval '7 days'
        ORDER BY first_seen_at DESC LIMIT 100) candidates
        WHERE pub_date <= $1 AND pub_date > $1::timestamptz - interval '48 hours'
        ORDER BY pub_date DESC, title LIMIT 3) a
      ORDER BY a.pub_date DESC, s.entity LIMIT 48`), values: [at, subjects ? [...new Set(subjects)] : null] }),
    pool.query(timed(`SELECT entity_id, event_type, title, scheduled_at, source FROM world_events
      WHERE scheduled_at >= $1 AND scheduled_at < $1::timestamptz + interval '7 days'
      ORDER BY scheduled_at, entity_id LIMIT 3`)),
  ]);
  return { at: at.toISOString(),
    coverage: results[0].status === 'fulfilled' ? results[0].value.rows[0] : null,
    articles: results[1].status === 'fulfilled' ? results[1].value.rows : null,
    events: results[2].status === 'fulfilled' ? results[2].value.rows : null,
  };
}
