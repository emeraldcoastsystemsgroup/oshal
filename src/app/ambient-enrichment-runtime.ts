/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: micro-batch ambient enrichment runtime. OFF by default (OSHAL_AMBIENT_ENRICH); when on, sweeps unenriched, consent-eligible, attributed segments per owner and hands one bounded batch to the ambient-analyst concierge via executeBotOrInline (ADR-036 — cost lands in chat_tasks under the analyst's agentId; the controller never calls an LLM). The nightly rollup/retention pass is a separate future step.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ran the enrichment sweep + person-model maintenance under runWithSystemIdentity — cross-owner background work over the FORCE-RLS ambient and person-model tables + chat_tasks; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 */

import type { Pool } from 'pg';
import type { AppContext } from '@/app/composition/app-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import {
  eligibleProfileIds, enrichBatch, purgeExpiredPersonModelData, TAXONOMY_VERSION, type EnrichBatchItem,
} from '@/features/person-model';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';

const logger = createChildLogger({ module: 'ambient-enrichment-runtime' });
/** The ambient-analyst concierge agent id — MUST match both registries + ai-lab/bot-personas/ambient-analyst.yaml. */
export const AMBIENT_ANALYST_AGENT_ID = 'a0000000-0000-0000-0000-000000000055';
const DEFAULT_SWEEP_MS = 300_000;      // 5 min, ADR-100 §3
const BATCH_SIZE = 50;                  // utterances per owner per sweep (one LLM call)
const MAX_OWNERS_PER_SWEEP = 5;
const MAINTENANCE_MS = 86_400_000;     // daily retention purge
const started = new WeakSet<object>();
const maintenanceStarted = new WeakSet<object>();

/**
 * @description Starts the daily person-model retention purge. Unlike enrichment this is ALWAYS on
 * (pure SQL, no LLM, controller-permitted) so aggregate rollups stay bounded to each owner's
 * transcript retention even if enrichment was enabled then later turned off.
 * @param pool - Shared GUC-aware pool.
 * @returns Void after the singleton scheduler is registered.
 */
export function startPersonModelMaintenanceRuntime(pool: Pool): void {
  if (maintenanceStarted.has(pool)) return;
  maintenanceStarted.add(pool);
  const tick = () => void runWithSystemIdentity(() => purgeExpiredPersonModelData(pool)).catch((error: unknown) => {
    logger.error({ err: error, operation: 'purgeExpiredPersonModelData' }, 'person-model maintenance failed');
  });
  const timer = setInterval(tick, MAINTENANCE_MS);
  timer.unref();
  registerShutdownHook('person-model-maintenance', () => clearInterval(timer));
  logger.info({ operation: 'startPersonModelMaintenanceRuntime' }, 'person-model maintenance runtime started');
}

/** Whether enrichment is enabled. Default OFF — the whole inference layer is inert until switched on. */
export function ambientEnrichmentEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.OSHAL_AMBIENT_ENRICH ?? '').trim().toLowerCase());
}

/**
 * @description Starts the singleton enrichment sweeper for this process. No-op when disabled, so
 * importing/wiring it is always safe. Each sweep enriches a few owners' pending batches through the
 * accountable analyst bot; failures are logged and retried next interval (segments stay unenriched).
 * @param ctx - App context (pool + inline orchestrator, for the accountable bot call).
 * @returns Void after the scheduler is registered (or immediately if disabled).
 */
export function startAmbientEnrichmentRuntime(ctx: AppContext): void {
  if (!ambientEnrichmentEnabled()) {
    logger.info({ operation: 'startAmbientEnrichmentRuntime', enabled: false }, 'ambient enrichment disabled (OSHAL_AMBIENT_ENRICH)');
    return;
  }
  if (started.has(ctx.pool)) return;
  started.add(ctx.pool);
  const botClient = new BotNodeClient(createRegistryEndpointResolver());
  const sweep = () => void runWithSystemIdentity(() => runEnrichmentSweep(ctx, botClient)).catch((error: unknown) => {
    logger.error({ err: error, operation: 'runEnrichmentSweep' }, 'ambient enrichment sweep failed');
  });
  const timer = setInterval(sweep, readSweepInterval());
  timer.unref();
  registerShutdownHook('ambient-enrichment', () => clearInterval(timer));
  logger.info({ operation: 'startAmbientEnrichmentRuntime', enabled: true }, 'ambient enrichment runtime started');
}

