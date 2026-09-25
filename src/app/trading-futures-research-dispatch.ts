/**
 * ADR-116 futures research loop — console-configured, bounded, paper-only.
 *
 * The Futures Phase 2 result is evidence, not a stop. This worker keeps the research rail alive:
 * the operator supplies roots, windows, source and stage grids in the Trading console; the scheduler
 * runs the bounded permutation study overnight; every result is written to a reviewable ledger and
 * a ticket. Nothing here can place a live order or silently promote a losing study.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add the console-owned futures research schedule, bounded stage-grid validation, real archive runner, durable run ledger and review ticket; live execution remains outside this worker.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Expose owner-scoped durable interactive reviews alongside unchanged deterministic study evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Persist configured quality gates and distinguish insufficient OOS samples from passing research evidence.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Queue opted-in new evidence through its dedicated workflow without running inference in the study worker.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Normalize forward opt-in and settle its isolated receipt cycle independently of historical study status.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Settle forward outcomes before scheduled review admission so new grades can inform unchanged historical studies.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Select owned prior evidence before the worker and fence optimizer reuse to this API generation.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Persist classified source failures and opt-in notification receipts independently of forward settlement.
 */

import { dirname, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { FuturesStudyReuse } from './trading-futures-research-reuse';
import type { AppContext } from './composition-root';
import type { ScheduleDispatchResult, ScheduleRecord } from '@/features/scheduling';
import {
  DEFAULT_OPTIMIZER_STAGES, getFuturesRoot,
  type OptimizerStageName, type Timeframe,
} from '@/features/trading';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap, SCHEMA_LOCK_KEYS } from '@/shared/services/database';
import { futuresResearchWorkerEntry, type FuturesResearchWorkerOutput } from './trading-futures-research-worker';
import type { FuturesResearchMarket } from './trading-futures-research-study';
import type { FuturesResearchReview } from './trading-futures-research-review-contract';
import { normalizeFuturesQuality, type FuturesQualityConfig } from './trading-futures-research-quality';
import { normalizeFuturesPredictions, type FuturesPredictionConfig } from './trading-futures-prediction-config';
import { FuturesSourceError } from './trading-futures-source-error';
import { notifyFuturesSourceFailure, type FuturesSourceAlert } from './trading-futures-source-alert';

const logger = createChildLogger({ module: 'trading-futures-research-dispatch' });
// Supported code reloads/deployments restart the API. Never reuse a report across that boundary.
const studyGeneration = randomUUID();

export const FUTURES_RESEARCH_CRON_DEFAULT = '0 2 * * *';
export const FUTURES_RESEARCH_TASK_PREFIX = 'trading-futures-research';

export interface FuturesResearchConfig {
  roots: string[];
  timeframe: Timeframe;
  ltfTimeframe: Timeframe;
  source: 'mock' | 'kibot' | 'kibot-file';
  dataDir: string;
  adjust: 'panama' | 'none';
  minVolume: number;
  start: string;
  end: string;
  endMode: 'latest' | 'fixed';
  split: { inSampleMonths: number; oosMonths: number; stepMonths: number };
  stageGrids: Partial<Record<OptimizerStageName, Record<string, unknown[]>>>;
  nightlyCron: string;
  quality: FuturesQualityConfig;
  nightlyReview: boolean;
  sourceAlerts?: boolean;
  predictions?: FuturesPredictionConfig;
}

