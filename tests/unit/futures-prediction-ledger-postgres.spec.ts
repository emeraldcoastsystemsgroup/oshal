/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove real worker receipts, database issuance, immutable outcomes and non-superuser owner isolation on private PostgreSQL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reproduce persisted JSONB key order before verifying current-setting equivalence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Apply source-alert schema and prove an unsettled notification cannot stall the real forward cycle.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition-root';
import { normalizeFuturesResearchConfig, runFuturesResearch, type FuturesResearchRun } from '@/app/trading-futures-research-dispatch';
import { ensureFuturesPredictions } from '@/app/trading-futures-prediction-schema';
import { executeFuturesPredictionsOffLoop } from '@/app/trading-futures-prediction-worker';
import { listFuturesPredictions, persistFuturesPredictionDrafts, readFuturesPredictionSnapshot, runFuturesPredictionCycle, settleFuturesPrediction } from '@/app/trading-futures-prediction-ledger';
import { fingerprintFuturesEvidence, gradeFuturesPrediction } from '@/app/trading-futures-prediction-evidence';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const ports = vi.hoisted(() => ({ schedule: vi.fn(), notify: vi.fn() }));
vi.mock('@/app/trading-schedule-dispatch', () => ({ getTradingScheduleService: () => ({ getSchedule: ports.schedule }) }));
vi.mock('@/app/routes/notify-routes', () => ({ buildNotificationRouter: () => ({ notify: ports.notify }) }));
const fixture = new DisposablePostgres({ purpose: 'futures-predictions', roles: ['oshal_app'],
  migrations: ['159-futures-research-runs.sql', '160-futures-research-review.sql', '161-futures-predictions.sql', '163-futures-source-alerts.sql'] });
let pool: Pool;
const dir = mkdtempSync(join(tmpdir(), 'futures-forward-pg-'));
const owner = 'forward-owner';
const config = normalizeFuturesResearchConfig({ roots: ['ES'], source: 'kibot-file', dataDir: dir, timeframe: '1Hour', ltfTimeframe: '1Hour',
  start: '2025-01-01', end: '2025-05-31', endMode: 'fixed', split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} },
  predictions: { enabled: true, contracts: { ES: 'ESZ26' }, sourceTimeZone: 'UTC', historyBars: 256, horizonHours: 1 } });
const markets = [{ root: 'ES', evidenceFingerprint: 'b'.repeat(64), report: { windows: [{ window: { oosEnd: '2025-06-01T00:00:00.000Z' },
  finalConfig: { instrument: { symbol: 'ES', multiplier: 50, tickSize: .25 }, startingEquity: 500000,
    entry: { generation: 'ensemble', ensembleEntryThresholdPct: 1, useLtfTrendFilter: false, allowShort: false }, stops: { useStrangleTrail: false } } }] } }] as FuturesResearchRun['markets'];

beforeAll(async () => {
  pool = await fixture.start();
  mkdirSync(join(dir, 'minute'));
  const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const rows = Array.from({ length: 600 }, (_, i) => {
    const n = Math.floor(i / 2), d = new Date(end - (300 - n) * 3_600_000 + (i % 2 ? 59 * 60_000 : 0)), c = 5000 + n * 2;
    return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()},${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2,'0')},${c-1},${c+2},${c-2},${c},1000`;
  });
  writeFileSync(join(dir, 'minute', 'ESZ26.txt'), rows.join('\n'));
  vi.stubEnv('OSHAL_OPERATOR_SUBS', owner);
}, 180_000);
afterAll(async () => { await fixture.stop(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function run(status = 'completed', sameSchedule?: string): Promise<FuturesResearchRun> {
  const runId = randomUUID(), scheduleId = sameSchedule ?? randomUUID();
  await pool.query(`INSERT INTO oshal_trading_futures_research_runs(run_id,owner_sub,schedule_id,status,config,markets) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [runId, owner, scheduleId, status, JSON.stringify(config), JSON.stringify(markets)]);
  return { runId, ownerSub: owner, scheduleId, status, config, markets, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: null };
}
function authorize(current: FuturesResearchRun) {
  ports.schedule.mockResolvedValue({ ownerSub: owner, taskType: `trading-futures-research:${owner}`, status: 'active', taskData: { futures: config }, id: current.scheduleId });
}
async function ownRows(current: FuturesResearchRun) {
  return (await listFuturesPredictions(pool, owner)).filter(row => row.scheduleId === current.scheduleId);
}

