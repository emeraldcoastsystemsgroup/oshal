/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Tier-1 RLS for lazy app-store tables (A1.2 follow-up): asserts every lazy in-app DDL chokepoint that creates a migration-060-listed table also executes ENABLE/FORCE ROW LEVEL SECURITY + the create-if-absent owner_or_operator policy DO block, so a fresh database never has one of these tables policy-less.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The recording pool now answers `connect()` as well as `query()`. The trading bootstraps moved onto the advisory-lock path, which takes ONE client and issues every statement on it, so a pool that only implemented `query` failed these two cases with `pool.connect is not a function` rather than on anything about RLS. The client records into the same array, so the assertions below still read the real statement ORDER; BEGIN/SAVEPOINT/COMMIT are recorded alongside and ignored by the exact-match lookups.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Content chokepoint: ensureContentSchema must apply the tier-1 owner policy to oshal_social_signal_subscriptions and oshal_social_signal_deliveries after their CREATEs, and must converge the delivery audit columns before the policy is attached. Neither table is in migration 060, so this chokepoint is the only place they are secured.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { ensureContentSchema } from '../../src/app/routes/content-routes';
import { ensureTvRevocationSchema } from '../../src/app/routes/tv-pairing-routes';
import { ensureEquityGuardTable } from '../../src/app/trading-equity-guard';
import { ensurePeaksTable } from '../../src/app/trading-peaks-store';

/** Records every statement a schema-ensure function executes, in order. */
function recordingPool(): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const record = async (sql: unknown) => {
    const text = typeof sql === 'string' ? sql : String((sql as { text?: string })?.text ?? '');
    statements.push(text);
    return { rows: [] };
  };
  // `connect` matters: a bootstrap that names an advisory lock key runs its statements on ONE
  // checked-out client, so the sequence this spec reads arrives through the client, not the pool.
  const pool = {
    query: record,
    async connect() {
      return { query: record, release() { /* nothing to return to a fake pool */ } };
    },
  } as unknown as Pool;
  return { pool, statements };
}

/**
 * Asserts the recorded statement sequence applies the canonical tier-1 owner
 * RLS shape (migration 060 / buildOwnerRlsPolicyStatements) for `table`,
 * AFTER the table's CREATE so ALTER TABLE can never hit a missing relation.
 */
function expectOwnerRls(statements: string[], table: string, ownerColumn = 'user_sub'): void {
  const createIdx = statements.findIndex((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  expect(createIdx, `${table} CREATE TABLE IF NOT EXISTS`).toBeGreaterThanOrEqual(0);

  const enableIdx = statements.indexOf(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  const forceIdx = statements.indexOf(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  expect(enableIdx, `${table} ENABLE ROW LEVEL SECURITY`).toBeGreaterThan(createIdx);
  expect(forceIdx, `${table} FORCE ROW LEVEL SECURITY`).toBeGreaterThan(createIdx);

  // The policy is created via an idempotent create-if-absent DO block (never
  // drop/recreate — a re-run must not open an RLS-on/no-policy deny-all window).
  const doBlock = statements.find((s) => s.includes(`CREATE POLICY ${table}_owner_or_operator ON ${table}`));
  expect(doBlock, `${table} owner_or_operator policy DO block`).toBeTruthy();
  expect(doBlock).toContain('DO $$');
  expect(doBlock).toContain('IF NOT EXISTS');
  expect(doBlock).toContain('FROM pg_policy');
  expect(doBlock).toContain(`${ownerColumn} = current_setting('oshal.current_sub', true)`);
  expect(doBlock).toContain(`current_setting('oshal.is_operator', true) = 'on'`);
  expect(doBlock).toContain('WITH CHECK');
}

let savedBootstrap: string | undefined;

beforeEach(() => {
  // Force apply-mode so runRuntimeSchemaBootstrap executes (not just validates) statements.
  savedBootstrap = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
});

afterEach(() => {
  if (savedBootstrap === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
  else process.env.OSHAL_SCHEMA_BOOTSTRAP = savedBootstrap;
});

describe('lazy app-store DDL chokepoints apply tier-1 RLS (A1.2 follow-up)', () => {
  // (Finance chokepoint removed: finance carved to the app store, ADR-085 —
  //  the packaged route carries the identical ensureFinanceSchema + RLS for all 3 tables.)

  // (Payments chokepoint removed: payments carved to the app store, ADR-085 —
  //  the packaged route carries the identical ensurePaymentsSchema + RLS.)

  // (Kid Lens chokepoint removed: youtube-kids carved to the app store, ADR-085 —
  //  the packaged route carries the identical ensureYoutubeKidsSchema + RLS.)

  it('trading equity guard: oshal_trading_equity_hwm', async () => {
    const { pool, statements } = recordingPool();
    await ensureEquityGuardTable(pool);
    expectOwnerRls(statements, 'oshal_trading_equity_hwm');
  });

  it('trading peaks store: oshal_trading_peaks', async () => {
    const { pool, statements } = recordingPool();
    await ensurePeaksTable(pool);
    expectOwnerRls(statements, 'oshal_trading_peaks');
  });

  it('content routes: social signal subscriptions and deliveries', async () => {
    const { pool, statements } = recordingPool();
    await ensureContentSchema(pool);
    expectOwnerRls(statements, 'oshal_social_signal_subscriptions');
    expectOwnerRls(statements, 'oshal_social_signal_deliveries');
    // The audit columns carry the owner the policy reads, so they must exist before it is attached.
    const policyIdx = statements.indexOf('ALTER TABLE oshal_social_signal_deliveries ENABLE ROW LEVEL SECURITY');
    for (const column of ['user_sub', 'bot_agent_id', 'channel', 'correlation_id']) {
      const alterIdx = statements.indexOf(`ALTER TABLE oshal_social_signal_deliveries ADD COLUMN IF NOT EXISTS ${column} TEXT`);
      expect(alterIdx, `deliveries ADD COLUMN ${column}`).toBeGreaterThanOrEqual(0);
      expect(alterIdx, `deliveries ${column} converges before RLS`).toBeLessThan(policyIdx);
    }
  });

  it('tv pairing: creates tv_token_revocations (only fresh-deploy creation path) with RLS', async () => {
    const { pool, statements } = recordingPool();
    await ensureTvRevocationSchema(pool);
    // The docker/postgres migration file is not wired into any automated runner,
    // so this chokepoint must both CREATE the table and secure it.
    expect(statements.some((s) => s.includes('CREATE TABLE IF NOT EXISTS tv_token_revocations'))).toBe(true);
    expectOwnerRls(statements, 'tv_token_revocations');
  });
});