const TIMEFRAMES = new Set<Timeframe>(['5Min', '1Hour', '1Day', '1Week', '3Month']);
const STAGE_NAMES = new Set<OptimizerStageName>(['Entry', 'StopLoss', 'Trail', 'Targets', 'EmergencyExit', 'Sizing']);
const GRID_AXES: Record<OptimizerStageName, Record<string, (value: unknown) => boolean>> = {
  Entry: { 'entry.ensembleEntryThresholdPct': (v) => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 100 },
  StopLoss: { 'stops.initialStopAtrMultiple': (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10 },
  Trail: { 'stops.stopBufferMode': (v) => v === 'ticks' || v === 'atr-percent' },
  Targets: { 'targets.useTargets': (v) => typeof v === 'boolean' },
  EmergencyExit: { 'stops.useStrangleTrail': (v) => typeof v === 'boolean' },
  Sizing: { 'entry.riskPerTradePercent': (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 5 },
};

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new RangeError(`futures research value must be an integer from 1 to ${max}`);
  return n;
}

function isoDate(value: unknown, fallback: string): string {
  const date = new Date(String(value ?? fallback));
  if (Number.isNaN(date.getTime())) throw new RangeError('futures research dates must be ISO dates');
  return date.toISOString();
}

function normalizeGrid(raw: unknown): Partial<Record<OptimizerStageName, Record<string, unknown[]>>> {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('stageGrids must be an object');
  const result: Partial<Record<OptimizerStageName, Record<string, unknown[]>>> = {};
  for (const [stage, axes] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAGE_NAMES.has(stage as OptimizerStageName)) throw new RangeError(`unknown futures optimizer stage '${stage}'`);
    if (!axes || typeof axes !== 'object' || Array.isArray(axes)) throw new TypeError(`${stage} grid must be an object`);
    const normalized: Record<string, unknown[]> = {};
    let candidates = 1;
    for (const [path, values] of Object.entries(axes as Record<string, unknown>)) {
      const stageAxes = GRID_AXES[stage as OptimizerStageName];
      const allowed = Object.prototype.hasOwnProperty.call(stageAxes, path) ? stageAxes[path] : undefined;
      if (!allowed) throw new RangeError(`unsupported futures optimizer axis '${stage}.${path}'`);
      if (!Array.isArray(values) || values.length === 0 || values.length > 8) throw new RangeError(`${stage}.${path} must contain 1-8 candidates`);
      if (!values.every(allowed)) throw new RangeError(`${stage}.${path} contains an invalid candidate`);
      candidates *= values.length;
      if (candidates > 64) throw new RangeError(`${stage} grid is too large; maximum is 64 candidates`);
      normalized[path] = values;
    }
    result[stage as OptimizerStageName] = normalized;
  }
  return result;
}

/** Normalize the console payload and enforce a finite research envelope. */
export function normalizeFuturesResearchConfig(raw: unknown): FuturesResearchConfig {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const roots = Array.isArray(input.roots) ? [...new Set(input.roots.map((root) => String(root).trim().toUpperCase()).filter(Boolean))] : ['ES', 'CL'];
  if (!roots.length || roots.length > 8) throw new RangeError('futures research must name 1-8 roots');
  for (const root of roots) if (!getFuturesRoot(root)) throw new RangeError(`unknown futures root '${root}'`);
  const timeframe = String(input.timeframe ?? '1Hour') as Timeframe;
  const ltfTimeframe = String(input.ltfTimeframe ?? '1Day') as Timeframe;
  if (!TIMEFRAMES.has(timeframe) || !TIMEFRAMES.has(ltfTimeframe)) throw new RangeError('unsupported futures timeframe');
  const source = String(input.source ?? 'kibot-file') as FuturesResearchConfig['source'];
  if (!['mock', 'kibot', 'kibot-file'].includes(source)) throw new RangeError('unsupported futures source');
  const splitInput = (input.split && typeof input.split === 'object' ? input.split : {}) as Record<string, unknown>;
  const split = {
    inSampleMonths: positiveInt(splitInput.inSampleMonths, 24, 120),
    oosMonths: positiveInt(splitInput.oosMonths, 6, 60),
    stepMonths: positiveInt(splitInput.stepMonths, 6, 60),
  };
  if (split.stepMonths < split.oosMonths) throw new RangeError('futures research stepMonths must not overlap out-of-sample windows');
  const start = isoDate(input.start, '2021-01-01T00:00:00Z');
  if (input.endMode != null && input.endMode !== 'latest' && input.endMode !== 'fixed') throw new RangeError('unsupported futures research end mode');
  const endMode = input.endMode === 'fixed' ? 'fixed' : 'latest';
  const latestCompletedUtcDay = new Date();
  latestCompletedUtcDay.setUTCHours(0, 0, 0, 0);
  latestCompletedUtcDay.setTime(latestCompletedUtcDay.getTime() - 1_000);
  const end = endMode === 'latest'
    ? latestCompletedUtcDay.toISOString()
    : isoDate(input.end, '2025-12-31T23:59:59Z');
  if (Date.parse(end) <= Date.parse(start)) throw new RangeError('futures research end must be after start');
  const stageGrids = normalizeGrid(input.stageGrids);
  const stages = DEFAULT_OPTIMIZER_STAGES.map((stage) => stageGrids[stage.name] ?? stage.grid);
  const monthSpan = (new Date(end).getUTCFullYear() - new Date(start).getUTCFullYear()) * 12
    + new Date(end).getUTCMonth() - new Date(start).getUTCMonth() + 1;
  const estimatedWindows = Math.max(0, Math.floor((monthSpan - split.inSampleMonths - split.oosMonths) / split.stepMonths) + 1);
  const upperBoundBacktests = roots.length * estimatedWindows * (1 + stages.reduce((sum, grid) => sum + Object.values(grid).reduce((n, values) => n * values.length, 1), 0));
  if (!estimatedWindows) throw new RangeError('futures research window has no complete out-of-sample period');
  if (upperBoundBacktests > 512) throw new RangeError(`futures research study too large: ${upperBoundBacktests} estimated backtests (max 512)`);
  if (input.dataDir != null && typeof input.dataDir !== 'string') throw new TypeError('futures research dataDir must be a path string');
  const dataDir = String(input.dataDir || process.env.KIBOT_DATA_DIR || '').trim();
  if (dataDir.length > 512) throw new RangeError('futures research dataDir is too long');
  if (source === 'kibot-file' && !dataDir) throw new RangeError('Kibot file source requires a data directory');
  if (source === 'mock' && process.env.NODE_ENV !== 'test') throw new RangeError('mock futures data is test-only');
  return {
    roots,
    timeframe,
    ltfTimeframe,
    source,
    dataDir,
    adjust: input.adjust === 'none' ? 'none' : 'panama',
    minVolume: positiveInt(input.minVolume, 1, 1_000_000),
    start,
    end,
    endMode,
    split,
    stageGrids,
    nightlyCron: String(input.nightlyCron ?? FUTURES_RESEARCH_CRON_DEFAULT).trim() || FUTURES_RESEARCH_CRON_DEFAULT,
    quality: normalizeFuturesQuality(input.quality),
    nightlyReview: normalizeNightlyReview(input.nightlyReview),
    sourceAlerts: normalizeSourceAlerts(input.sourceAlerts),
    predictions: normalizeFuturesPredictions(input.predictions, { roots, source, timeframe, ltfTimeframe }),
  };
}

