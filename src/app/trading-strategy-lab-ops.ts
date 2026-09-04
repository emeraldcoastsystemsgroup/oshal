/**
 * Strategy Lab operations (ADR-092) — the verbs shared by the /api/trading/lab routes, the
 * nightly `trading-lab:<sub>` scheduler leg, and scripts/trading-regression-suite.ts:
 * backtest-and-persist, daily forward step, and the fixed-window regression diff.
 *
 * Regression contract: a strategy pins a BASELINE run; a regression re-runs the same config over
 * the baseline's exact window (start end-date pinned) on the same feed. The sim is deterministic
 * and the window immutable, so metric drift beyond tolerance means the ENGINE changed behavior —
 * the resample-bug class (cad41dc5) caught nightly instead of by the next human re-run. Small
 * tolerance absorbs `adjustment=all` restatements (a split/dividend re-adjusts history).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — backtestStrategy (persist + auto-pin baseline), forwardStepStrategy (resume-or-init + persist points), regressStrategy (pinned-window rerun + drift verdict), and the run-all wrappers the leg/CLI consume.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Blend support (ADR-095 round 2): run snapshots go through snapshotConfig so a blend's per-component universes pin for deterministic regressions. Backtest/forward/regression paths themselves branch inside the sim — no verb changes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | buildSha: execSync -> async spawn warmed once at module load (the api event loop must never block on a subprocess — the 07-15 spawnSync wedge class; this was the last sync exec in the api's app tier). Same sync signature + env fallback; provenance value unchanged once the probe settles (milliseconds after boot, long before any run persists).
 *
 * @module trading-strategy-lab-ops
 */

import { spawn } from 'child_process';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  forwardStep, metricsFor, normalizeConfig, runBacktest, snapshotConfig, LAB_START_CASH,
  type EquityPoint, type WalkState,
} from './trading-strategy-lab-sim';
import {
  ensureLabSchema, getForwardState, getRun, getStrategy, insertRun, listStrategies,
  saveForwardState, setBaseline,
  type RunRow, type StrategyRow,
} from './trading-strategy-lab-store';

const logger = createChildLogger({ module: 'trading-strategy-lab-ops' });

/** Drift tolerances — absorb adjustment=all restatements, catch engine-behavior change. */
const DRIFT_RETURN_PTS = 0.5;
const DRIFT_MAXDD_PTS = 0.5;
const DRIFT_TRADES_MIN = 3;

