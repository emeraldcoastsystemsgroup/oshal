/**
 * Trading equity guard — the account-level drawdown circuit breaker's persistence.
 *
 * Tracks each book's equity high-water mark across fires (its own tiny table, NOT the per-symbol
 * peaks store which is overwritten every cycle). On each autopilot fire the dispatch reports current
 * equity here; if it has fallen maxDrawdownPct below the high-water mark, new entries are halted
 * (exits still run) until equity recovers. This catches a sustained bleed the per-trade stops and the
 * intraday daily-loss halt don't — the last-resort protection layer.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-(user,mode) equity high-water-mark store + drawdown-halt evaluation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Tier-1 RLS at the lazy-DDL chokepoint (A1.2 follow-up): ensureEquityGuardTable now appends buildOwnerRlsPolicyStatements for oshal_trading_equity_hwm so a fresh database is never left policy-less between table creation and a migration-060 re-run.
 *
 * @module trading-equity-guard
 */

import type { AppContext } from './composition-root';
import { drawdownHaltTriggered, type RiskPolicy, type TradingMode } from '@/features/trading';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** Ensure the equity high-water-mark table exists (self-healing, like the trading schema). */
export async function ensureEquityGuardTable(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading equity guard',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_equity_hwm (
        user_sub TEXT NOT NULL, mode TEXT NOT NULL,
        high_water_mark NUMERIC(18,2) NOT NULL DEFAULT 0,
        last_equity NUMERIC(18,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_sub, mode)
      )`,

      /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
         fresh database enforces isolation the moment this table is created,
         instead of waiting for migration 060 to re-run (it skips absent tables).
         Inert while the runtime connects as a superuser role. ─────────────── */
      ...buildOwnerRlsPolicyStatements('oshal_trading_equity_hwm', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_equity_hwm', columns: ['user_sub', 'mode', 'high_water_mark', 'last_equity', 'updated_at'] }],
  });
}

/** The drawdown-guard verdict for a fire. */
export interface EquityGuard { halted: boolean; drawdownPct: number; highWaterMark: number; }

/**
 * @description Record current equity, roll the high-water mark forward, and decide whether the
 * account-drawdown circuit breaker should halt NEW entries this fire.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper|live).
 * @param equity - Current account equity.
 * @param policy - Active risk policy (maxDrawdownPct).
 * @returns The guard verdict (halted + the drawdown % + the high-water mark).
 */
export async function evaluateEquityGuard(pool: AppContext['pool'], sub: string, mode: TradingMode, equity: number, policy: RiskPolicy): Promise<EquityGuard> {
  await ensureEquityGuardTable(pool);
  const prior = (await pool.query('SELECT high_water_mark FROM oshal_trading_equity_hwm WHERE user_sub=$1 AND mode=$2', [sub, mode])).rows[0];
  const hwm = Math.max(Number(prior?.high_water_mark || 0), equity);
  await pool.query(
    `INSERT INTO oshal_trading_equity_hwm (user_sub, mode, high_water_mark, last_equity, updated_at)
       VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (user_sub, mode) DO UPDATE SET high_water_mark=EXCLUDED.high_water_mark, last_equity=EXCLUDED.last_equity, updated_at=now()`,
    [sub, mode, hwm, equity]);
  const halted = drawdownHaltTriggered(equity, hwm, policy);
  const drawdownPct = hwm > 0 ? ((hwm - equity) / hwm) * 100 : 0;
  return { halted, drawdownPct, highWaterMark: hwm };
}