/** @description Older schedules stay opted out; only an explicit boolean enables review spending. */
function normalizeNightlyReview(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw new TypeError('nightlyReview must be a boolean');
  return raw;
}

/** @description No legacy schedule can opt into outward source alerts implicitly. */
function normalizeSourceAlerts(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw new TypeError('sourceAlerts must be a boolean');
  return raw;
}

export function futuresResearchTaskType(sub: string): string { return `${FUTURES_RESEARCH_TASK_PREFIX}:${sub}`; }
export function isFuturesResearchSchedule(taskType: string): boolean { return taskType.startsWith(`${FUTURES_RESEARCH_TASK_PREFIX}:`); }

export interface FuturesResearchRun {
  runId: string; ownerSub: string; scheduleId: string; status: string; config: FuturesResearchConfig;
  markets: FuturesResearchMarket[];
  error: string | null; createdAt: string; completedAt: string | null;
  review?: FuturesResearchReview | null;
  sourceAlert?: FuturesSourceAlert | null;
  predictionCycle?: { status: string; inserted?: number; checked?: number; error?: string; completedAt: string } | null;
}

/** @description Provision or validate the owner-scoped research ledger. @param pool - Owner-aware application pool. @returns Schema readiness. */
export async function ensureFuturesResearchTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading futures research', lockKey: SCHEMA_LOCK_KEYS.trading,
    statements: [`CREATE TABLE IF NOT EXISTS oshal_trading_futures_research_runs (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT NOT NULL, schedule_id TEXT NOT NULL,
      status TEXT NOT NULL, config JSONB NOT NULL, markets JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
    )`, `ALTER TABLE oshal_trading_futures_research_runs ADD COLUMN IF NOT EXISTS review JSONB`,
    `ALTER TABLE oshal_trading_futures_research_runs ADD COLUMN IF NOT EXISTS source_alert JSONB`,
    `CREATE UNIQUE INDEX IF NOT EXISTS oshal_futures_one_running_run ON oshal_trading_futures_research_runs (status) WHERE status = 'running'`,
    `CREATE INDEX IF NOT EXISTS oshal_futures_runs_owner_created ON oshal_trading_futures_research_runs (owner_sub, created_at DESC)`,
    ...buildOwnerRlsPolicyStatements('oshal_trading_futures_research_runs', 'owner_sub')],
    requirements: [{ table: 'oshal_trading_futures_research_runs', columns: ['run_id', 'owner_sub', 'schedule_id', 'status', 'config', 'markets', 'created_at', 'review', 'source_alert'] }],
  });
}

