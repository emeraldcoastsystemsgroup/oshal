/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The assessment step-attribution guard. Drives the REAL dispatchTradingAssess and proves that when one stage fails the ERROR line names the STEP ('assessment step failed' + step) instead of the whole run, that the steps which do not depend on it still run, and that the dispatch still reports success with the failed step names. The 2026-09-15 00:01Z run logged only 'assessment run failed' for a market-data 429 raised inside multiTimeframeScan, and the per-algo record — which needs nothing from the scan — was abandoned with it. Scoped doubles: the market-data layer, the schema/resolver helpers and the pool, all OUTSIDE this boundary; the vendor rate-limit boundary itself is proven for real in tests/unit/trading-market-data-rate-limit.spec.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppContext } from '../../src/app/composition-root';
import type { ScheduleRecord } from '../../src/features/scheduling';

/** Captured log lines, by level — the assertion surface of this guard. */
const logs = vi.hoisted(() => ({ info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] }));

/** Which stage the rig makes fail for the case under test. */
const rig = vi.hoisted(() => ({ scanFails: false, perAlgoFails: false }));

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({
    info: (...a: unknown[]) => { logs.info.push(a); },
    warn: (...a: unknown[]) => { logs.warn.push(a); },
    error: (...a: unknown[]) => { logs.error.push(a); },
    debug: () => { /* unused */ },
  }),
}));

vi.mock('@/features/trading', () => ({
  marketDataConfigured: () => true,
  DEFAULT_UNIVERSE: ['AAPL'],
  multiTimeframeScan: async () => {
    if (rig.scanFails) throw new Error('too many requests.');
    return new Map([['AAPL', {
      symbol: 'AAPL', price: 100, action: 'buy', side: 'buy',
      score: 0.5, confidence: 0.6, regime: 0.4, perTimeframe: [], rationale: 'spec',
    }]]);
  },
  barsBatch: async () => {
    if (rig.perAlgoFails) throw new Error('too many requests.');
    return new Map([['AAPL', Array.from({ length: 40 }, (_, i) => 100 + i)]]);
  },
  barsBatchOhlcv: async () => new Map(),
  scoreSymbol: () => [{ algo: 'momentum', dir: 'up', confidence: 0.5, basis: 'spec' }],
  scoreSymbolShadow: () => [],
  deriveWorldMasses: () => [],
  gravity2Signal: () => null,
  defaultGravity2Config: () => ({ windowDays: 7 }),
}));

vi.mock('../../src/app/trading-engine', () => ({
  ensureTradingSchema: async () => { /* schema is present in this rig */ },
  resolveMaturedPredictions: async () => 3,
}));

vi.mock('@/features/world-data', () => ({ createWorldIntelligenceService: () => null }));
vi.mock('../../src/app/trading-world-masses', () => ({ readGravityWorldSnapshots: async () => new Map() }));

const { dispatchTradingAssess } = await import('../../src/app/trading-assess-dispatch');

/** Every SQL statement the dispatch issued, for the "did this step still run" assertions. */
let sql: Array<{ text: string; params: unknown[] }> = [];
/** Tickets the dispatch asked for. */
let tickets: unknown[] = [];

/** A context whose pool records statements instead of reaching a database. */
function makeCtx(): AppContext {
  return {
    pool: { query: async (text: string, params: unknown[] = []) => { sql.push({ text, params }); return { rows: [] }; } },
    ticketService: { createTicket: async (t: unknown) => { tickets.push(t); return { id: 'spec-ticket' }; } },
  } as unknown as AppContext;
}

/** The due assessment schedule. */
function schedule(): ScheduleRecord {
  return { id: 'sched-assess-1', taskData: { userSub: 'spec-user', mode: 'paper' } } as unknown as ScheduleRecord;
}

/** The ERROR lines the dispatch emitted, as {step, message} pairs. */
function errorSteps(): Array<{ step: string; message: string }> {
  return logs.error.map((a) => ({
    step: String((a[0] as { step?: string })?.step ?? ''),
    message: String(a[1] ?? ''),
  }));
}

/** True when any recorded statement inserted a prediction for `algo`. */
function insertedAlgo(algo: string): boolean {
  return sql.some((s) => s.text.includes('oshal_trading_predictions') && (s.params.includes(algo) || s.text.includes(`'${algo}'`)));
}

describe('the assessment attributes a failure to its step, not to the whole run', () => {
  beforeEach(() => {
    logs.info.length = 0; logs.warn.length = 0; logs.error.length = 0;
    rig.scanFails = false; rig.perAlgoFails = false;
    sql = []; tickets = [];
  });

  it('names the scan step and still records the per-algo detail when the scan is rate limited', async () => {
    // The 2026-09-15 shape: the market-data vendor refuses the scan's batch.
    rig.scanFails = true;

    const result = await dispatchTradingAssess(makeCtx(), schedule());

    expect(errorSteps()).toContainEqual({ step: 'multi-timeframe-scan', message: 'assessment step failed' });
    // The old line named the run for one step's failure; nothing may emit it any more.
    expect(errorSteps().map((e) => e.message)).not.toContain('assessment run failed');
    // The per-algo record needs nothing from the scan, so it must still have happened.
    expect(insertedAlgo('momentum')).toBe(true);
    // One step failing is not a failed run — the schedule reports what it lost, by name.
    expect(result.success).toBe(true);
    expect(result.error).toContain('multi-timeframe-scan');
  });

  it('names the per-algo step and keeps the session predictions when that step is rate limited', async () => {
    rig.perAlgoFails = true;

    const result = await dispatchTradingAssess(makeCtx(), schedule());

    expect(errorSteps()).toContainEqual({ step: 'per-algo-predictions', message: 'assessment step failed' });
    // The session's ensemble prediction and its plan ticket are unaffected.
    expect(sql.some((s) => s.text.includes("'mtf-assess'"))).toBe(true);
    expect(tickets).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.error).toContain('per-algo-predictions');
  });

  it('reports a clean run with no failed steps', async () => {
    const result = await dispatchTradingAssess(makeCtx(), schedule());

    expect(logs.error).toHaveLength(0);
    expect(insertedAlgo('momentum')).toBe(true);
    expect(sql.some((s) => s.text.includes("'mtf-assess'"))).toBe(true);
    expect(tickets).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
