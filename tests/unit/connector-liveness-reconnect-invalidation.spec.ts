/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — a reconnect must drop the memoised needs_reconnect answer. Crosses the real seam that broke: the real upsertConnection against the live Postgres, the real cache module, and the real /liveness handler.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it instead of taking an address from the environment at all. Refusing an unpointed run made the 2026-09-14 accident impossible, but it did so by making the file throw at IMPORT — `specDatabaseUrl` ran at module scope, so nothing in the repo set the variable, vitest reported a Failed Suite with ZERO cases executed, and the reconnect-invalidation guard has therefore never run in any gate. A guard that cannot run proves nothing: refusal is the right verdict for a dangerous address and still the wrong shape of answer, because it leaves the defect it guards unwatched. Owning the server removes the question — there is no value a caller can supply that would reach a deployment, and the DELETE-by-run-prefix teardown goes with it, since the whole container is destroyed and no cleanup SQL runs anywhere. No `roles:` is declared: every assertion here is about the process-local liveness memo, not about what a non-superuser may read, so a superuser-only fixture leaves nothing vacuous. No `migrations:` either: `ensureConnectionsSchema` + `ensureTenancySchema` are the runtime bootstrap that produces every column and partial unique index `upsertConnection` conflicts on.
 */

/**
 * Reconnect → liveness invalidation.
 *
 * The defect this guards: `GET /api/connect/liveness` memoises each probe for 15 minutes, and
 * nothing cleared that memo when a connection was rewritten. A successful reconnect therefore kept
 * answering `needs_reconnect` for the rest of the TTL, which from the operator's seat is
 * indistinguishable from the reconnect having failed — the reported symptom was "I can connect but
 * it never registers", on two unrelated providers at once.
 *
 * Boundary: the cache is process-local memory and the trigger is a DB write, so the guard runs the
 * REAL `upsertConnection` against a real PostgreSQL this file starts for itself, and the REAL
 * express handler over a real socket. Only the PROVIDER
 * transports are doubled — probing a real Schwab/Google grant from a test is neither possible nor
 * desirable. That is the seam that failed; the provider call is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Pool } from 'pg';
import { createConnectorLivenessRoutes, type LivenessDeps } from '@/app/routes/connector-liveness';
import { getCachedLiveness, resetConnectorLivenessCacheForTesting } from '@/app/routes/connector-liveness-cache';
import { upsertConnection, ensureTenancySchema, type ConnectionRow } from '@/app/routes/connector-tenancy';
import { ensureConnectionsSchema } from '@/app/routes/connectors-routes';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// No `roles:` — every claim below is about the in-process memo, not about what a non-superuser may
// read — and no `migrations:`, because the runtime bootstrap makes the whole connections schema.
const database = new DisposablePostgres({
  purpose: 'connector-liveness-reconnect-invalidation', database: 'connectors_fixture',
  memory: '256m', max: 4, statementTimeoutMs: 60_000,
});

/** Distinguishes this run's subs in any assertion message; nothing depends on it for cleanup now. */
const RUN = `zz-liveness-inv-${process.pid}-${Date.now()}`;
const SUB = `${RUN}-owner`;
const OTHER_SUB = `${RUN}-other`;
const PROVIDER = 'google';
const OTHER_PROVIDER = 'schwab';

let pool: Pool;

// The connections/tenancy DDL is idempotent but not free; run it ONCE for the file rather than
// per test, where it would compete with the default 5s case timeout.
beforeAll(async () => {
  pool = await database.start();
  await ensureConnectionsSchema(pool);
  await ensureTenancySchema(pool);
}, 120_000);

// No DELETE pass: the whole server goes away, so there is nothing to clean and nowhere to clean it.
afterAll(async () => { await database.stop(); });

beforeEach(() => resetConnectorLivenessCacheForTesting());

/**
 * @description Write one connection through the REAL upsert — the path a reconnect actually takes.
 * @param provider - provider slug to write.
 * @param userSub - the connecting caller.
 * @returns nothing
 */
async function reconnect(provider = PROVIDER, userSub = SUB): Promise<void> {
  await upsertConnection(pool, {
    userSub, userEmail: `${userSub}@example.com`, provider,
    accountEmail: `${userSub}@example.com`, accountId: `${userSub}-acct`, scopes: 'openid',
    encAccess: 'enc-access', encRefresh: 'enc-refresh', expiry: new Date(Date.now() + 3_600_000),
    connectedBySub: userSub,
  });
}

/**
 * @description A row shaped like the stored connection, for the doubled provider transports.
 * @param userSub - owner sub.
 * @param provider - provider slug.
 * @returns A populated connection row.
 */