/** @description Isolate computation and exact-input reuse with bounded heap/time; never block the API optimizer loop.
 * @param config - Normalized study settings. @param previous - Server-selected owned ledger candidate.
 * @returns Current market evidence and computation receipts.
 */
export function executeFuturesStudyOffLoop(config: FuturesResearchConfig, previous?: FuturesStudyReuse['previous']): Promise<FuturesResearchMarket[]> {
  return new Promise((resolveStudy, rejectStudy) => {
    const entry = futuresResearchWorkerEntry;
    const preload = entry.endsWith('.ts') ? require.resolve('tsx/cjs') : null;
    const bootstrap = [
      "const { workerData } = require('node:worker_threads');",
      "require('tsconfig-paths').register({ baseUrl: workerData.root, paths: { '@/*': ['*'] } });",
      'if (workerData.preload) require(workerData.preload);',
      'require(workerData.entry);',
    ].join('\n');
    const worker = new Worker(bootstrap, {
      eval: true,
      workerData: { config, reuse: { generation: studyGeneration, previous }, entry, preload, root: resolve(dirname(entry), '..') },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => rejectStudy(new Error('futures research worker exceeded 30 minutes'))), 30 * 60_000);
    worker.once('message', (message: FuturesResearchWorkerOutput) => finish(() => {
      if ('markets' in message) resolveStudy(message.markets);
      else rejectStudy(message.error.sourceIssue ? new FuturesSourceError(message.error.message, message.error.sourceIssue) : new Error(message.error.message));
    }));
    worker.once('error', (error) => finish(() => rejectStudy(error)));
    worker.once('exit', (code) => finish(() => rejectStudy(new Error(`futures research worker exited ${code} before a result`))));
  });
}

async function settleForwardCycle(ctx: AppContext, run: FuturesResearchRun): Promise<void> {
  if (!run.config.predictions?.enabled) return;
  try {
    const { runFuturesPredictionCycle } = await import('./trading-futures-prediction-ledger.js');
    await runFuturesPredictionCycle(ctx, run);
  } catch (error) { logger.error({ err: error, runId: run.runId }, 'Futures forward cycle failed outside its receipt boundary'); }
}

async function settleFuturesResearch(ctx: AppContext, run: FuturesResearchRun): Promise<void> {
  try {
    const prior = (await ctx.pool.query(`SELECT run_id, markets FROM oshal_trading_futures_research_runs WHERE owner_sub=$1 AND schedule_id=$2 AND status IN ('completed','insufficient_sample','unchanged') ORDER BY created_at DESC LIMIT 1`, [run.ownerSub, run.scheduleId])).rows[0];
    const previous = Array.isArray(prior?.markets) ? prior.markets as FuturesResearchMarket[] : undefined;
    const markets = await executeFuturesStudyOffLoop(run.config, previous ? { runId: String(prior.run_id), markets: previous } : undefined);
    run.markets = markets;
    const fingerprints = (rows: FuturesResearchMarket[]): string => JSON.stringify(rows.map(({ root, latestCompleteOosEnd, evidenceFingerprint }) => [root, latestCompleteOosEnd, evidenceFingerprint]));
    const unchanged = Array.isArray(previous) && fingerprints(previous) === fingerprints(markets);
    const sampleStatus = markets.some(market => market.quality?.sampleStatus === 'insufficient') ? 'insufficient_sample' : 'completed';
    await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET status=$2, markets=$3::jsonb, completed_at=now() WHERE run_id=$1 AND status='running'`, [run.runId, unchanged ? 'unchanged' : sampleStatus, JSON.stringify(markets)]);
    await settleForwardCycle(ctx, run);
    if (run.config.nightlyReview) {
      try {
        const { queueFuturesResearchReview } = await import('./trading-futures-research-queue.js');
        await queueFuturesResearchReview(ctx, run.ownerSub, run.runId);
      } catch (reviewError) {
        logger.error({ err: reviewError, runId: run.runId }, 'nightly Futures review admission failed');
        await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET review=$2::jsonb WHERE run_id=$1 AND review IS NULL`,
          [run.runId, JSON.stringify({ status: 'failed', attemptId: run.runId, requestedAt: new Date().toISOString(), error: 'Nightly review not admitted. Check the package, worker and schedule opt-in; the study is unchanged.' })]);
      }
      return;
    }
    if (unchanged) return;
    try {
      await ctx.ticketService.createTicket({ title: `Futures research run — ${run.config.roots.join(', ')}`, ticketType: 'trading-decision', ownerSub: run.ownerSub, status: 'complete', description: 'Paper-only bounded futures research. Completion is not sample sufficiency or statistical confidence. Review the durable run before any paper-book change; live execution remains separately gated.', priority: 'none', labels: ['futures-research'], workspaceId: null, assignedAgentId: null, parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null, metadata: { source: FUTURES_RESEARCH_TASK_PREFIX, runId: run.runId, sampleStatus, markets: markets.map(({ root, outOfSampleTrades, outOfSampleNet, quality }) => ({ root, outOfSampleTrades, outOfSampleNet, quality })) } });
    } catch (ticketError) {
      logger.warn({ err: ticketError, runId: run.runId }, 'futures run persisted but review ticket creation failed');
    }
  } catch (error) {
    await failFuturesResearch(ctx, run, error);
  }
}

