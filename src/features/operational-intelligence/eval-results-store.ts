/**
 * Eval results store — durable record of every AI Test Lab / golden eval run, plus the
 * "green wall" rollup the eval-wall surface renders (ADR-063 §eval-wall).
 *
 * Each nightly/manual golden run is persisted to the idempotent `eval_runs` table so the
 * wall is not just "0/1 passed today" — it is a history we can compute a real success rate,
 * cost, latency, retry, quality and posture summary over. Honest-by-default: any field the
 * runner could not measure is stored NULL and surfaced as null (never a fabricated number).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — eval_runs schema +
 *            | recordEvalRun / queryEvalRuns / computeGreenWall for the green-wall surface.
 * ---------------------------------------------------------------------------
 * @module operational-intelligence/eval-results-store
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'eval-results-store' });

/** A single eval run. Numeric telemetry fields are nullable when unmeasured (no inflation). */
export interface EvalRun {
  id?: string;
  runAt?: string;                 // ISO; defaults to NOW() when omitted
  scenario: string;
  state: 'pass' | 'degraded' | 'gap' | 'fail';
  heuristicScore: number | null;
  judgeScore: number | null;
  finalScore: number | null;
  passed: boolean;
  latencyMs: number | null;
  retries: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  securityFindings: number | null;
  notes?: string | null;
}

/** Query filter for recent runs. */
export interface EvalRunQuery {
  since?: string;   // ISO timestamp lower bound (inclusive)
  limit?: number;   // max rows (default 100)
}

/** The green-wall rollup. Averages are null when no underlying run reported that field. */
export interface GreenWall {
  totalRuns: number;
  successRate: number | null;     // 0..1 over runs (passed / total); null when no runs
  avgLatencyMs: number | null;
  avgRetries: number | null;
  totalCostUsd: number | null;
  avgQuality: number | null;      // mean of finalScore across runs that reported one
  postureSummary: {
    totalSecurityFindings: number | null;
    runsWithFindings: number;
    clean: boolean;               // true when no run reported any security finding
  };
}

/** One day's rollup for the success-rate trend sparkline. */
export interface TrendPoint {
  date: string;                   // YYYY-MM-DD (UTC)
  total: number;
  passed: number;
  successRate: number;            // passed / total for that day (0..1)
  avgQuality: number | null;      // mean finalScore that day, or null when none reported
}

let schemaReady = false;

/**
 * Ensure the idempotent eval_runs table exists. Safe to call repeatedly; matches the
 * project's "CREATE TABLE IF NOT EXISTS inline at first use" convention.
 */
export async function ensureEvalRunsSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scenario TEXT NOT NULL,
      state VARCHAR(16) NOT NULL DEFAULT 'fail',
      heuristic_score INT,
      judge_score INT,
      final_score INT,
      passed BOOLEAN NOT NULL DEFAULT FALSE,
      latency_ms INT,
      retries INT,
      input_tokens INT,
      output_tokens INT,
      cost_usd DOUBLE PRECISION,
      security_findings INT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_run_at ON eval_runs (run_at DESC);
  `);
  schemaReady = true;
}

/** Coerce a value to a finite number or null (never NaN / undefined sneaking into SQL). */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Persist one eval run. Ensures the schema first; unmeasured numeric fields are stored NULL.
 * @returns the inserted row id.
 */
export async function recordEvalRun(pool: Pool, run: EvalRun): Promise<string | null> {
  await ensureEvalRunsSchema(pool);
  try {
    const res = await pool.query(
      `INSERT INTO eval_runs
         (run_at, scenario, state, heuristic_score, judge_score, final_score, passed,
          latency_ms, retries, input_tokens, output_tokens, cost_usd, security_findings, notes)
       VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        run.runAt ?? null,
        run.scenario,
        run.state,
        numOrNull(run.heuristicScore),
        numOrNull(run.judgeScore),
        numOrNull(run.finalScore),
        Boolean(run.passed),
        numOrNull(run.latencyMs),
        numOrNull(run.retries),
        numOrNull(run.inputTokens),
        numOrNull(run.outputTokens),
        numOrNull(run.costUsd),
        numOrNull(run.securityFindings),
        run.notes ?? null,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err, scenario: run.scenario }, 'recordEvalRun failed');
    return null;
  }
}

