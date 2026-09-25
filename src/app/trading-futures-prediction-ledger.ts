/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist actual issuance, owner-qualified evidence, idempotent grades and visible independent cycle failures.
 */
import type { AppContext } from './composition-root';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { getTradingScheduleService } from './trading-schedule-dispatch';
import { futuresResearchTaskType, type FuturesResearchRun } from './trading-futures-research-dispatch';
import { ensureFuturesPredictions } from './trading-futures-prediction-schema';
import { executeFuturesPredictionsOffLoop } from './trading-futures-prediction-worker';
import type { FuturesPredictionDraft, FuturesPredictionOutcome, FuturesPredictionSnapshot } from './trading-futures-prediction-evidence';

/** @description Durable research-only receipt. Issuance and terminal grades cannot be rewritten. */
export interface FuturesPredictionReceipt {
  predictionId: string; runId: string; scheduleId: string; root: string; contract: string;
  status: string; reason: string | null; fingerprint: string;
  issuedAt: string; checkedAt: string; snapshot: FuturesPredictionSnapshot | null; outcome: FuturesPredictionOutcome | null;
}
/** @description List payload omits replay arrays; exact frozen evidence is fetched separately. */
export type FuturesPredictionSummary = Omit<FuturesPredictionReceipt, 'snapshot'> & { snapshot: Omit<FuturesPredictionSnapshot, 'chart' | 'ltf' | 'daily'> | null };

/** @description Read only the caller's receipts, even when its database identity is an operator.
 * @param pool - Application pool. @param owner - Authenticated owner. @returns At most 50 newest receipts.
 */
export async function listFuturesPredictions(pool: AppContext['pool'], owner: string): Promise<FuturesPredictionSummary[]> {
  await ensureFuturesPredictions(pool);
  const result = await pool.query(`SELECT prediction_id,run_id,schedule_id,root,contract,status,reason,fingerprint,issued_at,checked_at,outcome,
    snapshot - 'chart' - 'ltf' - 'daily' AS snapshot FROM oshal_trading_futures_predictions WHERE owner_sub=$1 ORDER BY issued_at DESC LIMIT 50`, [owner]);
  return result.rows.map(row => ({ predictionId: row.prediction_id, runId: row.run_id, scheduleId: row.schedule_id,
    root: row.root, contract: row.contract, status: row.status, reason: row.reason, fingerprint: row.fingerprint,
    issuedAt: new Date(row.issued_at).toISOString(), checkedAt: new Date(row.checked_at).toISOString(), snapshot: row.snapshot, outcome: row.outcome }));
}

/** @description Resolve a single frozen evidence payload by exact caller ownership.
 * @param pool - Application pool. @param owner - Authenticated owner. @param id - Receipt UUID.
 * @returns Frozen snapshot, or null for missing/not-owned/withheld receipts.
 */
export async function readFuturesPredictionSnapshot(pool: AppContext['pool'], owner: string, id: string): Promise<FuturesPredictionSnapshot | null> {
  await ensureFuturesPredictions(pool);
  const row = (await pool.query('SELECT snapshot FROM oshal_trading_futures_predictions WHERE prediction_id=$1 AND owner_sub=$2', [id, owner])).rows[0];
  return row?.snapshot ?? null;
}

/** @description Let PostgreSQL assign actual issuance and deduplicate repeated inputs; no backdating API exists.
 * @param pool - Application pool. @param run - Owned study identity. @param drafts - Read-only worker results.
 * @returns Number of newly persisted receipts.
 */
export async function persistFuturesPredictionDrafts(pool: AppContext['pool'], run: Pick<FuturesResearchRun, 'runId' | 'ownerSub' | 'scheduleId'>, drafts: FuturesPredictionDraft[]): Promise<number> {
  let inserted = 0;
  for (const draft of drafts) {
    const saved = await pool.query(`INSERT INTO oshal_trading_futures_predictions(owner_sub,schedule_id,run_id,root,contract,fingerprint,status,snapshot,reason)
      SELECT owner_sub,schedule_id,run_id,$4,$5,$6,$7,$8::jsonb,$9 FROM oshal_trading_futures_research_runs
      WHERE run_id=$1 AND owner_sub=$2 AND schedule_id=$3 AND status <> 'running'
      ON CONFLICT(owner_sub,schedule_id,contract,fingerprint) DO NOTHING RETURNING prediction_id`,
    [run.runId, run.ownerSub, run.scheduleId, draft.root, draft.contract, draft.fingerprint, draft.status, draft.snapshot ? JSON.stringify(draft.snapshot) : null, draft.reason]);
    inserted += saved.rows.length;
  }
  return inserted;
}

