/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase optimizer corpus writer — append one observation per variant replay (ADR-046 step 3/4)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 5: summarizeCorpusSavings — the corpus READ path (was write-only); rolls persisted observations into an estimated-vs-actual SavingsSummary (ADR-046).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | RLS fix: tenant_id is NULLABLE (no 'default') so personal observations match the personal RLS clause and owners can read their own corpus. ensureSchema self-heals older tables (drop NOT NULL/default, backfill 'default'->NULL). This was the real "corpus write-only, zero reads" cause.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 4/4b (ADR-046): additive judge columns (judge_score, judge_dimensions, judge_mode) — the step-4 LLM-judge grade persisted alongside the existing Jaccard `accuracy` (kept as the comparison column). recordOptimizerObservation gains an OPTIONAL assessment param (older callers unchanged); new summarizeJudgedSavings read rolls the judged corpus into the step-4b headline report with llm-judged and lexical-fallback frames kept separate.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: the JUDGE_COLUMNS_SQL ALTERs no longer swallow errors — the INSERT depends on those columns, so a failed ALTER is now logged at ERROR and rethrown (resets schemaReady for retry) instead of failing silently with a confusing "column does not exist" downstream.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2b (ADR-046 §10 debugger view): listRunObservations — the per-run/per-frame corpus READ the debugger's trace inspector renders (recorded replay/variant/grade history side-by-side with the captured baseline). Read-only, owner-scoped by user_sub; re-runs nothing.
 */

import { createChildLogger } from '@/shared/logger';
import type { VariantReplayResult } from './token-chase-optimize-service';
import type { JudgeAssessment } from './token-chase-assessor';
import { aggregateSavingsRows, type SavingsRow, type SavingsSummary } from './token-chase-savings';
import {
  aggregateJudgedSavings,
  DEFAULT_JUDGE_QUALITY_BAR,
  type JudgedSavingsReport,
  type JudgedSavingsRow,
} from './token-chase-judged-savings';

const logger = createChildLogger({ module: 'token-chase-corpus-service' });

/** Minimal pg pool surface — avoids a hard dependency on the pg types here. */
interface QueryablePool {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

// Idempotent schema guard so an observation can be recorded even before migration 033 has run
// (mirrors the ticket-schema bootstrap pattern). Resolved once per process.
let schemaReady: Promise<void> | null = null;

// tenant_id is NULLABLE with no default: the app-wide personal-or-tenant RLS convention treats a NULL
// tenant_id as a PERSONAL row (owner = user_sub). The original NOT NULL DEFAULT 'default' routed every
// personal observation through the tenant-member clause instead, so owners could never read their own
// corpus (write-only). ensureSchema() self-heals older tables (see below).
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS token_chase_optimizer_corpus (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT,
  user_sub           TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  query_type         TEXT,
  harness            TEXT,
  baseline_provider  TEXT,
  baseline_model     TEXT,
  baseline_cost_usd  NUMERIC(12,6),
  variant_provider   TEXT,
  variant_model      TEXT NOT NULL,
  cost_usd           NUMERIC(12,6),
  cost_delta_usd     NUMERIC(12,6),
  latency_ms         INTEGER,
  accuracy           NUMERIC(6,4),
  equivalent         BOOLEAN,
  tier               TEXT,
  complexity         TEXT,
  tools_used         TEXT[],
  status             TEXT,
  judge_score        INTEGER,
  judge_dimensions   JSONB,
  judge_mode         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

// Additive step-4 judge columns for tables created before the assessor shipped (idempotent).
const JUDGE_COLUMNS_SQL = [
  'ALTER TABLE token_chase_optimizer_corpus ADD COLUMN IF NOT EXISTS judge_score INTEGER',
  'ALTER TABLE token_chase_optimizer_corpus ADD COLUMN IF NOT EXISTS judge_dimensions JSONB',
  'ALTER TABLE token_chase_optimizer_corpus ADD COLUMN IF NOT EXISTS judge_mode TEXT',
];

/** @description Ensures the corpus table exists AND that tenant_id follows the personal-or-tenant RLS
 * convention (nullable = personal). Idempotent, run once per process; self-heals tables created before
 * the tenant_id fix (drops the NOT NULL/'default', backfills 'default'→NULL so owners can read their
 * own rows under RLS). All steps are IF-EXISTS/idempotent and safe to re-run. */
function ensureSchema(pool: QueryablePool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(SCHEMA_SQL);
      // Self-heal older tables: personal rows must have a NULL tenant_id to be owner-readable under RLS.
      await pool.query('ALTER TABLE token_chase_optimizer_corpus ALTER COLUMN tenant_id DROP NOT NULL').catch(() => undefined);
      await pool.query('ALTER TABLE token_chase_optimizer_corpus ALTER COLUMN tenant_id DROP DEFAULT').catch(() => undefined);
      await pool.query("UPDATE token_chase_optimizer_corpus SET tenant_id = NULL WHERE tenant_id = 'default'").catch(() => undefined);
      // Step 4: judge grade columns are additive; older tables self-heal here. Unlike the tenant_id
      // heals above (which are optional cleanups), the recordOptimizerObservation INSERT REFERENCES
      // these columns — a swallowed ALTER failure would make every subsequent write fail with a
      // confusing "column judge_score does not exist". Log at ERROR and rethrow so the real cause
      // surfaces and schemaReady resets for a later retry, rather than failing silently.
      for (const sql of JUDGE_COLUMNS_SQL) {
        try {
          await pool.query(sql);
        } catch (err) {
          logger.error({ err, sql }, 'Failed to add Token Chase judge column to corpus table');
          throw err;
        }
      }
    })().catch((err) => {
      schemaReady = null; // allow a later retry
      throw err;
    });
  }
  return schemaReady;
}

