/**
 * Trading signal weights — the overnight-learned MASS + PROXIMITY per signal (algo).
 *
 * The gravity model treats each signal as a mass that pulls price; a signal that has actually been
 * predictive should pull harder (more MASS) and recent reliability should count more (PROXIMITY).
 * The overnight review (trading-review-dispatch) scores each algo's hit-rate from the resolved
 * predictions ledger and writes its learned mass + proximity here; the live multi-timeframe ensemble
 * loads the masses so proven algos weigh more in every vote. Empty table = every algo weight 1 (raw
 * engine) — so this is purely additive and self-tuning.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-algo learned mass/proximity store (load masses for the ensemble, upsert from the overnight review).
 *
 * @module trading-signal-weights
 */

import type { AppContext } from './composition-root';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** A learned weight row for one signal/algo. `expectancy` is the avg signed return % per fire (the
 *  P&L-aware edge; 0 when learned from hit-rate). */
export interface SignalWeight { algo: string; mass: number; proximity: number; hitRate: number; samples: number; expectancy: number; }

/** @description True when the live ensemble should weight by mass × PROXIMITY (recency), not mass alone.
 *  Off by default — flip on to let a recently-cold signal fade before its long-run mass drifts. */
export function useProximityEnabled(): boolean {
  return String(process.env.TRADING_USE_PROXIMITY ?? 'false').toLowerCase() === 'true';
}
/** @description True when the overnight review should learn mass/proximity from realized P&L EXPECTANCY
 *  (avg signed return) instead of bare hit-rate. Off by default. */
export function learnExpectancyEnabled(): boolean {
  return String(process.env.TRADING_LEARN_EXPECTANCY ?? 'false').toLowerCase() === 'true';
}

/** Ensure the signal-weights table exists (self-healing). */
export async function ensureSignalWeightsTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading signal weights',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_signal_weights (
        algo TEXT PRIMARY KEY,
        mass NUMERIC(6,3) NOT NULL DEFAULT 1,
        proximity NUMERIC(6,3) NOT NULL DEFAULT 1,
        hit_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
        samples INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      // Self-healing: the avg signed-return % the mass was learned from (P&L expectancy mode).
      'ALTER TABLE oshal_trading_signal_weights ADD COLUMN IF NOT EXISTS expectancy NUMERIC(8,4) NOT NULL DEFAULT 0',
    ],
    requirements: [{ table: 'oshal_trading_signal_weights', columns: ['algo', 'mass', 'proximity', 'hit_rate', 'samples', 'expectancy', 'updated_at'] }],
  });
}

/**
 * @description Load the learned per-algo weights for the ensemble (algo → weight). Returns {} on any
 * miss so the engine falls back to equal weights. With TRADING_USE_PROXIMITY the weight is
 * mass × proximity (recency-aware); otherwise mass alone (the prior behaviour).
 * @param pool - Postgres pool.
 * @returns Record of algo → learned weight.
 */
export async function loadAlgoMasses(pool: AppContext['pool']): Promise<Record<string, number>> {
  try {
    await ensureSignalWeightsTable(pool);
    const useProx = useProximityEnabled();
    const rows = (await pool.query(`SELECT algo, mass${useProx ? ', proximity' : ''} FROM oshal_trading_signal_weights`)).rows;
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.algo)] = useProx ? Number(r.mass) * Number(r.proximity) : Number(r.mass);
    return out;
  } catch { return {}; }
}

/** Read the full learned-weights table (for the review summary + reporting). */
export async function loadSignalWeights(pool: AppContext['pool']): Promise<SignalWeight[]> {
  await ensureSignalWeightsTable(pool);
  return (await pool.query('SELECT algo, mass, proximity, hit_rate, samples, expectancy FROM oshal_trading_signal_weights ORDER BY mass DESC')).rows
    .map((r) => ({ algo: String(r.algo), mass: Number(r.mass), proximity: Number(r.proximity), hitRate: Number(r.hit_rate), samples: Number(r.samples), expectancy: Number(r.expectancy) }));
}

/** Upsert one algo's learned mass + proximity (+ the expectancy it was learned from). */
export async function upsertSignalWeight(pool: AppContext['pool'], w: SignalWeight): Promise<void> {
  await ensureSignalWeightsTable(pool);
  await pool.query(
    `INSERT INTO oshal_trading_signal_weights (algo, mass, proximity, hit_rate, samples, expectancy, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (algo) DO UPDATE SET mass=EXCLUDED.mass, proximity=EXCLUDED.proximity, hit_rate=EXCLUDED.hit_rate, samples=EXCLUDED.samples, expectancy=EXCLUDED.expectancy, updated_at=now()`,
    [w.algo, w.mass, w.proximity, w.hitRate, w.samples, w.expectancy]);
}
