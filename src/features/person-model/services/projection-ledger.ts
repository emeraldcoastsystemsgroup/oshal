/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 3: pure-SQL side of the semantic projection — which consent-eligible segments still lack an `ambient-recall` chunk (`pm:<segment_id>`), the anti-join orphan backstop that deletes chunks whose segment is gone, the per-profile chunk purge used by a decline, the rollup rebuild call (SQL function from migration 138), and the `person_model_projections` drift ledger. No embeddings here — semantic-projection.ts supplies those.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'person-model-projection' });

/** The RAG collection the semantic leg lives in (kernel-reserved, see reserved-rag-collections). */
export const AMBIENT_RECALL_COLLECTION = 'ambient-recall';

/** A segment awaiting its semantic chunk. */
export interface UnprojectedSegment {
  segmentId: string;
  text: string;
  capturedAt: string;
  profileId: string | null;
}

/** Ledger row for one owner's vector projection. */
export interface ProjectionLedgerRow {
  ownerSub: string;
  canonRows: number;
  projectedRows: number;
  watermarkCapturedAt: string | null;
  lastRebuildAt: string | null;
  status: string | null;
}

const tableProbe = new WeakMap<object, boolean>();

/**
 * @description Whether `rag_chunks` exists on this deployment (migration 070 self-skips without the
 * pgvector extension). Probed once per pool; a missing table means the semantic leg is silently
 * absent and recall stays FTS-exact-only.
 * @param pool - GUC-aware Postgres pool.
 * @returns True when the table is present.
 */
export async function ragChunksTableExists(pool: Pool): Promise<boolean> {
  const cached = tableProbe.get(pool);
  if (cached !== undefined) return cached;
  const { rows } = await pool.query(`SELECT to_regclass('public.rag_chunks') IS NOT NULL AS present`);
  const present = rows[0]?.present === true;
  tableProbe.set(pool, present);
  return present;
}

/**
 * @description Segments of one owner that are consent-eligible (own voice, granted non-minor
 * profiles, or unattributed) and have no `pm:<segment_id>` chunk yet, oldest first.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner whose canon is being projected.
 * @param eligibleProfiles - Profile ids the consent gate allows modeling for (see eligibleProfileIds).
 * @param limit - Batch bound.
 * @returns The segments to embed.
 */
export async function listUnprojectedSegments(
  pool: Pool, ownerSub: string, eligibleProfiles: ReadonlySet<string>, limit: number,
): Promise<UnprojectedSegment[]> {
  if (!(await ragChunksTableExists(pool))) return [];
  const { rows } = await pool.query(
    `SELECT s.segment_id, s.transcript_text, s.captured_at, s.speaker_profile_id::text AS profile_id
       FROM ambient_transcript_segments s
      WHERE s.user_sub = $1
        AND (s.speaker_profile_id IS NULL OR s.speaker_profile_id = ANY($2::uuid[]))
        AND NOT EXISTS (
          SELECT 1 FROM rag_chunks c WHERE c.collection = $3 AND c.chunk_id = 'pm:' || s.segment_id
        )
      ORDER BY s.captured_at ASC
      LIMIT $4`,
    [ownerSub, [...eligibleProfiles], AMBIENT_RECALL_COLLECTION, limit],
  );
  return rows.map((r) => ({
    segmentId: String(r.segment_id), text: String(r.transcript_text),
    capturedAt: new Date(r.captured_at).toISOString(), profileId: r.profile_id ? String(r.profile_id) : null,
  }));
}

/**
 * @description Anti-join backstop: deletes `ambient-recall` chunks whose transcript segment no
 * longer exists (or, for one owner, only that owner's). The migration-138 triggers make this a
 * no-op in steady state; it exists so no transcript text can outlive its segment in any store.
 * @param pool - GUC-aware Postgres pool (SYSTEM identity for the cross-owner form).
 * @param ownerSub - Optional owner scope.
 * @returns Number of orphan chunks removed.
 */
export async function purgeOrphanChunks(pool: Pool, ownerSub?: string): Promise<number> {
  if (!(await ragChunksTableExists(pool))) return 0;
  const params: unknown[] = [AMBIENT_RECALL_COLLECTION];
  let ownerFilter = '';
  if (ownerSub) { params.push(ownerSub); ownerFilter = `AND c.owner_sub = $${params.length}`; }
  const { rowCount } = await pool.query(
    `DELETE FROM rag_chunks c
      WHERE c.collection = $1 ${ownerFilter}
        AND NOT EXISTS (SELECT 1 FROM ambient_transcript_segments s WHERE 'pm:' || s.segment_id = c.chunk_id)`,
    params,
  );
  if (rowCount) logger.info({ operation: 'purgeOrphanChunks', removed: rowCount }, 'orphan ambient-recall chunks removed');
  return rowCount ?? 0;
}

/**
 * @description Removes every semantic chunk derived from one heard person's utterances — the
 * vector-store leg of a consent decline (forgetting a voice is covered by the migration-138 trigger).
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner sub.
 * @param profileId - The declined profile.
 * @returns Number of chunks removed.
 */