/** @description Compare-and-set prevents late cycles from overwriting an already graded receipt.
 * @param pool - Application pool. @param owner - Exact owner. @param predictionId - Receipt identity.
 * @param outcome - Worker grade. @returns Whether a nonterminal owned receipt was updated.
 */
export async function settleFuturesPrediction(pool: AppContext['pool'], owner: string, predictionId: string, outcome: FuturesPredictionOutcome): Promise<boolean> {
  const saved = await pool.query(`UPDATE oshal_trading_futures_predictions SET status=$3,reason=$4,outcome=$5::jsonb,checked_at=clock_timestamp()
    WHERE prediction_id=$1 AND owner_sub=$2 AND status IN ('pending','unavailable') RETURNING prediction_id`,
  [predictionId, owner, outcome.status, outcome.reason, JSON.stringify(outcome)]);
  return saved.rows.length > 0;
}

async function stillOptedIn(run: FuturesResearchRun): Promise<boolean> {
  if (!isOperatorIdentity(run.ownerSub)) return false;
  const schedule = await getTradingScheduleService()?.getSchedule(run.scheduleId);
  const current = schedule?.taskData?.futures as FuturesResearchRun['config'] | undefined;
  return schedule?.ownerSub === run.ownerSub && schedule.taskType === futuresResearchTaskType(run.ownerSub)
    && schedule.status === 'active' && current?.predictions?.enabled === true
    && JSON.stringify(current.predictions) === JSON.stringify(run.config.predictions)
    && ['dataDir','source','timeframe','ltfTimeframe','minVolume'].every(key => current[key as keyof typeof current] === run.config[key as keyof typeof current]);
}

/** @description An independent prediction cycle runs even after unchanged or failed OOS studies; it cannot downgrade study evidence.
 * @param ctx - Application context. @param run - Current owned run, including completed markets when available.
 * @returns Completion after bounded grading and explicit opt-in rechecks; failures remain visible on the run.
 */
async function executeCycle(ctx: AppContext, run: FuturesResearchRun): Promise<void> {
  if (!await stillOptedIn(run)) return;
  const pending = await ctx.pool.query(`SELECT prediction_id,issued_at,snapshot FROM oshal_trading_futures_predictions
    WHERE owner_sub=$1 AND status IN ('pending','unavailable') ORDER BY checked_at LIMIT 25`, [run.ownerSub]);
  const result = await executeFuturesPredictionsOffLoop({ config: run.config, markets: run.markets,
    pending: pending.rows.map(row => ({ predictionId: row.prediction_id, issuedAt: new Date(row.issued_at).toISOString(), snapshot: row.snapshot })) });
  if (!await stillOptedIn(run)) return;
  const inserted = await persistFuturesPredictionDrafts(ctx.pool, run, result.drafts);
  for (const grade of result.grades) await settleFuturesPrediction(ctx.pool, run.ownerSub, grade.predictionId, grade.outcome);
  await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET prediction_cycle=$3::jsonb WHERE run_id=$1 AND owner_sub=$2`,
    [run.runId, run.ownerSub, JSON.stringify({ status: 'completed', inserted, checked: result.grades.length, completedAt: new Date().toISOString() })]);
}

/** @description One cross-process worker slot prevents rapid manual study triggers from multiplying prediction heaps.
 * @param ctx - Application context. @param run - Current owner-bound research run.
 * @returns A persisted cycle result or visible deferral; no historical status is changed.
 */
export async function runFuturesPredictionCycle(ctx: AppContext, run: FuturesResearchRun): Promise<void> {
  if (!run.config.predictions?.enabled) return;
  try {
    await ensureFuturesPredictions(ctx.pool);
    const client = await ctx.pool.connect();
    let locked = false;
    try {
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('oshal:futures-prediction-worker')) AS locked")).rows[0].locked;
      if (locked) await executeCycle(ctx, run);
      else await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET prediction_cycle=$3::jsonb WHERE run_id=$1 AND owner_sub=$2`,
        [run.runId, run.ownerSub, JSON.stringify({ status: 'deferred', error: 'Another forward cycle is active; retry on a later research run.', completedAt: new Date().toISOString() })]);
    } finally {
      try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('oshal:futures-prediction-worker'))"); }
      finally { client.release(); }
    }
  } catch {
    await ctx.pool.query(`UPDATE oshal_trading_futures_research_runs SET prediction_cycle=$3::jsonb WHERE run_id=$1 AND owner_sub=$2`,
      [run.runId, run.ownerSub, JSON.stringify({ status: 'failed', error: 'Forward cycle failed; check migration 161 and configured contract archives. Historical study and prior receipts are unchanged.', completedAt: new Date().toISOString() })]);
  }
}
