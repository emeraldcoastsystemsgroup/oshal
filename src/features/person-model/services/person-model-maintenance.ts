/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: nightly pure-SQL retention purge. Bounds the aggregate person-model stores (per-person daily topic counts + dated relations) to each owner's transcript_retention_days, matching the retention the settings UI promises. No LLM — controller-permitted (ADR-036). Enrichment/asks rows are already bounded by FK CASCADE when their transcript segment ages out.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'person-model-maintenance' });

/**
 * @description Purges aggregate person-model rows older than each owner's transcript retention window.
 * `ambient_person_topic_daily` has no segment FK (it is a pure rollup), so it needs explicit
 * retention; `ambient_person_relations` mostly cascades with its segment but is bounded here too as a
 * backstop. Idempotent and safe to run on any schedule.
 * @param pool - GUC-aware pool.
 * @returns Counts of rows purged from each store.
 */
export async function purgeExpiredPersonModelData(pool: Pool): Promise<{ topicDaily: number; relations: number }> {
  const topicDaily = await pool.query(
    `DELETE FROM ambient_person_topic_daily d
       USING ambient_user_settings u
      WHERE d.owner_sub = u.user_sub
        AND d.local_date < (now() AT TIME ZONE u.time_zone)::date - u.transcript_retention_days`,
  );
  const relations = await pool.query(
    `DELETE FROM ambient_person_relations r
       USING ambient_user_settings u
      WHERE r.owner_sub = u.user_sub
        AND r.observed_on < (now() AT TIME ZONE u.time_zone)::date - u.transcript_retention_days`,
  );
  const purged = { topicDaily: topicDaily.rowCount ?? 0, relations: relations.rowCount ?? 0 };
  if (purged.topicDaily > 0 || purged.relations > 0) {
    logger.info({ operation: 'purgeExpiredPersonModelData', ...purged }, 'person-model retention purge complete');
  }
  return purged;
}