/**
 * @description Appends one corpus observation for a graded variant replay. Best-effort: a write failure
 * is logged, never thrown, so persistence can never break the optimizer response. Only graded results
 * (a real baseline-vs-variant comparison) are recorded; excluded/errored replays are skipped by the caller.
 * @param pool - The app DB pool.
 * @param userSub - Owner of the observation (scopes the corpus per user).
 * @param r - The graded variant replay result.
 * @param assessment - Optional step-4 judge assessment for the same frame; when present its
 *   score/dimensions/mode persist in the additive judge columns (the Jaccard `accuracy` column
 *   stays as the lexical comparison). Older callers that omit it are unchanged (columns = NULL).
 */
export async function recordOptimizerObservation(
  pool: QueryablePool,
  userSub: string,
  r: VariantReplayResult,
  assessment?: JudgeAssessment | null,
): Promise<void> {
  if (!r.variant || !r.diff) return; // nothing graded to learn from
  try {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO token_chase_optimizer_corpus
         (user_sub, run_id, seq, query_type, harness, baseline_provider, baseline_model,
          baseline_cost_usd, variant_provider, variant_model, cost_usd, cost_delta_usd,
          latency_ms, accuracy, equivalent, tier, complexity, tools_used, status,
          judge_score, judge_dimensions, judge_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        userSub, r.runId, r.seq, r.meta.queryType, r.meta.harness,
        r.baseline?.provider ?? null, r.baseline?.model ?? null, r.baseline?.costUsd ?? null,
        r.variant.provider, r.variant.model, r.variant.costUsd, r.diff.costDeltaUsd,
        r.variant.latencyMs, r.diff.accuracy, r.diff.equivalent, r.tier,
        r.meta.complexity, r.meta.tools, r.status,
        assessment?.judgeScore ?? null,
        assessment ? JSON.stringify(assessment.dimensions) : null,
        assessment?.mode ?? null,
      ],
    );
    logger.info(
      { runId: r.runId, seq: r.seq, model: r.variant.model, tier: r.tier, judgeScore: assessment?.judgeScore ?? null, judgeMode: assessment?.mode ?? null },
      'Optimizer observation recorded',
    );
  } catch (err) {
    logger.warn({ err, runId: r.runId, seq: r.seq }, 'Failed to record optimizer observation (non-fatal)');
  }
}

/** One corpus row shape (only the cost/tier columns the savings roll-up needs). */
interface CorpusCostRow {
  baseline_cost_usd: string | number | null;
  cost_usd: string | number | null;
  tier: string | null;
  equivalent: boolean | null;
}