describe('actual private PostgreSQL forward ledger and isolated worker', () => {
  it('validates the migrated schema without runtime DDL and requires the protection trigger', async () => {
    vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
    await ensureFuturesPredictions(pool);
    await pool.query('ALTER TABLE oshal_trading_futures_predictions DISABLE TRIGGER oshal_futures_prediction_immutable');
    try { await expect(ensureFuturesPredictions(pool)).rejects.toThrow(/immutability/); }
    finally { await pool.query('ALTER TABLE oshal_trading_futures_predictions ENABLE TRIGGER oshal_futures_prediction_immutable'); }
  });
  it('issues from the real locked replay with database time, deduplicates and freezes a call', async () => {
    const current = await run();
    const work = await executeFuturesPredictionsOffLoop({ config, markets, pending: [] });
    expect(work.drafts[0].status, work.drafts[0].reason ?? '').toBe('pending');
    const before = Date.now();
    expect(await persistFuturesPredictionDrafts(pool, current, work.drafts)).toBe(1);
    const receipt = (await ownRows(current))[0];
    expect(Date.parse(receipt.issuedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(receipt.issuedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await persistFuturesPredictionDrafts(pool, await run('unchanged', current.scheduleId), work.drafts)).toBe(0);
    for (const fragment of ["issued_at=issued_at-interval '1 hour'", "snapshot='{}'::jsonb", "contract='ESZ27'", "owner_sub='intruder'"]) {
      await expect(pool.query(`UPDATE oshal_trading_futures_predictions SET ${fragment} WHERE prediction_id=$1`, [receipt.predictionId])).rejects.toThrow(/immutable/);
    }
    expect(await persistFuturesPredictionDrafts(pool, { ...current, ownerSub: 'intruder' }, work.drafts)).toBe(0);
    expect(await listFuturesPredictions(pool, 'intruder')).toEqual([]);
    const future = structuredClone(work.drafts[0]);
    future.snapshot!.reference.closedAt = new Date(Date.now() + 3_600_000).toISOString();
    await expect(persistFuturesPredictionDrafts(pool, current, [future])).rejects.toMatchObject({ code: '23514' });
  });
  it('fences late outcomes and enforces RLS with a non-superuser application role', async () => {
    const current = await run(); authorize(current);
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    const receipt = (await ownRows(current))[0];
    // Grade payload is a transport fixture here; raw bar grading is exercised separately through real files.
    const outcome = { status: 'graded' as const, reason: null, correct: false, signedTicks: -4, priceChange: -1 };
    expect(await settleFuturesPrediction(pool, 'intruder', receipt.predictionId, outcome)).toBe(false);
    expect(await settleFuturesPrediction(pool, owner, receipt.predictionId, outcome)).toBe(true);
    expect(await settleFuturesPrediction(pool, owner, receipt.predictionId, { status: 'pending', reason: null })).toBe(false);
    await expect(pool.query("UPDATE oshal_trading_futures_predictions SET outcome='{}'::jsonb WHERE prediction_id=$1", [receipt.predictionId])).rejects.toThrow(/immutable/);
    const client = await fixture.rolePool('oshal_app').connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub','intruder',false), set_config('oshal.is_operator','off',false)");
      expect((await client.query('SELECT * FROM oshal_trading_futures_predictions')).rows).toEqual([]);
      expect((await client.query("UPDATE oshal_trading_futures_predictions SET reason='forged' WHERE prediction_id=$1 RETURNING prediction_id", [receipt.predictionId])).rows).toEqual([]);
      await client.query("SELECT set_config('oshal.current_sub',$1,false)", [owner]);
      expect((await client.query('SELECT * FROM oshal_trading_futures_predictions WHERE prediction_id=$1', [receipt.predictionId])).rows).toHaveLength(1);
    } finally { client.release(); }
  });
  it('handles unchanged and failed studies independently and honors revoked or paused opt-in', async () => {
    const current = await run('unchanged'); authorize(current);
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    expect(await ownRows(current)).toHaveLength(1);
    const failed = await run('failed', current.scheduleId); failed.markets = [];
    await runFuturesPredictionCycle({ pool } as AppContext, failed);
    const row = (await pool.query('SELECT prediction_cycle FROM oshal_trading_futures_research_runs WHERE run_id=$1', [failed.runId])).rows[0];
    expect(row.prediction_cycle).toMatchObject({ status: 'completed', inserted: 1 });
    expect(row.prediction_cycle.checked).toBeGreaterThanOrEqual(1);
    expect((await ownRows(failed)).some(receipt => receipt.status === 'withheld')).toBe(true);
    for (const schedule of [null, { ownerSub: 'intruder' }, { ownerSub: owner, status: 'paused' },
      { ownerSub: owner, status: 'active', taskType: `trading-futures-research:${owner}`, taskData: { futures: { predictions: { enabled: false } } } }]) {
      const next = await run(); ports.schedule.mockResolvedValue(schedule);
      await runFuturesPredictionCycle({ pool } as AppContext, next);
      expect(await ownRows(next)).toHaveLength(0);
    }
  });
  it('settles the actual failed-study dispatcher into an independent forward receipt', async () => {
    const scheduleId = randomUUID();
    ports.schedule.mockResolvedValue({ id: scheduleId, ownerSub: owner, taskType: `trading-futures-research:${owner}`, status: 'active', taskData: { futures: config } });
    let release!: () => void;
    ports.notify.mockImplementation(() => new Promise(resolve => { release = () => resolve({ delivered: false, channel: 'none', skipped: true, reason: 'channel-none' }); }));
    const current = await runFuturesResearch({ pool } as AppContext, owner, scheduleId, { ...config, sourceAlerts: true });
    try {
      await vi.waitFor(async () => {
        const row = (await pool.query('SELECT status,prediction_cycle,source_alert FROM oshal_trading_futures_research_runs WHERE run_id=$1', [current.runId])).rows[0];
        expect(row.status).toBe('failed');
        expect(row.prediction_cycle?.status).toBe('completed');
        expect(row.source_alert?.status).toBe('claimed');
      }, { timeout: 15_000 });
      expect(ports.notify).toHaveBeenCalledTimes(1);
      expect((await ownRows(current))[0]).toMatchObject({ status: 'withheld', snapshot: null });
    } finally { release?.(); }
    await vi.waitFor(async () => expect((await pool.query('SELECT source_alert FROM oshal_trading_futures_research_runs WHERE run_id=$1', [current.runId])).rows[0].source_alert.status).toBe('skipped'));
  }, 45_000);
  it('rechecks revocation after the real worker finishes, before any new receipt is persisted', async () => {
    const current = await run();
    ports.schedule.mockResolvedValueOnce({ ownerSub: owner, taskType: `trading-futures-research:${owner}`, status: 'active', taskData: { futures: config } }).mockResolvedValue(null);
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    expect(await ownRows(current)).toEqual([]);
  });
  it('defers a concurrent cycle instead of spawning an additional bounded worker', async () => {
    const current = await run(); authorize(current);
    const lock = await pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('oshal:futures-prediction-worker'))");
      await runFuturesPredictionCycle({ pool } as AppContext, current);
      expect(await ownRows(current)).toEqual([]);
      const row = (await pool.query('SELECT prediction_cycle FROM oshal_trading_futures_research_runs WHERE run_id=$1', [current.runId])).rows[0];
      expect(row.prediction_cycle.status).toBe('deferred');
    } finally { await lock.query("SELECT pg_advisory_unlock(hashtext('oshal:futures-prediction-worker'))"); lock.release(); }
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    expect(await ownRows(current)).toHaveLength(1);
  });
  it('recognizes unchanged settings after PostgreSQL JSONB reorders their object keys', async () => {
    const current = await run();
    const stored = (await pool.query('SELECT config FROM oshal_trading_futures_research_runs WHERE run_id=$1', [current.runId])).rows[0].config;
    expect(JSON.stringify(stored.predictions)).not.toBe(JSON.stringify(config.predictions));
    ports.schedule.mockResolvedValue({ ownerSub: owner, taskType: `trading-futures-research:${owner}`, status: 'active', taskData: { futures: stored } });
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    expect(await ownRows(current)).toHaveLength(1);
  });
  it('reproduces the persisted fingerprint and grades later file evidence after a real JSONB round trip', async () => {
    const current = await run(); authorize(current);
    await runFuturesPredictionCycle({ pool } as AppContext, current);
    const receipt = (await ownRows(current))[0];
    const snapshot = (await readFuturesPredictionSnapshot(pool, owner, receipt.predictionId))!;
    expect(await readFuturesPredictionSnapshot(pool, 'intruder', receipt.predictionId)).toBeNull();
    expect(fingerprintFuturesEvidence(snapshot)).toBe(receipt.fingerprint);
    const file = join(dir, 'minute', 'ESZ26.txt'), original = readFileSync(file, 'utf8');
    const end = Math.floor(Date.parse(receipt.issuedAt) / 3_600_000) * 3_600_000;
    const future = Array.from({ length: 8 }, (_, i) => {
      const n = Math.floor(i / 2), d = new Date(end + n * 3_600_000 + (i % 2 ? 59 * 60_000 : 0)), c = 5600 + n * 2;
      return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()},${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2,'0')},${c-1},${c+2},${c-2},${c},1000`;
    });
    try {
      appendFileSync(file, '\n' + future.join('\n'));
      // Advance only the pure grader's observation clock over synthetic future file rows, never database issuance.
      const outcome = gradeFuturesPrediction(snapshot, receipt.issuedAt, end + 4 * 3_600_000);
      expect(outcome).toMatchObject({ status: 'graded', correct: true });
      expect(await settleFuturesPrediction(pool, owner, receipt.predictionId, outcome)).toBe(true);
      expect((await ownRows(current))[0].outcome).toEqual(outcome);
    } finally { writeFileSync(file, original); }
  });
});
