/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the PAT-store boot bootstrap: it must take ONE advisory-locked client instead of eight separate pool acquires, and its failure handler must report an impact it has PROBED rather than one it assumed. The old handler hardcoded "PAT auth unavailable until it exists" on every failure; the table is created by migration 100 before the server starts, so that line described a functional loss that had not happened and sent a reader after a bug that did not exist. These cases drive the real ensureCliTokenSchema / createCliTokenRoutes wiring, the real runRuntimeSchemaBootstrap and applyLockedSchema, and the real request-identity sentinel. The pg driver is the ONE scoped double, because the quantity under test is how many clients this code asks the pool for and which statements it issues after a failure - not anything PostgreSQL decides. It is therefore not evidence about RLS, the policy boundary, or that a PAT authenticates.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The branch decision IS a log line, so it has to be observable. Same capture shape the other
// route specs use (see access-check-undetermined.spec.ts).
const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import type { Pool } from 'pg';
import { createCliTokenRoutes, ensureCliTokenSchema } from '../../src/app/routes/cli-token-routes';
import { SCHEMA_LOCK_KEYS } from '../../src/shared/services/database/schema-lock';
import {
  getRequestIdentity,
  isSystemIdentity,
} from '../../src/shared/services/database/request-identity';

/** A statement the fake driver recorded, with the bind parameters it carried. */
interface Recorded { text: string; params?: unknown[] }

interface FakePool {
  /** Statements issued straight at the pool - each one is its own acquire in pg. */
  poolQueries: Recorded[];
  /** Statements issued on a checked-out client. */
  clientQueries: Recorded[];
  connects: number;
  releases: number;
  /** True for each re-probe that ran under the SYSTEM identity sentinel. */
  probeIdentities: boolean[];
  probeCount: number;
  asPool: Pool;
}

const PROBE = /to_regclass/;

/**
 * @description Builds a recording stand-in for a pg Pool.
 * @param options.failStatement - DDL matching this throws a non-privilege error, as a saturated
 * pool does on a cold boot (SQLSTATE 53300), which is the failure this entry is about.
 * @param options.probe - how the post-failure table re-probe is answered.
 * @returns the recorder plus the object to hand to production code.
 */
function makeFakePool(options: {
  failStatement?: RegExp;
  probe?: 'present' | 'absent' | 'throws';
  /** Columns the probe reports MISSING — the ALTERs that add them belong to the failed bootstrap. */
  missingColumns?: string[];
} = {}): FakePool {
  const state: FakePool = {
    poolQueries: [], clientQueries: [], connects: 0, releases: 0,
    probeIdentities: [], probeCount: 0, asPool: undefined as unknown as Pool,
  };

  const answer = (text: string, params: unknown[] | undefined) => {
    if (PROBE.test(text)) {
      state.probeCount += 1;
      state.probeIdentities.push(isSystemIdentity(getRequestIdentity()));
      if (options.probe === 'throws') {
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      }
      return {
        rows: [{ present: options.probe === 'present', missing: options.missingColumns ?? null }],
        rowCount: 1,
      };
    }
    if (options.failStatement?.test(text)) {
      throw Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    }
    return { rows: [], rowCount: 0 };
  };

  state.asPool = {
    query: async (text: string, params?: unknown[]) => {
      state.poolQueries.push({ text, params });
      return answer(text, params);
    },
    connect: async () => {
      state.connects += 1;
      return {
        query: async (text: string, params?: unknown[]) => {
          state.clientQueries.push({ text, params });
          return answer(text, params);
        },
        release: () => { state.releases += 1; },
      };
    },
  } as unknown as Pool;

  return state;
}