/**
 * @description Read the caller's persisted optimizer observations and roll them into an
 * estimated-vs-actual SavingsSummary (the corpus READ path — previously write-only). Scoped to the
 * caller's user_sub; optionally narrowed to one run. Realizable savings come only from the zero-risk
 * equivalent-cheaper swaps (see aggregateSavingsRows).
 * @param pool - the app DB pool
 * @param userSub - owner of the observations (scopes the read)
 * @param runId - optional run to narrow to; omit for the caller's whole corpus
 * @returns the savings roll-up (all-zero when the caller has no observations yet)
 */
export async function summarizeCorpusSavings(
  pool: QueryablePool,
  userSub: string,
  runId?: string,
): Promise<SavingsSummary> {
  await ensureSchema(pool);
  const params: unknown[] = [userSub];
  let where = 'user_sub = $1';
  if (runId) {
    params.push(runId);
    where += ' AND run_id = $2';
  }
  const result = (await pool.query(
    `SELECT baseline_cost_usd, cost_usd, tier, equivalent
       FROM token_chase_optimizer_corpus
      WHERE ${where}`,
    params,
  )) as { rows: CorpusCostRow[] };
  const rows: SavingsRow[] = (result.rows ?? []).map((r) => ({
    baselineCostUsd: r.baseline_cost_usd == null ? null : Number(r.baseline_cost_usd),
    variantCostUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    tier: r.tier,
    equivalent: r.equivalent,
  }));
  return aggregateSavingsRows(rows, runId ? 'run' : 'all', runId);
}

/** One raw corpus row shape for the debugger read (all recorded per-observation fields). */
interface CorpusDebuggerRow {
  seq: number | string;
  created_at: string | Date | null;
  baseline_provider: string | null;
  baseline_model: string | null;
  baseline_cost_usd: string | number | null;
  variant_provider: string | null;
  variant_model: string | null;
  cost_usd: string | number | null;
  cost_delta_usd: string | number | null;
  latency_ms: number | string | null;
  accuracy: string | number | null;
  equivalent: boolean | null;
  tier: string | null;
  status: string | null;
  query_type: string | null;
  harness: string | null;
  judge_score: string | number | null;
  judge_mode: string | null;
}

/**
 * @description One persisted optimizer observation as the step-2b debugger renders it: the recorded
 * outcome of one replay/variant on one captured frame — lane identity, cost pair + delta, latency,
 * lexical accuracy, tier verdict, and the step-4 judge grade. Metrics only: variant response TEXT is
 * not persisted in the corpus, so the debugger shows the recorded evidence and links to the existing
 * replay actions to re-fire a lane live.
 */
export interface DebuggerObservation {
  seq: number;
  createdAt: string | null;
  baselineProvider: string | null;
  baselineModel: string | null;
  baselineCostUsd: number | null;
  variantProvider: string | null;
  variantModel: string | null;
  variantCostUsd: number | null;
  costDeltaUsd: number | null;
  latencyMs: number | null;
  accuracy: number | null;
  equivalent: boolean | null;
  tier: string | null;
  status: string | null;
  queryType: string | null;
  harness: string | null;
  judgeScore: number | null;
  judgeMode: 'llm' | 'lexical-fallback' | null;
}

/**
 * @description Reads the caller's persisted replay/variant/grade observations for one captured run
 * (optionally narrowed to one frame) — the step-2b debugger's trace read (ADR-046 §10). READ-ONLY:
 * it renders what past optimizer actions already recorded and never fires a replay itself. Scoped to
 * the caller's own user_sub, mirroring the savings reads.
 * @param pool - The app DB pool.
 * @param userSub - Owner of the observations (scopes the read).
 * @param runId - The captured run (task workspace) id.
 * @param seq - Optional frame sequence to narrow to; omit for the whole run.
 * @returns Observations ordered by frame sequence then recording time (empty when none recorded).
 */
