/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ONE prologue for the trading DB specs, because each of them had written its own against a database that was ALREADY built. On the operator box every table exists before the spec starts, so a prologue that forgets one is invisible; on the disposable PostgreSQL those specs are supposed to run against now, the forgotten table is a 42P01 in beforeAll. Three files failed that way on a bare cluster: trading-books-schema and trading-settlement seed an account through the REAL envelope path (encryptToken -> getUserDek -> oshal_user_deks) and never called ensureDekSchema, and trading-dispatch-golden-plan sweeps trading_config_overrides before the first fire that would have created it. The fix is not three more ensure lines: it is one list, so the guard beside it (trading-spec-bare-cluster-prerequisites.spec.ts) can prove on an EMPTY server that the prologue produces every relation the specs touch, and a fourth spec inherits that instead of rediscovering it.
 */

import type { Pool } from 'pg';
import { ensureAccountsSchema } from '../../src/app/trading-accounts-store';
import { ensureBooksSchema } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import { ensureEquityGuardTable } from '../../src/app/trading-equity-guard';
import { ensureGateBlockTable } from '../../src/app/trading-gate-block-store';
import { ensurePeaksTable } from '../../src/app/trading-peaks-store';
import { ensureDailyEquityTable } from '../../src/app/trading-daily-equity-store';
import { ensureRotationStateTable } from '../../src/app/trading-rotation-store';
import { ensurePinnedLotsSchema } from '../../src/app/trading-pinned-lots';
import { ensureOverridesSchema } from '../../src/app/trading-config-overrides';
import { ensureDekSchema } from '../../src/app/routes/connector-token-crypto';

/**
 * The bootstraps a trading DB spec needs, in dependency order: books first (it owns
 * `oshal_trading_book_id_fill()`, which six sibling stores arm a trigger on), then the stores, then
 * the two OUTSIDE `src/app/trading-*` that the specs reach through product code rather than by
 * name — the profile overrides the dispatch fire reads, and the per-user DEK table the envelope
 * path writes. Those two are the ones every hand-written prologue forgot.
 */
const BOOTSTRAPS: ReadonlyArray<readonly [string, (pool: never) => Promise<unknown>]> = [
  ['trading-books-store.ensureBooksSchema', ensureBooksSchema as (pool: never) => Promise<unknown>],
  ['trading-accounts-store.ensureAccountsSchema', ensureAccountsSchema as (pool: never) => Promise<unknown>],
  ['trading-engine.ensureTradingSchema', ensureTradingSchema as (pool: never) => Promise<unknown>],
  ['trading-equity-guard.ensureEquityGuardTable', ensureEquityGuardTable as (pool: never) => Promise<unknown>],
  ['trading-gate-block-store.ensureGateBlockTable', ensureGateBlockTable as (pool: never) => Promise<unknown>],
  ['trading-peaks-store.ensurePeaksTable', ensurePeaksTable as (pool: never) => Promise<unknown>],
  ['trading-daily-equity-store.ensureDailyEquityTable', ensureDailyEquityTable as (pool: never) => Promise<unknown>],
  ['trading-rotation-store.ensureRotationStateTable', ensureRotationStateTable as (pool: never) => Promise<unknown>],
  ['trading-pinned-lots.ensurePinnedLotsSchema', ensurePinnedLotsSchema as (pool: never) => Promise<unknown>],
  ['trading-config-overrides.ensureOverridesSchema', ensureOverridesSchema as (pool: never) => Promise<unknown>],
  ['connector-token-crypto.ensureDekSchema', ensureDekSchema as (pool: never) => Promise<unknown>],
];

/**
 * Every relation {@link ensureTradingSpecSchema} must leave behind on an EMPTY server. Derived from
 * what the three converged specs read, write or DELETE from — including the two that are not
 * `oshal_trading_*` at all, which is exactly why they were missed. The guard asserts this list
 * against a bare PostgreSQL, so dropping a bootstrap from the list above turns it red.
 */
export const TRADING_SPEC_RELATIONS: readonly string[] = [
  'oshal_trading_accounts',
  'oshal_trading_books',
  'oshal_trading_signals',
  'oshal_trading_decisions',
  'oshal_trading_orders',
  'oshal_trading_equity_hwm',
  'oshal_trading_gate_blocks',
  'oshal_trading_peaks',
  'oshal_trading_daily_equity',
  'oshal_trading_rotation_state',
  'oshal_trading_pinned_lots',
  'trading_config_overrides',
  'oshal_user_deks',
];

/**
 * @description Run every lazy bootstrap a trading DB spec depends on against the spec's pool, in
 * dependency order. Idempotent and safe to call from several spec files at once — each trading
 * bootstrap holds `SCHEMA_LOCK_KEYS.trading` for the duration of its DDL.
 * @param pool - The spec's pool, pointed at a DISPOSABLE PostgreSQL (see spec-database-url.ts).
 * @returns Nothing; throws with the bootstrap's name when one fails, so a prologue failure names
 * the module rather than only a SQLSTATE.
 */
export async function ensureTradingSpecSchema(pool: Pool): Promise<void> {
  for (const [name, ensure] of BOOTSTRAPS) {
    try {
      await ensure(pool as never);
    } catch (error) {
      throw new Error(`trading spec prologue failed at ${name}: ${(error as Error).message}`, { cause: error });
    }
  }
}

/**
 * @description The relations of {@link TRADING_SPEC_RELATIONS} that do NOT exist in the database
 * behind `pool`. Uses `to_regclass`, so it answers for the connection's own search_path rather
 * than assuming `public`.
 * @param pool - A pool connected to the database under test.
 * @returns The missing relation names, in the order they are declared (empty when all are present).
 */
export async function missingTradingSpecRelations(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ relname: string; present: boolean }>(
    'SELECT relname, to_regclass(relname) IS NOT NULL AS present FROM unnest($1::text[]) AS relname',
    [TRADING_SPEC_RELATIONS as string[]],
  );
  const present = new Map(rows.map((row) => [row.relname, row.present]));
  return TRADING_SPEC_RELATIONS.filter((name) => !present.get(name));
}