async function failFuturesResearch(ctx: AppContext, run: FuturesResearchRun, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const sourceAlert: FuturesSourceAlert | null = error instanceof FuturesSourceError
    ? { issue: error.issue, status: run.config.sourceAlerts === true ? 'ready' : 'disabled' } : null;
  logger.error({ err: error, runId: run.runId }, 'futures research run failed');
  const failed = await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs
    SET status='failed', error=$2, source_alert=$3::jsonb, completed_at=now()
    WHERE run_id=$1 AND owner_sub=$4 AND status='running' RETURNING run_id`,
  [run.runId, message, JSON.stringify(sourceAlert), run.ownerSub]);
  if (!failed.rowCount) return;
  await Promise.all([settleForwardCycle(ctx, { ...run, markets: [] }),
    sourceAlert ? notifyFuturesSourceFailure(ctx, run.ownerSub, run.runId) : Promise.resolve()]);
}

/** Admit one durable run and return immediately; worker settlement is visible through the console ledger. */
export async function runFuturesResearch(ctx: AppContext, ownerSub: string, scheduleId: string, rawConfig: unknown): Promise<FuturesResearchRun> {
  const config = normalizeFuturesResearchConfig(rawConfig);
  await ensureFuturesResearchTable(ctx.pool);
  await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET status='failed', error='worker interrupted before completion', completed_at=now() WHERE status='running' AND created_at < now() - interval '45 minutes'`);
  const row = (await ctx.pool.query(`INSERT INTO oshal_trading_futures_research_runs (owner_sub, schedule_id, status, config) VALUES ($1,$2,'running',$3::jsonb) RETURNING run_id, created_at`, [ownerSub, scheduleId, JSON.stringify(config)])).rows[0];
  const run: FuturesResearchRun = { runId: String(row.run_id), ownerSub, scheduleId, status: 'running', config, markets: [], error: null, createdAt: new Date(row.created_at).toISOString(), completedAt: null };
  void settleFuturesResearch(ctx, run).catch((error) => logger.error({ err: error, runId: run.runId }, 'futures run settlement failed'));
  return run;
}

export async function dispatchTradingFuturesResearch(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const ownerSub = String(td.userSub || schedule.ownerSub || '');
  if (!ownerSub) return { success: false, scheduleId: schedule.id, error: 'futures research schedule missing userSub' };
  try {
    const run = await runFuturesResearch(ctx, ownerSub, schedule.id, td.futures);
    return { success: true, scheduleId: schedule.id, taskId: run.runId };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return { success: false, scheduleId: schedule.id, error: 'another futures research run is already active' };
    return { success: false, scheduleId: schedule.id, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listFuturesResearchRuns(pool: AppContext['pool'], ownerSub: string, limit = 10): Promise<FuturesResearchRun[]> {
  await ensureFuturesResearchTable(pool);
  const rows = (await pool.query(`SELECT *, to_jsonb(oshal_trading_futures_research_runs)->'prediction_cycle' AS forward_cycle FROM oshal_trading_futures_research_runs WHERE owner_sub=$1 ORDER BY created_at DESC LIMIT $2`, [ownerSub, Math.min(50, Math.max(1, limit))])).rows;
  return rows.map((row) => ({ runId: String(row.run_id), ownerSub: String(row.owner_sub), scheduleId: String(row.schedule_id), status: String(row.status), config: row.config as FuturesResearchConfig, markets: row.markets as FuturesResearchRun['markets'], error: row.error ? String(row.error) : null, createdAt: new Date(row.created_at).toISOString(), completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null, review: row.review ?? null, predictionCycle: row.forward_cycle ?? null, sourceAlert: row.source_alert ?? null }));
}
