/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 3: the semantic leg over the owner's own transcripts. Writes deterministic `pm:<segment_id>` chunks into the kernel-reserved `ambient-recall` collection through the shared pgvector engine (owner_sub stamped in metadata so the engine lifts it into the RLS column and data-lifecycle deletes it by column), embeds with the shared MiniLM, and answers paraphrase queries as "possibly related" receipts that are never folded into the exact count. Gated on RAG_ENGINE=pgvector + engine availability; absent that, recall stays FTS-exact-only.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { RagService, localEmbeddings, pgvectorRagEngine } from '@/features/rag';
import { eligibleProfileIds } from './consent-gate';
import { ownerTimeZone, resolvePersonProfiles } from './recall-query';
import {
  AMBIENT_RECALL_COLLECTION, listUnprojectedSegments, purgeOrphanChunks, ragChunksTableExists,
  rebuildRollups, reconcileProjectionLedger, type ProjectionLedgerRow,
} from './projection-ledger';
import type { RecallIntent, RelatedReceipt } from './person-model-types';

const logger = createChildLogger({ module: 'person-model-semantic' });
const PROJECT_BATCH = 200;
const RELATED_FETCH = 12;
const RELATED_CAP = 6;
const REBUILD_MAX_ROUNDS = 500;

/**
 * @description Whether the semantic leg can run here: the pgvector engine is the active RAG engine,
 * its extension + table are present, and the person-model side can see `rag_chunks`.
 * @param pool - GUC-aware Postgres pool.
 * @returns True when chunks can be written and searched.
 */
export async function semanticLegAvailable(pool: Pool): Promise<boolean> {
  if (String(process.env.RAG_ENGINE || '').toLowerCase() !== 'pgvector') return false;
  if (!(await ragChunksTableExists(pool))) return false;
  try {
    return await pgvectorRagEngine.isAvailable();
  } catch (error) {
    logger.warn({ err: error, operation: 'semanticLegAvailable' }, 'pgvector availability probe failed');
    return false;
  }
}

/**
 * @description Projects up to one batch of an owner's consent-eligible, not-yet-projected segments
 * into `ambient-recall` chunks. Idempotent: chunk ids are `pm:<segment_id>` and the engine inserts
 * `ON CONFLICT DO NOTHING`. If the embedder is unavailable nothing is written, so the segments are
 * retried next sweep rather than stored un-embedded.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Owner whose canon is projected.
 * @param limit - Batch bound (default 200).
 * @returns How many chunks were written this call.
 */
export async function projectOwnerSegments(pool: Pool, ownerSub: string, limit = PROJECT_BATCH): Promise<number> {
  if (!(await semanticLegAvailable(pool))) return 0;
  const eligible = await eligibleProfileIds(pool, ownerSub);
  const segments = await listUnprojectedSegments(pool, ownerSub, eligible, limit);
  if (segments.length === 0) return 0;
  const embeddings = await localEmbeddings.embed(segments.map((s) => s.text));
  if (!embeddings) {
    logger.warn({ operation: 'projectOwnerSegments', pending: segments.length }, 'embedder unavailable — projection deferred');
    return 0;
  }
  await pgvectorRagEngine.addChunks(
    AMBIENT_RECALL_COLLECTION,
    segments.map((s) => `pm:${s.segmentId}`),
    segments.map((s) => s.text),
    segments.map((s) => ({
      owner_sub: ownerSub, profile_id: s.profileId ?? '', segment_id: s.segmentId,
      captured_at: s.capturedAt, doc_id: `pm:${s.segmentId}`,
    })),
    embeddings,
  );
  await reconcileProjectionLedger(pool, ownerSub);
  logger.info({ operation: 'projectOwnerSegments', written: segments.length }, 'ambient-recall chunks projected');
  return segments.length;
}

/**
 * @description The paraphrase leg of a recall: searches the owner's `ambient-recall` chunks for the
 * topic terms and returns hits that the exact leg did NOT already quote, filtered to the same person
 * and owner-local day. Never changes the count — callers present these as "possibly related".
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param intent - The recall intent (person, terms, range).
 * @param exactSegmentIds - Segment ids already quoted by the exact leg (excluded here).
 * @returns Related receipts, best match first.
 */
export async function relatedRecall(
  pool: Pool, ownerSub: string, intent: RecallIntent, exactSegmentIds: ReadonlySet<string>,
): Promise<RelatedReceipt[]> {
  if (!intent.terms.trim() || !(await semanticLegAvailable(pool))) return [];
  const anyone = !intent.personName || intent.personName === 'anyone';
  const profileIds = anyone ? null : new Set((await resolvePersonProfiles(pool, ownerSub, intent.personName)).map((p) => p.profileId));
  if (profileIds && profileIds.size === 0) return [];
  const today = intent.range === 'today' ? localDate(new Date(), await ownerTimeZone(pool, ownerSub)) : null;
  let hits;
  try {
    hits = await new RagService().search(intent.terms, AMBIENT_RECALL_COLLECTION, RELATED_FETCH, { userSub: ownerSub, allowPublic: false });
  } catch (error) {
    logger.warn({ err: error, operation: 'relatedRecall' }, 'semantic recall failed — exact leg stands alone');
    return [];
  }
  const related: RelatedReceipt[] = [];
  for (const hit of hits) {
    const meta = hit.metadata ?? {};
    const segmentId = String(meta.segment_id ?? '');
    if (!segmentId || exactSegmentIds.has(segmentId)) continue;
    if (String(meta.owner_sub ?? '') !== ownerSub) continue;
    if (profileIds && !profileIds.has(String(meta.profile_id ?? ''))) continue;
    const capturedAt = String(meta.captured_at ?? '');
    if (today && (!capturedAt || localDate(new Date(capturedAt), await ownerTimeZone(pool, ownerSub)) !== today)) continue;
    related.push({ segmentId, quote: hit.text, capturedAt, score: Number(hit.score) || 0 });
    if (related.length >= RELATED_CAP) break;
  }
  return related;
}

/**
 * @description Full re-projection for one owner — pure SQL/IO, no LLM: rebuild rollups + relations
 * from stored enrichment, drop orphan chunks, project every missing chunk, then reconcile the ledger.
 * Running it twice yields identical row counts (chunk ids are deterministic, rollups are rebuilt).
 * @param pool - GUC-aware Postgres pool (SYSTEM identity when run from a job/script).
 * @param ownerSub - Owner sub.
 * @returns The ledger row after the rebuild.
 */
export async function rebuildOwnerProjection(pool: Pool, ownerSub: string): Promise<ProjectionLedgerRow> {
  await rebuildRollups(pool, ownerSub);
  await purgeOrphanChunks(pool, ownerSub);
  let rounds = 0;
  while (rounds < REBUILD_MAX_ROUNDS) {
    const written = await projectOwnerSegments(pool, ownerSub);
    rounds += 1;
    if (written === 0) break;
  }
  const ledger = await reconcileProjectionLedger(pool, ownerSub, { rebuilt: true });
  logger.info({ operation: 'rebuildOwnerProjection', canonRows: ledger.canonRows, projectedRows: ledger.projectedRows, status: ledger.status }, 'person-model projection rebuilt');
  return ledger;
}

/** Owner-local calendar date (YYYY-MM-DD) for an instant. */
function localDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