/** Waits for the fire-and-forget failure handler to emit its one line. */
async function waitForBootstrapReport(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (logSpies.warn.mock.calls.length + logSpies.error.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the bootstrap failure was never reported - no warn and no error was logged');
}

/** The message argument of the single line the handler emitted. */
function reportedMessage(): string {
  const calls = [...logSpies.error.mock.calls, ...logSpies.warn.mock.calls];
  expect(calls).toHaveLength(1);
  return String(calls[0][1]);
}

describe('oshal_cli_tokens schema bootstrap', () => {
  beforeEach(() => {
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    logSpies.info.mockClear();
    logSpies.debug.mockClear();
  });

  it('applies its DDL on ONE advisory-locked client, not eight separate pool acquires', async () => {
    const pool = makeFakePool();

    await ensureCliTokenSchema(pool.asPool);

    // The contention this entry names: eight idempotent statements, each taking its own 5 s pool
    // acquire against a pool of 8 while the manifests load. One checkout, one transaction.
    expect(pool.connects).toBe(1);
    expect(pool.poolQueries).toEqual([]);
    expect(pool.releases).toBe(1);

    const texts = pool.clientQueries.map((q) => q.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain('pg_advisory_xact_lock');
    expect(pool.clientQueries[1].params).toEqual([SCHEMA_LOCK_KEYS.cliTokens]);
    expect(texts[texts.length - 1]).toBe('COMMIT');

    // A key of its own, so the PAT store does not serialize against an unrelated bootstrap.
    expect(SCHEMA_LOCK_KEYS.cliTokens).toBe(47110008);
    const others = Object.entries(SCHEMA_LOCK_KEYS).filter(([name]) => name !== 'cliTokens');
    expect(others.map(([, key]) => key)).not.toContain(SCHEMA_LOCK_KEYS.cliTokens);

    // Every statement still runs, and the per-boot RLS/policy re-assert is NOT retired - that is
    // the trap the entry calls out about replacing the DDL with a verify-first early return.
    const ddl = texts.filter((t) => /^\s*(CREATE|ALTER|DO)\b/i.test(t));
    expect(ddl).toHaveLength(8);
    expect(ddl.some((t) => /ENABLE ROW LEVEL SECURITY/.test(t))).toBe(true);
    expect(ddl.some((t) => /FORCE ROW LEVEL SECURITY/.test(t))).toBe(true);
    expect(ddl.some((t) => /CREATE POLICY oshal_cli_tokens_owner_or_operator/.test(t))).toBe(true);
  });

  it('warns that PAT auth is unaffected when the bootstrap fails and the table is present', async () => {
    const pool = makeFakePool({
      failStatement: /CREATE TABLE IF NOT EXISTS oshal_cli_tokens/,
      probe: 'present',
    });

    createCliTokenRoutes(pool.asPool);
    await waitForBootstrapReport();

    // It looked, before it said anything.
    expect(pool.probeCount).toBe(1);
    // The probe runs on the trusted pre-identity sentinel; an identity-less read is refused
    // outright under OSHAL_DB_GUC_STRICT=deny, which would make every failure "unverifiable".
    expect(pool.probeIdentities).toEqual([true]);

    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);
    const message = reportedMessage();
    expect(message).toContain('oshal_cli_tokens schema bootstrap failed');
    expect(message).toMatch(/unaffected/i);
    // The claim that cost a day: never assert this impact when the table is right there.
    expect(message).not.toMatch(/unavailable until it exists/);
  });

  it('refuses to call PAT auth unaffected when the table is missing columns PAT auth reads', async () => {
    // The table existing is not the claim. findLiveCliToken selects node_client_id and
    // principal_issuer, and those arrive in ALTER statements belonging to this very bootstrap — so
    // on a database that never ran migration 102 the table is present and PAT auth is broken.
    const pool = makeFakePool({
      failStatement: /ALTER TABLE oshal_cli_tokens/,
      probe: 'present',
      missingColumns: ['node_client_id', 'principal_issuer'],
    });

    createCliTokenRoutes(pool.asPool);
    await waitForBootstrapReport();

    expect(pool.probeCount).toBe(1);
    expect(logSpies.warn).not.toHaveBeenCalled();
    expect(logSpies.error).toHaveBeenCalledTimes(1);
    const message = reportedMessage();
    expect(message).toMatch(/missing columns PAT auth reads/);
    expect(message).toMatch(/WILL fail/);
    // The exact regression: this is the branch that used to say the opposite.
    expect(message).not.toMatch(/unaffected/i);
    // And the columns are named, so the reader does not have to go looking.
    const payload = logSpies.error.mock.calls[0][0] as { missing?: string[] };
    expect(payload.missing).toEqual(['node_client_id', 'principal_issuer']);
  });

  it('errors with the unavailable wording only after probing and finding the table absent', async () => {
    const pool = makeFakePool({
      failStatement: /CREATE TABLE IF NOT EXISTS oshal_cli_tokens/,
      probe: 'absent',
    });

    createCliTokenRoutes(pool.asPool);
    await waitForBootstrapReport();

    expect(pool.probeCount).toBe(1);
    expect(logSpies.warn).not.toHaveBeenCalled();
    expect(logSpies.error).toHaveBeenCalledTimes(1);
    expect(reportedMessage()).toMatch(/unavailable until it exists/);
  });

  it('names the uncertainty, and claims no impact, when the re-probe itself cannot answer', async () => {
    const pool = makeFakePool({
      failStatement: /CREATE TABLE IF NOT EXISTS oshal_cli_tokens/,
      probe: 'throws',
    });

    createCliTokenRoutes(pool.asPool);
    await waitForBootstrapReport();

    expect(pool.probeCount).toBe(1);
    expect(logSpies.error).toHaveBeenCalledTimes(1);
    const message = reportedMessage();
    expect(message).toMatch(/could not|unverified/i);
    expect(message).not.toMatch(/unavailable until it exists/);
    expect(message).not.toMatch(/unaffected/i);
    // Both the bootstrap failure and the probe failure are carried, so the next reader has the
    // two facts the wording deliberately refuses to turn into a conclusion.
    const payload = logSpies.error.mock.calls[0][0] as { err?: unknown; probeErr?: unknown };
    expect(payload.err).toBeInstanceOf(Error);
    expect(payload.probeErr).toBeInstanceOf(Error);
  });
});
