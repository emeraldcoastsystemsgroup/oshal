/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Isolation-audit spec: proves the Haven multi-household fixes — closeThread's UPDATE is scoped by household_id (user A cannot close user B's thread by row id), and haven routes resolve the household per-caller via oshal_tenant_memberships (403 on a non-member householdId, tenant household when a membership exists, default household only when none)
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeContextService, HAVEN_DEFAULT_HOUSEHOLD_ID } from '../../src/features/haven/home-context-service';
import { createHavenRoutes } from '../../src/app/routes/haven-routes';

const HOUSEHOLD_A = '11111111-1111-1111-1111-111111111111';
const HOUSEHOLD_B = '22222222-2222-2222-2222-222222222222';
const THREAD_OWNED_BY_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Fake pg pool that records every query and answers from a per-test script. */
function makeFakePool(opts: {
  /** Tenant (household) ids returned for oshal_tenant_memberships lookups. */
  memberTenantIds?: string[];
  /** rowCount returned for UPDATE open_threads (simulates whether a row matched). */
  threadUpdateRowCount?: number;
} = {}) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('oshal_tenant_memberships')) {
        return { rows: (opts.memberTenantIds ?? []).map((id) => ({ tenant_id: id })), rowCount: (opts.memberTenantIds ?? []).length };
      }
      if (text.includes('UPDATE open_threads')) {
        return { rows: [], rowCount: opts.threadUpdateRowCount ?? 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

/** Boot an express app with a fake authenticated OIDC session around the haven routes. */
function makeApp(pool: ReturnType<typeof makeFakePool>, sub: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub },
    };
    next();
  });
  app.use('/api', createHavenRoutes({ pool, getProvider: () => ({}) }));
  return app;
}

describe('haven household scoping (multi-household isolation fix)', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
    servers.length = 0;
    vi.restoreAllMocks();
  });

  async function listen(app: express.Express): Promise<number> {
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port');
    return address.port;
  }

  it('closeThread scopes the UPDATE by household_id so user A cannot close user B\'s thread', async () => {
    // Thread belongs to household B; caller resolved to household A. The DB simulates
    // "no row matched" (rowCount 0) because the WHERE now carries household_id.
    const pool = makeFakePool({ threadUpdateRowCount: 0 });
    const service = new HomeContextService(pool);

    const closed = await service.closeThread(HOUSEHOLD_A, THREAD_OWNED_BY_B);

    expect(closed).toBe(false);
    const update = pool.calls.find((c) => c.text.includes('UPDATE open_threads'));
    expect(update).toBeDefined();
    // The WHERE must be keyed on BOTH the row id and the caller's household — an id-only
    // predicate is exactly the leak this spec guards against.
    expect(update!.text).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+household_id\s*=\s*\$2/i);
    expect(update!.values).toEqual([THREAD_OWNED_BY_B, HOUSEHOLD_A]);
  });

  it('closeThread succeeds for the household that owns the thread', async () => {
    const pool = makeFakePool({ threadUpdateRowCount: 1 });
    const service = new HomeContextService(pool);

    const closed = await service.closeThread(HOUSEHOLD_B, THREAD_OWNED_BY_B);

    expect(closed).toBe(true);
    const update = pool.calls.find((c) => c.text.includes('UPDATE open_threads'));
    expect(update!.values).toEqual([THREAD_OWNED_BY_B, HOUSEHOLD_B]);
  });

  it('GET /haven/context refuses a householdId the caller is not a member of (403, no data queries)', async () => {
    // Caller is a member of household A only, but asks for household B's context.
    const pool = makeFakePool({ memberTenantIds: [HOUSEHOLD_A] });
    const port = await listen(makeApp(pool, 'auth0|user-a'));

    const response = await fetch(`http://127.0.0.1:${port}/api/haven/context?householdId=${HOUSEHOLD_B}`);

    expect(response.status).toBe(403);
    // No haven table was ever queried with household B's id — the request died at resolution.
    const havenQueries = pool.calls.filter((c) => !c.text.includes('oshal_tenant_memberships'));
    expect(havenQueries).toHaveLength(0);
  });

  it('GET /haven/context resolves the caller\'s own tenant household when none is requested', async () => {
    const pool = makeFakePool({ memberTenantIds: [HOUSEHOLD_A] });
    const port = await listen(makeApp(pool, 'auth0|user-a'));

    const response = await fetch(`http://127.0.0.1:${port}/api/haven/context`);

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as { householdId: string };
    expect(snapshot.householdId).toBe(HOUSEHOLD_A);
    // Every haven-table read was parameterized with the caller's household, never another one.
    const havenQueries = pool.calls.filter((c) => !c.text.includes('oshal_tenant_memberships'));
    expect(havenQueries.length).toBeGreaterThan(0);
    for (const call of havenQueries) {
      expect(call.values?.[0]).toBe(HOUSEHOLD_A);
    }
  });

  it('falls back to the default household ONLY for callers with no tenancy memberships', async () => {
    const pool = makeFakePool({ memberTenantIds: [] });
    const port = await listen(makeApp(pool, 'auth0|solo-user'));

    const response = await fetch(`http://127.0.0.1:${port}/api/haven/context`);

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as { householdId: string };
    expect(snapshot.householdId).toBe(HAVEN_DEFAULT_HOUSEHOLD_ID);
  });

  it('POST /haven/chat refuses a non-member householdId before any LLM/context work', async () => {
    const pool = makeFakePool({ memberTenantIds: [HOUSEHOLD_A] });
    const port = await listen(makeApp(pool, 'auth0|user-a'));

    const response = await fetch(`http://127.0.0.1:${port}/api/haven/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'what devices are online?', householdId: HOUSEHOLD_B }),
    });

    expect(response.status).toBe(403);
    const havenQueries = pool.calls.filter((c) => !c.text.includes('oshal_tenant_memberships'));
    expect(havenQueries).toHaveLength(0);
  });
});