function rowFor(userSub: string, provider: string): ConnectionRow {
  return {
    connection_id: `${userSub}-${provider}`, user_sub: userSub, connected_by_sub: userSub,
    tenant_id: null, provider, label: 'default', account_key: 'default', is_default: true,
    account_email: `${userSub}@example.com`, account_id: `${userSub}-acct`, scopes: 'openid',
    access_token: 'enc', refresh_token: 'enc-refresh',
    expiry: new Date(Date.now() + 3_600_000), created_at: new Date(),
  } as ConnectionRow;
}

/**
 * @description The real router with only the PROVIDER transports doubled. `getToken` rejects
 * exactly the way a dead grant does (`refresh 400`), which is what maps to needs_reconnect.
 * @param sub - the authenticated caller.
 * @param providers - providers the caller holds connections for.
 * @param onToken - what the provider does when a token is demanded.
 * @returns The express app plus a probe counter.
 */
function appWith(sub: string, providers: string[], onToken: () => Promise<string | null>) {
  let probes = 0;
  const deps: LivenessDeps = {
    listConnections: async () => providers.map((p) => rowFor(sub, p)),
    resolveRow: async (_p, userSub, provider) => rowFor(userSub, provider),
    getToken: async () => { probes += 1; return onToken(); },
    fetchAccount: async () => ({ email: null, id: null }),
  };
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub } };
    next();
  });
  app.use('/api/connect', createConnectorLivenessRoutes({ pool } as never, deps));
  return { app, probeCount: () => probes };
}

/**
 * @description Drive GET /api/connect/liveness through the real handler over a real socket.
 * @param app - the express app under test.
 * @returns The per-provider results the route answered.
 */
async function getLiveness(app: express.Express): Promise<Array<{ provider: string; status: string; cached: boolean }>> {
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/connect/liveness`);
    const body = await res.json() as { providers: Array<{ provider: string; status: string; cached: boolean }> };
    return body.providers;
  } finally {
    server.close();
  }
}

describe('a reconnect drops the memoised needs_reconnect answer', () => {
  it('re-probes after the real upsertConnection instead of serving the cached failure', async () => {
    // 1. The grant is dead: the probe fails and the answer is memoised.
    const dead = appWith(SUB, [PROVIDER], async () => { throw new Error('refresh 400'); });
    const first = await getLiveness(dead.app);
    expect(first[0]).toMatchObject({ provider: PROVIDER, status: 'needs_reconnect', cached: false });
    expect(getCachedLiveness(SUB, PROVIDER)?.status).toBe('needs_reconnect');

    // 2. The operator reconnects - the REAL write path, against the server this file started.
    await reconnect();

    // The memo must be gone. This is the assertion the bug failed.
    expect(getCachedLiveness(SUB, PROVIDER)).toBeUndefined();

    // 3. The next load re-probes and reports the healthy grant, WITHOUT ?fresh=1.
    const alive = appWith(SUB, [PROVIDER], async () => 'a-live-access-token');
    const second = await getLiveness(alive.app);
    expect(second[0]).toMatchObject({ provider: PROVIDER, status: 'ok', cached: false });
    expect(alive.probeCount()).toBe(1);
  });

  it('leaves other providers memoised — invalidation is scoped to the provider written', async () => {
    const dead = appWith(SUB, [PROVIDER, OTHER_PROVIDER], async () => { throw new Error('refresh 400'); });
    await getLiveness(dead.app);
    expect(getCachedLiveness(SUB, PROVIDER)?.status).toBe('needs_reconnect');
    expect(getCachedLiveness(SUB, OTHER_PROVIDER)?.status).toBe('needs_reconnect');

    await reconnect(PROVIDER);

    expect(getCachedLiveness(SUB, PROVIDER)).toBeUndefined();
    // Reconnecting Google must not force every other provider to re-probe.
    expect(getCachedLiveness(SUB, OTHER_PROVIDER)?.status).toBe('needs_reconnect');
  });

  it('clears a SHARED connection for every member, not just the person who reconnected', async () => {
    // Two members hold their own memo for the same provider.
    const a = appWith(SUB, [PROVIDER], async () => { throw new Error('refresh 400'); });
    const b = appWith(OTHER_SUB, [PROVIDER], async () => { throw new Error('refresh 400'); });
    await getLiveness(a.app);
    await getLiveness(b.app);
    expect(getCachedLiveness(SUB, PROVIDER)?.status).toBe('needs_reconnect');
    expect(getCachedLiveness(OTHER_SUB, PROVIDER)?.status).toBe('needs_reconnect');

    // ONE of them reconnects the shared grant.
    await reconnect(PROVIDER, SUB);

    // Both memos go: keying invalidation to the writer would strand the other member for the
    // rest of the TTL, which is the same defect in a harder-to-reproduce shape.
    expect(getCachedLiveness(SUB, PROVIDER)).toBeUndefined();
    expect(getCachedLiveness(OTHER_SUB, PROVIDER)).toBeUndefined();
  });
});