export async function listRunObservations(
  pool: QueryablePool,
  userSub: string,
  runId: string,
  seq?: number,
): Promise<DebuggerObservation[]> {
  await ensureSchema(pool);
  const params: unknown[] = [userSub, runId];
  let where = 'user_sub = $1 AND run_id = $2';
  if (typeof seq === 'number' && Number.isInteger(seq)) {
    params.push(seq);
    where += ' AND seq = $3';
  }
  const result = (await pool.query(
    `SELECT seq, created_at, baseline_provider, baseline_model, baseline_cost_usd,
            variant_provider, variant_model, cost_usd, cost_delta_usd, latency_ms,
            accuracy, equivalent, tier, status, query_type, harness, judge_score, judge_mode
       FROM token_chase_optimizer_corpus
      WHERE ${where}
      ORDER BY seq ASC, created_at ASC`,
    params,
  )) as { rows: CorpusDebuggerRow[] };
  return (result.rows ?? []).map((r) => ({
    seq: Number(r.seq),
    createdAt: toIso(r.created_at),
    baselineProvider: r.baseline_provider,
    baselineModel: r.baseline_model,
    baselineCostUsd: toNum(r.baseline_cost_usd),
    variantProvider: r.variant_provider,
    variantModel: r.variant_model,
    variantCostUsd: toNum(r.cost_usd),
    costDeltaUsd: toNum(r.cost_delta_usd),
    latencyMs: toNum(r.latency_ms),
    accuracy: toNum(r.accuracy),
    equivalent: r.equivalent,
    tier: r.tier,
    status: r.status,
    queryType: r.query_type,
    harness: r.harness,
    judgeScore: toNum(r.judge_score),
    judgeMode: r.judge_mode === 'llm' || r.judge_mode === 'lexical-fallback' ? r.judge_mode : null,
  }));
}

/** One corpus row shape for the judged report (cost pair + lane identity + judge grade). */
interface CorpusJudgedRow {
  baseline_cost_usd: string | number | null;
  cost_usd: string | number | null;
  variant_provider: string | null;
  variant_model: string | null;
  judge_score: string | number | null;
  judge_mode: string | null;
}

/** Coerce a NUMERIC/text DB value into a finite number or null. */
function toNum(v: string | number | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a TIMESTAMPTZ DB value (Date or text) into an ISO string, or null when absent/invalid. */
function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @description Read the caller's judged optimizer observations into the step-4b headline report
 * (ADR-046 §12): per provider/model lane baseline vs variant $, $ and % saved, and how many
 * frames held the quality bar — with llm-judged and lexical-fallback frames kept in SEPARATE
 * buckets (the honesty rule). Reads the corpus; re-runs nothing. Scoped to the caller's user_sub.
 * @param pool - The app DB pool.
 * @param userSub - Owner of the observations (scopes the read).
 * @param runId - Optional run to narrow to; omit for the caller's whole corpus.
 * @param threshold - The quality bar (judgeScore >= threshold counts as held); defaults to
 *   env TOKEN_CHASE_JUDGE_BAR, then DEFAULT_JUDGE_QUALITY_BAR (80).
 * @returns The judged savings report (all-zero when the caller has no observations yet).
 */
export async function summarizeJudgedSavings(
  pool: QueryablePool,
  userSub: string,
  runId?: string,
  threshold?: number,
): Promise<JudgedSavingsReport> {
  await ensureSchema(pool);
  const envBar = Number(process.env.TOKEN_CHASE_JUDGE_BAR);
  const bar = typeof threshold === 'number' && Number.isFinite(threshold)
    ? threshold
    : (Number.isFinite(envBar) ? envBar : DEFAULT_JUDGE_QUALITY_BAR);
  const params: unknown[] = [userSub];
  let where = 'user_sub = $1';
  if (runId) {
    params.push(runId);
    where += ' AND run_id = $2';
  }
  const result = (await pool.query(
    `SELECT baseline_cost_usd, cost_usd, variant_provider, variant_model, judge_score, judge_mode
       FROM token_chase_optimizer_corpus
      WHERE ${where}`,
    params,
  )) as { rows: CorpusJudgedRow[] };
  const rows: JudgedSavingsRow[] = (result.rows ?? []).map((r) => ({
    baselineCostUsd: toNum(r.baseline_cost_usd),
    variantCostUsd: toNum(r.cost_usd),
    provider: r.variant_provider,
    model: r.variant_model,
    judgeScore: toNum(r.judge_score),
    judgeMode: r.judge_mode === 'llm' || r.judge_mode === 'lexical-fallback' ? r.judge_mode : null,
  }));
  return aggregateJudgedSavings(rows, bar, runId ? 'run' : 'all', runId);
}
