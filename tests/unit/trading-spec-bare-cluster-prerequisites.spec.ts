/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The guard for the trading DB specs' PROLOGUE on an empty server. Once the schema bootstrap stopped racing, the trading set still was not green on a bare cluster: three files died in beforeAll with 42P01 on a table their own prologue never created, because every prologue had been written against the operator's already-built database where a forgotten ensure* is invisible. trading-books-schema and trading-settlement seed an account through the REAL envelope path and never called ensureDekSchema (oshal_user_deks); trading-dispatch-golden-plan sweeps trading_config_overrides before the first fire that creates it. This spec starts its own PostgreSQL, runs the shared prologue against the EMPTY database, and asserts every relation the specs touch is there afterwards - then exercises the two paths that actually failed, so the assertion is a product call and not a catalogue lookup. It also pins that the three specs USE the shared prologue: a helper nobody calls would make the rest of this file vacuous.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { encryptToken, decryptToken } from '../../src/app/routes/connector-token-crypto';
import {
  TRADING_SPEC_RELATIONS, ensureTradingSpecSchema, missingTradingSpecRelations,
} from '../helpers/trading-spec-schema';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// EMPTY on purpose — the defect this guards only exists on a cluster nothing has built yet.
const database = new DisposablePostgres({
  purpose: 'trading-spec-prereq',
  database: 'trading_fixture',
  memory: '384m',
  max: 8,
  connectionTimeoutMillis: 60_000,
  statementTimeoutMs: 120_000,
  options: '-c row_security=off',
});

/** The spec files that must take the shared prologue rather than hand-roll their own. */
const CONVERGED_SPECS = [
  'trading-books-schema.spec.ts',
  'trading-settlement.spec.ts',
  'trading-dispatch-golden-plan.spec.ts',
];

const SUB = 'spec-bare-cluster-prereq';
let pool: Pool;

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'spec-secret-bare-cluster-prereq';
  pool = await database.start();
}, 180_000);

afterAll(async () => {
  await database.stop();
});

describe('the trading DB specs bootstrap everything they touch on a BARE cluster', () => {
  it('the prologue leaves every relation the specs touch behind, starting from an empty database', async () => {
    // Nothing built it yet: the missing list is the whole list, which is what makes the
    // assertion after the prologue mean something.
    expect(TRADING_SPEC_RELATIONS.length,
      'the relation list was emptied; every assertion in this file would pass vacuously').toBeGreaterThan(10);
    expect(await missingTradingSpecRelations(pool)).toEqual([...TRADING_SPEC_RELATIONS]);

    await ensureTradingSpecSchema(pool);

    expect(await missingTradingSpecRelations(pool),
      'the shared prologue did not create these — a spec that writes to one dies 42P01 in beforeAll '
      + 'on any database that was not already built').toEqual([]);
  }, 300_000);

  it('the envelope path a book account is seeded through works on it — the oshal_user_deks failure', async () => {
    // trading-books-schema / trading-settlement seed through exactly this call. Without
    // ensureDekSchema in the prologue it throws 'connector-token-crypto: DEK path failed'.
    const blob = await encryptToken(pool as never, SUB, '9123456789');
    expect(blob.startsWith('v2:') || blob.startsWith('k2:'),
      'the account number must be stored as an envelope blob, never plaintext').toBe(true);
    expect(await decryptToken(pool as never, SUB, blob)).toBe('9123456789');
    await pool.query('DELETE FROM oshal_user_deks WHERE user_sub = $1', [SUB]);
  }, 120_000);

  it('the golden-plan residue sweep reads trading_config_overrides instead of failing 42P01', async () => {
    // The exact query trading-dispatch-golden-plan runs in beforeAll, before any fire has created
    // the table lazily. On a bare cluster without ensureOverridesSchema this is 42P01.
    const { rows } = await pool.query(
      `SELECT DISTINCT user_sub FROM trading_config_overrides WHERE user_sub LIKE 'spec-golden-%'`);
    expect(rows).toEqual([]);
  }, 120_000);

  it('the three specs take the shared prologue — otherwise this file guards a helper nobody calls', () => {
    const missing = CONVERGED_SPECS.filter((name) => {
      const source = readFileSync(join(__dirname, name), 'utf8');
      return !/ensureTradingSpecSchema/.test(source) || !/helpers\/trading-spec-schema/.test(source);
    });
    expect(missing,
      'these trading DB specs no longer import the shared prologue, so nothing proves THEIR '
      + 'bootstrap is complete on a bare cluster — import ensureTradingSpecSchema or extend this '
      + 'guard to cover whatever replaced it').toEqual([]);
  });
});