/**
 * @description Runs one sweep across up to MAX_OWNERS_PER_SWEEP owners with pending attributed work.
 * @param ctx - App context.
 * @param botClient - Bot-node client for the analyst call.
 * @returns Counts of owners swept and utterances enriched.
 */
export async function runEnrichmentSweep(ctx: AppContext, botClient: BotNodeClient): Promise<{ owners: number; enriched: number }> {
  const { rows } = await ctx.pool.query(
    `SELECT DISTINCT s.user_sub FROM ambient_transcript_segments s
       JOIN ambient_user_settings u ON u.user_sub = s.user_sub
       LEFT JOIN ambient_utterance_enrichment e ON e.segment_id = s.segment_id AND e.taxonomy_version = $1
      WHERE u.ambient_enabled = TRUE AND s.speaker_profile_id IS NOT NULL AND e.segment_id IS NULL
      LIMIT $2`,
    [TAXONOMY_VERSION, MAX_OWNERS_PER_SWEEP],
  );
  let enriched = 0;
  for (const row of rows) {
    try {
      const outcome = await enrichOwner(ctx, botClient, String(row.user_sub));
      enriched += outcome;
    } catch (error) {
      logger.error({ err: error, operation: 'enrichOwner' }, 'owner enrichment failed');
    }
  }
  if (enriched > 0) logger.info({ owners: rows.length, enriched }, 'ambient enrichment sweep complete');
  return { owners: rows.length, enriched };
}

/** Enriches one bounded, consent-eligible batch for a single owner. */
async function enrichOwner(ctx: AppContext, botClient: BotNodeClient, ownerSub: string): Promise<number> {
  const eligible = await eligibleProfileIds(ctx.pool, ownerSub);
  if (eligible.size === 0) return 0;
  const { rows } = await ctx.pool.query(
    `SELECT s.segment_id, s.transcript_text, s.captured_at, s.speaker_profile_id::text AS profile_id, u.time_zone
       FROM ambient_transcript_segments s
       JOIN ambient_user_settings u ON u.user_sub = s.user_sub
       LEFT JOIN ambient_utterance_enrichment e ON e.segment_id = s.segment_id AND e.taxonomy_version = $2
      WHERE s.user_sub = $1 AND s.speaker_profile_id IS NOT NULL AND e.segment_id IS NULL
        AND s.speaker_profile_id = ANY($3::uuid[])
      ORDER BY s.captured_at LIMIT $4`,
    [ownerSub, TAXONOMY_VERSION, [...eligible], BATCH_SIZE],
  );
  if (rows.length === 0) return 0;
  const timeZone = String(rows[0].time_zone || 'UTC');
  const batch: EnrichBatchItem[] = rows.map((r) => ({
    segmentId: String(r.segment_id), text: String(r.transcript_text), speakerLabel: null,
    profileId: String(r.profile_id), capturedAt: new Date(r.captured_at).toISOString(),
  }));
  const invoke = (taskId: string, prompt: string): Promise<string> =>
    executeBotOrInline(ctx, botClient, AMBIENT_ANALYST_AGENT_ID, {
      text: prompt, taskId, workspaceFolderId: taskId, agentId: AMBIENT_ANALYST_AGENT_ID,
      agenticMode: true, direct: true, userSub: ownerSub,
    }).then((r) => String(r.response || ''));
  const outcome = await enrichBatch(ctx.pool, ownerSub, batch, invoke, { timeZone, model: 'ambient-analyst' });
  return outcome.enriched;
}

/** Reads the sweep interval env, clamped to [1 min, 24 h]. */
function readSweepInterval(): number {
  const configured = Number(process.env.AMBIENT_ENRICH_SWEEP_MS ?? DEFAULT_SWEEP_MS);
  if (!Number.isFinite(configured)) return DEFAULT_SWEEP_MS;
  return Math.min(86_400_000, Math.max(60_000, Math.floor(configured)));
}