/** Map a DB row (snake_case) to an EvalRun (camelCase), preserving nulls. */
function rowToRun(r: Record<string, unknown>): EvalRun {
  return {
    id: r.id as string,
    runAt: r.run_at instanceof Date ? (r.run_at as Date).toISOString() : (r.run_at as string),
    scenario: r.scenario as string,
    state: r.state as EvalRun['state'],
    heuristicScore: numOrNull(r.heuristic_score),
    judgeScore: numOrNull(r.judge_score),
    finalScore: numOrNull(r.final_score),
    passed: Boolean(r.passed),
    latencyMs: numOrNull(r.latency_ms),
    retries: numOrNull(r.retries),
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    costUsd: numOrNull(r.cost_usd),
    securityFindings: numOrNull(r.security_findings),
    notes: (r.notes as string | null) ?? null,
  };
}

/** Read recent eval runs (newest first), optionally bounded by a `since` timestamp. */
export async function queryEvalRuns(pool: Pool, q: EvalRunQuery = {}): Promise<EvalRun[]> {
  await ensureEvalRunsSchema(pool);
  const limit = Math.max(1, Math.min(1000, q.limit ?? 100));
  const params: unknown[] = [];
  let where = '';
  if (q.since) { params.push(q.since); where = `WHERE run_at >= $1::timestamptz`; }
  params.push(limit);
  const sql = `SELECT * FROM eval_runs ${where} ORDER BY run_at DESC LIMIT $${params.length}`;
  try {
    const res = await pool.query(sql, params);
    return res.rows.map(rowToRun);
  } catch (err) {
    logger.warn({ err }, 'queryEvalRuns failed');
    return [];
  }
}

/** Mean of the finite values in a list, or null when none are present. */
function avgOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** Sum of finite values, or null when NONE were reported (vs. a real 0). */
function sumOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0);
}

/**
 * Bucket runs into a per-day success-rate trend (oldest→newest), for the wall's sparkline. Pure
 * function (no DB) so it is trivially unit-testable. Days with no runs are simply absent (the
 * sparkline connects the days that have data rather than inventing zero-run points).
 */
export function computeEvalTrend(runs: EvalRun[]): TrendPoint[] {
  const byDay = new Map<string, EvalRun[]>();
  for (const r of runs) {
    const date = (r.runAt ?? '').slice(0, 10); // ISO → YYYY-MM-DD
    if (!date) continue;
    const bucket = byDay.get(date);
    if (bucket) bucket.push(r); else byDay.set(date, [r]);
  }
  return [...byDay.keys()].sort().map((date) => {
    const rs = byDay.get(date)!;
    const passed = rs.filter((r) => r.passed).length;
    return { date, total: rs.length, passed, successRate: rs.length ? passed / rs.length : 0, avgQuality: avgOrNull(rs.map((r) => r.finalScore)) };
  });
}

/**
 * Compute the green-wall rollup over a set of runs. Pure function (no DB) so it is trivially
 * unit-testable. Honest nulls: an average/sum is null when no run reported that field, rather
 * than a fabricated 0. successRate is null only when there are zero runs.
 */
export function computeGreenWall(runs: EvalRun[]): GreenWall {
  const totalRuns = runs.length;
  if (totalRuns === 0) {
    return {
      totalRuns: 0,
      successRate: null,
      avgLatencyMs: null,
      avgRetries: null,
      totalCostUsd: null,
      avgQuality: null,
      postureSummary: { totalSecurityFindings: null, runsWithFindings: 0, clean: true },
    };
  }

  const passedCount = runs.filter((r) => r.passed).length;
  const securityValues = runs.map((r) => r.securityFindings);
  const totalSecurityFindings = sumOrNull(securityValues);
  const runsWithFindings = runs.filter((r) => (r.securityFindings ?? 0) > 0).length;

  return {
    totalRuns,
    successRate: passedCount / totalRuns,
    avgLatencyMs: avgOrNull(runs.map((r) => r.latencyMs)),
    avgRetries: avgOrNull(runs.map((r) => r.retries)),
    totalCostUsd: sumOrNull(runs.map((r) => r.costUsd)),
    avgQuality: avgOrNull(runs.map((r) => r.finalScore)),
    postureSummary: {
      totalSecurityFindings,
      runsWithFindings,
      // "clean" only when at least one run reported a finding count AND all were zero,
      // OR no findings reported at all. runsWithFindings>0 is the only non-clean case.
      clean: runsWithFindings === 0,
    },
  };
}
