/**
 * Trading strategy parameters — the APPROVED tunable values the live (paper) engine reads.
 *
 * The nightly optimizer (trading-optimize-dispatch) only RECOMMENDS parameter changes; nothing here
 * is written until the operator approves a recommendation on the Tuning page. An empty table means
 * every param falls back to DEFAULT_STRATEGY_PARAMS — i.e. the engine behaves EXACTLY as it did before
 * this feature existed. Approved values are clamped to sane bounds so a bad write can't break trading.
 *
 * Mirrors the self-healing store pattern in trading-signal-weights.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — approved strategy-param store (load overlay onto defaults, clamped upsert) for the nightly optimizer + approval gate.
 *
 * @module trading-strategy-params
 */

import type { AppContext } from './composition-root';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { DEFAULT_STRATEGY_PARAMS, type StrategyParams } from '@/features/trading';

/** The params the optimizer may tune and the Tuning page may approve. */
export const TUNABLE_PARAMS: Array<keyof StrategyParams> = ['momentumSma', 'rsiLow', 'rsiHigh', 'donchianWindow', 'ensembleThreshold'];

/** Human labels for the UI / recommendation tickets. */
export const PARAM_LABELS: Record<keyof StrategyParams, string> = {
  momentumSma: 'Momentum SMA window',
  rsiLow: 'Mean-rev RSI oversold',
  rsiHigh: 'Mean-rev RSI overbought',
  donchianWindow: 'Donchian breakout window',
  ensembleThreshold: 'Ensemble action threshold',
};

/** Sane bounds per param — every approved/loaded value is clamped so the live engine stays valid. */
const BOUNDS: Record<keyof StrategyParams, { min: number; max: number; int: boolean }> = {
  momentumSma: { min: 5, max: 100, int: true },
  rsiLow: { min: 10, max: 49, int: true },
  rsiHigh: { min: 51, max: 90, int: true },
  donchianWindow: { min: 5, max: 100, int: true },
  ensembleThreshold: { min: 0.02, max: 0.6, int: false },
};

/** @description Narrow a string to a tunable param key. */
export function isTunableParam(p: string): p is keyof StrategyParams { return (TUNABLE_PARAMS as string[]).includes(p); }

/** @description Clamp a value into the param's valid range (and round integer params). */
export function clampParam(p: keyof StrategyParams, v: number): number {
  const b = BOUNDS[p];
  const x = Math.max(b.min, Math.min(b.max, Number(v)));
  return b.int ? Math.round(x) : Math.round(x * 10000) / 10000;
}

/** Ensure the param store exists (self-healing). */
export async function ensureStrategyParamsTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading strategy params',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_params (
        param TEXT PRIMARY KEY,
        value NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
    requirements: [{ table: 'oshal_trading_params', columns: ['param', 'value', 'updated_at'] }],
  });
}

/**
 * @description The approved strategy params, overlaid onto the defaults. Empty store = defaults
 * (today's behavior). Returns defaults on any error so trading never fails closed on a config read.
 */
export async function loadStrategyParams(pool: AppContext['pool']): Promise<StrategyParams> {
  try {
    await ensureStrategyParamsTable(pool);
    const rows = (await pool.query('SELECT param, value FROM oshal_trading_params')).rows;
    const out: StrategyParams = { ...DEFAULT_STRATEGY_PARAMS };
    for (const r of rows) { const k = String(r.param); if (isTunableParam(k)) out[k] = clampParam(k, Number(r.value)); }
    return out;
  } catch { return { ...DEFAULT_STRATEGY_PARAMS }; }
}

/** @description The current params plus the per-param updated_at (for the Tuning UI). */
export async function loadStrategyParamsDetailed(pool: AppContext['pool']): Promise<Array<{ param: keyof StrategyParams; label: string; value: number; isDefault: boolean; updatedAt: string | null }>> {
  const current = await loadStrategyParams(pool);
  const rows = (await pool.query('SELECT param, updated_at FROM oshal_trading_params')).rows as Array<{ param: string; updated_at: string }>;
  const updatedBy = new Map(rows.map((r) => [r.param, r.updated_at]));
  return TUNABLE_PARAMS.map((p) => ({
    param: p, label: PARAM_LABELS[p], value: current[p],
    isDefault: current[p] === DEFAULT_STRATEGY_PARAMS[p],
    updatedAt: updatedBy.get(p) ?? null,
  }));
}

/** @description Approve/write one param value (clamped). */
export async function upsertStrategyParam(pool: AppContext['pool'], param: keyof StrategyParams, value: number): Promise<void> {
  await ensureStrategyParamsTable(pool);
  await pool.query(
    `INSERT INTO oshal_trading_params (param, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (param) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [param, clampParam(param, value)]);
}