let cachedSha: string | null = null;
/** Env-provided sha fallback (archive-built images carry no .git). */
const shaFallback = (): string => String(process.env.BUILD_SHA || process.env.GIT_SHA || '');
// Warm the provenance sha ASYNC once at module load (was a first-call execSync — sync child
// processes on the api event loop are the 07-15 wedge class, however brief). The probe settles
// milliseconds after boot; until then buildSha() serves the env fallback, exactly what the old
// catch path returned where git was unavailable.
(() => {
  try {
    const proc = spawn('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    let out = '';
    proc.stdout?.on('data', (d) => { out += String(d); });
    proc.on('close', (code) => { cachedSha = code === 0 && out.trim() ? out.trim() : shaFallback(); });
    proc.on('error', () => { cachedSha = shaFallback(); });
  } catch { cachedSha = shaFallback(); }
})();
/** @description The build's git SHA for run provenance ('' when unavailable, e.g. archive-built images). */
export function buildSha(): string {
  return cachedSha !== null ? cachedSha : shaFallback();
}

/**
 * @description Runs a strategy's backtest, persists the run (curve + metrics), and pins it as
 * the regression baseline when the strategy has none.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param strategy - The strategy row.
 * @param windowDays - Optional window override.
 * @param startCash - Optional starting capital (size the walk to a real account); default $100K reference.
 * @returns The persisted run row.
 */
export async function backtestStrategy(pool: Pool, sub: string, strategy: StrategyRow, windowDays?: number, startCash?: number): Promise<RunRow> {
  await ensureLabSchema(pool);
  const cfg = normalizeConfig(strategy.config);
  const started = Date.now();
  try {
    const sim = await runBacktest(cfg, { windowDays, startCash });
    // Snapshot the RESOLVED universe: an empty config universe means "the default", but
    // DEFAULT_UNIVERSE changes between deploys — a regression must replay the names this run saw.
    // For blends the resolution happens per component (snapshotConfig).
    const snapshot = snapshotConfig(cfg);
    const run = await insertRun(pool, sub, {
      strategyId: strategy.id, kind: 'backtest', status: 'ok', feed: sim.feed, gitSha: buildSha(),
      windowStart: sim.windowStart, windowEnd: sim.windowEnd, bars: sim.bars,
      configSnapshot: snapshot, metrics: { ...sim.metrics, startCash: sim.startCash ?? LAB_START_CASH, fetchStart: sim.fetchStart, elapsedMs: Date.now() - started }, curve: sim.curve,
    });
    // Only a REFERENCE-capital run may become the regression baseline: regressions replay at the
    // baseline's capital, and a $20K account-sized run must not silently become the yardstick for
    // a strategy the nightly walks measure at $100K.
    if (!strategy.baselineRunId && (sim.startCash ?? LAB_START_CASH) === LAB_START_CASH) await setBaseline(pool, sub, strategy.id, run.id);
    logger.info({ strategyId: strategy.id, runId: run.id, bars: sim.bars, feed: sim.feed, elapsedMs: Date.now() - started }, 'lab backtest persisted');
    return run;
  } catch (err) {
    const error = (err as Error).message;
    logger.error({ err, strategyId: strategy.id }, 'lab backtest failed');
    return insertRun(pool, sub, {
      strategyId: strategy.id, kind: 'backtest', status: 'failed', feed: 'sip', gitSha: buildSha(),
      windowStart: null, windowEnd: null, bars: 0, configSnapshot: cfg, metrics: {}, curve: [], error,
    });
  }
}

/**
 * @description Advances a strategy's forward walk to the newest session. First call initializes
 * the book with a short warmup backtest ending today so the forward curve starts from a real,
 * decided book (not an empty one) — every subsequent call is pure out-of-sample.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param strategy - The strategy row.
 * @returns Count of new sessions applied and the latest point (null when up to date).
 */
export async function forwardStepStrategy(pool: Pool, sub: string, strategy: StrategyRow): Promise<{ applied: number; last: EquityPoint | null }> {
  await ensureLabSchema(pool);
  const cfg = normalizeConfig(strategy.config);
  const existing = await getForwardState(pool, sub, strategy.id);
  if (!existing) {
    // Initialize: walk a short window up to today, persist the END state as the forward anchor.
    // The walked segment is recorded as the strategy's init run, NOT as forward points — forward
    // points only ever contain sessions decided after the state existed (honest out-of-sample).
    const sim = await runBacktest(cfg, { windowDays: Math.max(400, cfg.warmupDays * 4) });
    await saveForwardState(pool, sub, strategy.id, sim.state, []);
    await insertRun(pool, sub, {
      strategyId: strategy.id, kind: 'forward', status: 'ok', feed: sim.feed, gitSha: buildSha(),
      windowStart: sim.windowStart, windowEnd: sim.windowEnd, bars: sim.bars,
      configSnapshot: cfg, metrics: { ...sim.metrics, note: 'forward-walk initialization (in-sample); out-of-sample points accrue from here' }, curve: [],
    });
    logger.info({ strategyId: strategy.id, asOf: sim.state.lastDate }, 'forward walk initialized');
    return { applied: 0, last: null };
  }
  const { points, state, feed } = await forwardStep(cfg, existing.state as WalkState);
  if (!points.length) return { applied: 0, last: existing.points.length ? existing.points[existing.points.length - 1] : null };
  await saveForwardState(pool, sub, strategy.id, state, points);
  const all = existing.points.concat(points);
  await insertRun(pool, sub, {
    strategyId: strategy.id, kind: 'forward', status: 'ok', feed, gitSha: buildSha(),
    windowStart: all[0]?.d ?? null, windowEnd: state.lastDate, bars: all.length,
    configSnapshot: cfg, metrics: { ...metricsFor(all, state), appliedSessions: points.length }, curve: points,
  });
  logger.info({ strategyId: strategy.id, applied: points.length, asOf: state.lastDate }, 'forward walk advanced');
  return { applied: points.length, last: points[points.length - 1] };
}

/** The verdict a regression run produces. */
export interface RegressionVerdict {
  strategyId: string;
  strategyName: string;
  status: 'ok' | 'drifted' | 'failed' | 'no-baseline';
  runId?: string;
  deltas?: { totalReturnPct: number; maxDrawdownPct: number; trades: number };
  error?: string;
}

/**
 * @description Re-runs a strategy's config over its pinned baseline window and diffs the metrics.
 * Persists the regression run with the drift verdict in its metrics.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param strategy - The strategy row (needs baselineRunId).
 * @returns The verdict (status 'drifted' means the engine's behavior changed for this config).
 */
export async function regressStrategy(pool: Pool, sub: string, strategy: StrategyRow): Promise<RegressionVerdict> {
  await ensureLabSchema(pool);
  if (!strategy.baselineRunId) return { strategyId: strategy.id, strategyName: strategy.name, status: 'no-baseline' };
  const baseline = await getRun(pool, sub, strategy.baselineRunId);
  if (!baseline || !baseline.windowStart || !baseline.windowEnd) return { strategyId: strategy.id, strategyName: strategy.name, status: 'no-baseline' };
  const cfg = normalizeConfig(baseline.configSnapshot);
  try {
    // Pin the exact window the baseline saw: same fetch start (decision windows depend on it),
    // same end session. Same config + same window + immutable tape ⇒ identical numbers.
    const fetchStartDate = typeof baseline.metrics.fetchStart === 'string' ? baseline.metrics.fetchStart : baseline.windowStart;
    // Replay at the baseline's own capital (older baselines recorded none → the $100K reference).
    const sim = await runBacktest(cfg, { fetchStartDate, endDate: baseline.windowEnd, startCash: (baseline.metrics as { startCash?: number }).startCash });
    const deltas = {
      totalReturnPct: round2(sim.metrics.totalReturnPct - Number(baseline.metrics.totalReturnPct ?? 0)),
      maxDrawdownPct: round2(sim.metrics.maxDrawdownPct - Number(baseline.metrics.maxDrawdownPct ?? 0)),
      trades: sim.metrics.trades - Number(baseline.metrics.trades ?? 0),
    };
    const drifted = Math.abs(deltas.totalReturnPct) > DRIFT_RETURN_PTS
      || Math.abs(deltas.maxDrawdownPct) > DRIFT_MAXDD_PTS
      || Math.abs(deltas.trades) > Math.max(DRIFT_TRADES_MIN, Math.round(Number(baseline.metrics.trades ?? 0) * 0.02));
    const run = await insertRun(pool, sub, {
      strategyId: strategy.id, kind: 'regression', status: drifted ? 'drifted' : 'ok', feed: sim.feed, gitSha: buildSha(),
      windowStart: sim.windowStart, windowEnd: sim.windowEnd, bars: sim.bars, configSnapshot: cfg,
      metrics: { ...sim.metrics, baselineRunId: baseline.id, deltas, tolerance: { returnPts: DRIFT_RETURN_PTS, maxDdPts: DRIFT_MAXDD_PTS, tradesMin: DRIFT_TRADES_MIN } },
      curve: [],
    });
    if (drifted) logger.error({ strategyId: strategy.id, runId: run.id, deltas }, 'REGRESSION DRIFT — engine behavior changed for a pinned window');
    return { strategyId: strategy.id, strategyName: strategy.name, status: drifted ? 'drifted' : 'ok', runId: run.id, deltas };
  } catch (err) {
    const error = (err as Error).message;
    logger.error({ err, strategyId: strategy.id }, 'lab regression failed');
    await insertRun(pool, sub, {
      strategyId: strategy.id, kind: 'regression', status: 'failed', feed: 'sip', gitSha: buildSha(),
      windowStart: null, windowEnd: null, bars: 0, configSnapshot: cfg, metrics: {}, curve: [], error,
    });
    return { strategyId: strategy.id, strategyName: strategy.name, status: 'failed', error };
  }
}

/**
 * @description Forward-steps every non-retired strategy for a user (the nightly leg's first half).
 * @returns Per-strategy applied counts.
 */
export async function runForwardAll(pool: Pool, sub: string): Promise<Array<{ strategyId: string; name: string; applied: number; error?: string }>> {
  await ensureLabSchema(pool);
  const out: Array<{ strategyId: string; name: string; applied: number; error?: string }> = [];
  for (const s of await listStrategies(pool, sub)) {
    if (s.status === 'retired') continue;
    try {
      const r = await forwardStepStrategy(pool, sub, s);
      out.push({ strategyId: s.id, name: s.name, applied: r.applied });
    } catch (err) {
      out.push({ strategyId: s.id, name: s.name, applied: 0, error: (err as Error).message });
    }
  }
  return out;
}

/**
 * @description Regression-runs every baselined, non-retired strategy for a user (the leg's second half).
 * @returns Per-strategy verdicts (the CLI exits 1 if any status is 'drifted' or 'failed').
 */
export async function runRegressionsAll(pool: Pool, sub: string): Promise<RegressionVerdict[]> {
  await ensureLabSchema(pool);
  const out: RegressionVerdict[] = [];
  for (const s of await listStrategies(pool, sub)) {
    if (s.status === 'retired' || !s.baselineRunId) continue;
    out.push(await regressStrategy(pool, sub, s));
  }
  return out;
}

/** @description Convenience: fetch a strategy or throw a caller-safe not-found error. */
export async function requireStrategy(pool: Pool, sub: string, id: string): Promise<StrategyRow> {
  const s = await getStrategy(pool, sub, id);
  if (!s) throw new Error('strategy not found');
  return s;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