export async function purgeChunksForProfile(pool: Pool, ownerSub: string, profileId: string): Promise<number> {
  if (!(await ragChunksTableExists(pool))) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM rag_chunks WHERE collection = $1 AND owner_sub = $2 AND metadata->>'profile_id' = $3`,
    [AMBIENT_RECALL_COLLECTION, ownerSub, profileId],
  );
  return rowCount ?? 0;
}

/**
 * @description Re-projects one owner's topic rollups and mention relations from the STORED
 * enrichment rows via the migration-138 SQL function — pure SQL, no LLM. Safe to run any number of
 * times; the result depends only on canon + stored inferences.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner sub.
 * @returns Void.
 */
export async function rebuildRollups(pool: Pool, ownerSub: string): Promise<void> {
  await pool.query('SELECT pm_rebuild_rollups($1)', [ownerSub]);
}

/**
 * @description Counts canon vs projected rows for one owner and writes the drift ledger row.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner sub.
 * @param opts - Whether this write follows a full rebuild, and an optional status label.
 * @returns The ledger row as written.
 */
export async function reconcileProjectionLedger(
  pool: Pool, ownerSub: string, opts: { rebuilt?: boolean; status?: string } = {},
): Promise<ProjectionLedgerRow> {
  const present = await ragChunksTableExists(pool);
  const { rows } = await pool.query(
    present
      ? `SELECT (SELECT COUNT(*) FROM ambient_transcript_segments WHERE user_sub = $1)::int AS canon_rows,
                (SELECT COUNT(*) FROM rag_chunks WHERE collection = $2 AND owner_sub = $1)::int AS projected_rows,
                (SELECT MAX((metadata->>'captured_at')::timestamptz) FROM rag_chunks WHERE collection = $2 AND owner_sub = $1) AS watermark`
      : `SELECT (SELECT COUNT(*) FROM ambient_transcript_segments WHERE user_sub = $1)::int AS canon_rows,
                0 AS projected_rows, NULL::timestamptz AS watermark`,
    present ? [ownerSub, AMBIENT_RECALL_COLLECTION] : [ownerSub],
  );
  const canonRows = Number(rows[0]?.canon_rows ?? 0);
  const projectedRows = Number(rows[0]?.projected_rows ?? 0);
  const watermark = rows[0]?.watermark ? new Date(rows[0].watermark).toISOString() : null;
  const status = opts.status ?? (!present ? 'unavailable' : projectedRows >= canonRows ? 'in-sync' : 'lagging');
  const { rows: written } = await pool.query(
    `INSERT INTO person_model_projections (owner_sub, store, watermark_captured_at, canon_rows, projected_rows, last_rebuild_at, status)
     VALUES ($1, 'vector', $2, $3, $4, CASE WHEN $5::boolean THEN now() ELSE NULL END, $6)
     ON CONFLICT (owner_sub, store) DO UPDATE SET
       watermark_captured_at = EXCLUDED.watermark_captured_at, canon_rows = EXCLUDED.canon_rows,
       projected_rows = EXCLUDED.projected_rows, status = EXCLUDED.status,
       last_rebuild_at = COALESCE(EXCLUDED.last_rebuild_at, person_model_projections.last_rebuild_at)
     RETURNING last_rebuild_at`,
    [ownerSub, watermark, canonRows, projectedRows, opts.rebuilt === true, status],
  );
  return {
    ownerSub, canonRows, projectedRows, watermarkCapturedAt: watermark, status,
    lastRebuildAt: written[0]?.last_rebuild_at ? new Date(written[0].last_rebuild_at).toISOString() : null,
  };
}

/**
 * @description Reads the drift ledger row for one owner.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner sub.
 * @returns The row, or null when nothing has been reconciled yet.
 */
export async function readProjectionLedger(pool: Pool, ownerSub: string): Promise<ProjectionLedgerRow | null> {
  const { rows } = await pool.query(
    `SELECT canon_rows, projected_rows, watermark_captured_at, last_rebuild_at, status
       FROM person_model_projections WHERE owner_sub = $1 AND store = 'vector'`,
    [ownerSub],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ownerSub, canonRows: Number(r.canon_rows ?? 0), projectedRows: Number(r.projected_rows ?? 0),
    watermarkCapturedAt: r.watermark_captured_at ? new Date(r.watermark_captured_at).toISOString() : null,
    lastRebuildAt: r.last_rebuild_at ? new Date(r.last_rebuild_at).toISOString() : null,
    status: r.status ? String(r.status) : null,
  };
}

/**
 * @description Owners with ambient listening on who have at least one segment without a semantic
 * chunk — the sweep's work list (consent is applied per owner when projecting).
 * @param pool - GUC-aware pool under SYSTEM identity.
 * @param limit - Max owners per sweep.
 * @returns Owner subs.
 */
export async function ownersWithUnprojectedSegments(pool: Pool, limit: number): Promise<string[]> {
  if (!(await ragChunksTableExists(pool))) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT s.user_sub FROM ambient_transcript_segments s
       JOIN ambient_user_settings u ON u.user_sub = s.user_sub
      WHERE u.ambient_enabled = TRUE
        AND NOT EXISTS (SELECT 1 FROM rag_chunks c WHERE c.collection = $1 AND c.chunk_id = 'pm:' || s.segment_id)
      LIMIT $2`,
    [AMBIENT_RECALL_COLLECTION, limit],
  );
  return rows.map((r) => String(r.user_sub));
}
