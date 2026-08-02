/**
 * INTERNAL TOOL BRIDGE — IDENTITY + AUTHORIZATION GUARDS.
 *
 * `/api/tools` is mounted behind `serviceSecretOr(requiresAuth)`, which means an ORDINARY OIDC
 * browser session reaches `POST /api/tools/execute`. Everything downstream of it treats the request
 * as trusted system traffic: ToolExecutorService stamps a real `X-Service-Secret` plus the acting
 * `X-OSHAL-User-Sub` onto the outbound call, and it resolves the tool descriptor from the
 * PROCESS-WIDE dynamic registry. So this route is the exact place a confused deputy is fatal, and
 * the two properties pinned here are the two that were missing:
 *
 *   1. IDENTITY — a session caller can only ever act as its own validated sub. `req.body.userSub`
 *      is inert. (It used to be the fallback, so a plain signed-in tab could name any victim.)
 *   2. AUTHORIZATION — the tool must be ENABLED for the named agent, checked BEFORE execution, and
 *      an unreadable grant list refuses rather than proceeds.
 *
 * Asserted as CALLS against the real router (built by the real factory) driven over real HTTP —
 * never a source substring.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalToolBridgeRoutes, resolveActingSub } from '../../src/app/routes/internal-tool-bridge-routes';
import type { AppContext } from '../../src/app/composition/app-context';

interface GrantRow { name: string }

/** A pool double whose only interesting answer is the agent's enabled-tool grant list. */
function grantPool(grants: GrantRow[] | Error) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      if (/FROM tools t/i.test(sql)) {
        if (grants instanceof Error) throw grants;
        return { rows: grants.map((g) => ({ tool_id: `id-${g.name}`, name: g.name, type: 'api', registered_by: 'swarm-app' })) };
      }
      return { rows: [] };
    },
  };
}

/**
 * Boot the REAL router (built by the real factory) on a real HTTP server. Nothing about the route
 * is re-implemented here — a refusal has to come out of the shipped code path or the guard proves
 * nothing.
 */
async function boot(grants: GrantRow[] | Error, session?: { sub: string; email?: string }) {
  const pool = grantPool(grants);
  const ctx = {
    pool,
    streamManager: undefined,
    workspaceService: undefined,
    dynamicToolExecutorRegistry: {
      resolve: (toolName: string) => ({
        toolName,
        executorType: 'api' as const,
        apiEndpoint: 'POST /api/never/reached',
        runtimeRegistered: true,
        registeredAt: new Date().toISOString(),
      }),
    },
    connectorSpecToolService: undefined,
  } as unknown as AppContext;

  const router = createInternalToolBridgeRoutes(ctx);
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: session };
      next();
    });
  }
  app.use('/api/tools', router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    pool,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    post: async (body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
  };
}

describe('POST /api/tools/execute — authorization', () => {
  let close: null | (() => Promise<void>) = null;
  afterEach(async () => { if (close) { await close(); close = null; } });

  it('refuses a tool the agent has NOT been granted, before any execution', async () => {
    const h = await boot([{ name: 'career_database' }], { sub: 'google-oauth2|attacker-999' });
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: { text: 'Come inside.' } });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('pumpkin-speak');
    // The grant list was consulted, and nothing else ran: an executed api tool would have produced
    // a second (outbound) hop, and a 500/200 rather than this 403.
    expect(h.pool.calls.some((sql) => /FROM tools t/i.test(sql))).toBe(true);
  });

  it('an unreadable grant list refuses rather than falling open', async () => {
    const h = await boot(new Error('pool down'), { sub: 'google-oauth2|operator-1' });
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {} });
    expect(res.status).toBe(503);
  });

  it('a granted tool passes the gate (the gate is not simply always-deny)', async () => {
    const h = await boot([{ name: 'pumpkin-speak' }], { sub: 'google-oauth2|operator-1' });
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {} });
    // The outbound hop is unreachable in a unit realm, so the executor fails — which is exactly the
    // proof that authorization ALLOWED it through. What must never happen is a 403.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(503);
  });

  it('still rejects a request missing agentId/toolName before touching the grant list', async () => {
    const h = await boot([{ name: 'pumpkin-speak' }], { sub: 'google-oauth2|operator-1' });
    close = h.close;
    const res = await h.post({ toolName: 'pumpkin-speak' });
    expect(res.status).toBe(400);
    expect(h.pool.calls.some((sql) => /FROM tools t/i.test(sql))).toBe(false);
  });
});

describe('resolveActingSub — a session caller cannot name someone else', () => {
  const previousSecret = process.env.SWARM_SERVICE_SECRET;
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = previousSecret;
  });

  function req(headers: Record<string, string>, oidcSub: string | null, body: unknown) {
    return {
      headers,
      body,
      oidc: oidcSub ? { isAuthenticated: () => true, user: { sub: oidcSub } } : undefined,
    } as never;
  }

  it('IGNORES req.body.userSub for a session caller — the impersonation vector', () => {
    process.env.SWARM_SERVICE_SECRET = 'unit-service-secret';
    const acting = resolveActingSub(req({}, 'google-oauth2|attacker-999', { userSub: 'google-oauth2|victim-000' }));
    expect(acting).toBe('google-oauth2|attacker-999');
  });

  it('IGNORES req.body.userSub even when there is no session at all', () => {
    process.env.SWARM_SERVICE_SECRET = 'unit-service-secret';
    expect(resolveActingSub(req({}, null, { userSub: 'google-oauth2|victim-000' }))).toBeUndefined();
  });

  it('honors X-OSHAL-User-Sub only alongside a valid service secret', () => {
    process.env.SWARM_SERVICE_SECRET = 'unit-service-secret';
    const good = resolveActingSub(req(
      { 'x-service-secret': 'unit-service-secret', 'x-oshal-user-sub': 'google-oauth2|owner-1' },
      null,
      {},
    ));
    expect(good).toBe('google-oauth2|owner-1');

    const forged = resolveActingSub(req(
      { 'x-service-secret': 'wrong-secret-value!!!!', 'x-oshal-user-sub': 'google-oauth2|owner-1' },
      'google-oauth2|attacker-999',
      {},
    ));
    expect(forged).toBe('google-oauth2|attacker-999');
  });
});
