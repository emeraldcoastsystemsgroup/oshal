/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: enrichment service — hands one owner-batch to the ambient-analyst brain, parses the taxonomy-validated result, and idempotently persists per-segment enrichment + asks (dedupe_key) + topic rollups + dated relations. The brain invoker keeps the LLM call in the app layer (FSD); tests inject a fake brain.
 */

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  buildEnrichmentPrompt,
  parseEnrichmentJson,
  TAXONOMY_VERSION,
  type EnrichmentInput,
  type EnrichmentResult,
} from './enrichment-prompt';

const logger = createChildLogger({ module: 'person-model-enrichment' });

/** The concierge brain transport (mirrors JudgeService): tests inject a fake for zero LLM cost. */
export type EnrichBrainInvoker = (taskId: string, prompt: string) => Promise<string>;

/** A batch item carrying the fields needed both to prompt AND to persist rollups. */
export interface EnrichBatchItem extends EnrichmentInput {
  profileId: string | null;
  capturedAt: string;
}

/** Outcome counts for one enriched batch. */
export interface EnrichOutcome {
  requested: number;
  enriched: number;
  asks: number;
}

/**
 * @description Enriches one owner-batch: prompts the analyst, validates the reply against the closed
 * taxonomy, and persists. Persistence is idempotent per (segment, taxonomy_version) — an
 * already-enriched segment never double-counts a rollup. Never throws on a bad reply (returns zero
 * enriched); DB errors propagate to the caller's per-sweep catch.
 * @param pool - GUC-aware pool.
 * @param ownerSub - Accountable owner.
 * @param batch - Eligible attributed utterances.
 * @param invoke - The analyst brain transport.
 * @param opts - Owner time zone (for local rollups) + model label.
 * @returns Counts of requested/enriched/asks.
 */
export async function enrichBatch(
  pool: Pool,
  ownerSub: string,
  batch: EnrichBatchItem[],
  invoke: EnrichBrainInvoker,
  opts: { timeZone: string; model?: string },
): Promise<EnrichOutcome> {
  if (batch.length === 0) return { requested: 0, enriched: 0, asks: 0 };
  const taskId = `ambient-enrich-${ownerSub.slice(0, 8)}-${batch[0].segmentId}`;
  const raw = await invoke(taskId, buildEnrichmentPrompt(batch));
  const results = parseEnrichmentJson(raw, batch);
  const byId = new Map(batch.map((b) => [b.segmentId, b]));
  const model = opts.model ?? 'ambient-analyst';
  let enriched = 0;
  let asks = 0;
  for (const result of results) {
    const item = byId.get(result.segmentId);
    if (!item) continue;
    const persisted = await persistResult(pool, ownerSub, result, item, opts.timeZone, model);
    enriched += persisted.inserted ? 1 : 0;
    asks += persisted.asks;
  }
  logger.info({ operation: 'enrichBatch', requested: batch.length, enriched, asks }, 'batch enriched');
  return { requested: batch.length, enriched, asks };
}

/** Persists one validated result, idempotently. Returns whether it was newly inserted + asks added. */
async function persistResult(
  pool: Pool, ownerSub: string, result: EnrichmentResult, item: EnrichBatchItem, tz: string, model: string,
): Promise<{ inserted: boolean; asks: number }> {
  const ins = await pool.query(
    `INSERT INTO ambient_utterance_enrichment
       (segment_id,user_sub,topics,tone,intent,ask_text,commitment_text,model,taxonomy_version)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (segment_id, taxonomy_version) DO NOTHING RETURNING segment_id`,
    [result.segmentId, ownerSub, JSON.stringify(result.topics), result.tone, result.intent,
      result.ask, result.commitment, model, TAXONOMY_VERSION],
  );
  if (ins.rowCount === 0) return { inserted: false, asks: 0 };       // already enriched — no double-count
  if (!item.profileId) return { inserted: true, asks: 0 };            // unattributed: no person rollups
  const asks = await persistAsks(pool, ownerSub, result, item, model);
  await persistRollups(pool, ownerSub, result, item, tz);
  return { inserted: true, asks };
}

/** Inserts ask/commitment ledger rows (dedupe_key keeps re-enrichment from duplicating). */
async function persistAsks(
  pool: Pool, ownerSub: string, result: EnrichmentResult, item: EnrichBatchItem, model: string,
): Promise<number> {
  let added = 0;
  for (const [kind, text] of [['ask', result.ask], ['commitment', result.commitment]] as const) {
    if (!text) continue;
    const dedupeKey = createHash('sha256').update(`${result.segmentId}|${kind}`).digest('hex');
    const r = await pool.query(
      `INSERT INTO ambient_person_asks
         (owner_sub,profile_id,segment_id,kind,text,source_quote,model,is_inference,dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8) ON CONFLICT (owner_sub,dedupe_key) DO NOTHING RETURNING ask_id`,
      [ownerSub, item.profileId, result.segmentId, kind, text, item.text, model, dedupeKey],
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

/** Increments per-person daily topic counts and appends dated topic relations. */
async function persistRollups(
  pool: Pool, ownerSub: string, result: EnrichmentResult, item: EnrichBatchItem, tz: string,
): Promise<void> {
  for (const topic of result.topics) {
    await pool.query(
      `INSERT INTO ambient_person_topic_daily (owner_sub,profile_id,local_date,topic,mention_count)
       VALUES ($1,$2,($3::timestamptz AT TIME ZONE $4)::date,$5,1)
       ON CONFLICT (owner_sub,profile_id,local_date,topic)
       DO UPDATE SET mention_count = ambient_person_topic_daily.mention_count + 1`,
      [ownerSub, item.profileId, item.capturedAt, tz, topic],
    );
    await pool.query(
      `INSERT INTO ambient_person_relations
         (owner_sub,from_ref,to_ref,profile_from_id,rel_type,observed_on,segment_id,weight)
       VALUES ($1,$2,$3,$4,'mentions',($5::timestamptz AT TIME ZONE $6)::date,$7,1)
       ON CONFLICT (owner_sub,from_ref,to_ref,rel_type,observed_on) DO NOTHING`,
      [ownerSub, `person:${item.profileId}`, `topic:${topic}`, item.profileId, item.capturedAt, tz, result.segmentId],
    );
  }
}
