/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact caller/AUTO authorization on the internal MCP bridge.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-04: add system-tool, missing-descriptor, and replacement adversarial denials.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove an authorized request reaches the stable descriptor dispatch rather than failing first on an incomplete stream fixture.
 */

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
 *   2. AUTHORIZATION — the tool must have an exact AUTO grant for the named agent, checked BEFORE
 *      execution. ASK remains pending even if a client sends `approved:true`, and an unreadable
 *      grant list refuses rather than proceeds.
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

interface GrantRow {
  name: string;
  authMode?: 'auto' | 'ask' | 'off';
  enabled?: boolean;
  installed?: boolean;
  registeredBy?: string;
}

/** A pool double whose only interesting answer is the agent's enabled-tool grant list. */
function grantPool(grants: GrantRow[] | Error) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push(sql);
      if (/FROM tools t/i.test(sql)) {
        if (grants instanceof Error) throw grants;
        const requestedModes = Array.isArray(params[1]) ? params[1] as string[] : [];
        const filtersGlobalDisable = /t\.enabled\s*=\s*TRUE/i.test(sql);
        const filtersUninstalled = /at\.installed\s*=\s*TRUE/i.test(sql);
        return {
          rows: grants
            .filter((grant) => requestedModes.includes(grant.authMode ?? 'auto'))
            .filter((grant) => !filtersGlobalDisable || grant.enabled !== false)
            .filter((grant) => !filtersUninstalled || grant.installed !== false)
            .map((grant) => ({
              tool_id: `id-${grant.name}`,
              name: grant.name,
              type: 'api',
              enabled: grant.enabled ?? true,
              registered_by: grant.registeredBy ?? 'swarm-app',
            })),
        };
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
async function boot(
  grants: GrantRow[] | Error,
  session?: { sub: string; email?: string },
  descriptorMode: 'stable' | 'missing' | 'replaced' | 'registry-missing' = 'stable',
) {
  const pool = grantPool(grants);
  const initialDescriptor = Object.freeze({
    toolName: 'pumpkin-speak',
    executorType: 'api' as const,
    apiEndpoint: 'POST /api/never/reached',
    runtimeRegistered: true,
    registeredAt: new Date().toISOString(),
  });
  const replacementDescriptor = Object.freeze({
    ...initialDescriptor,
    apiEndpoint: 'POST /api/replaced',
  });
  let resolveCount = 0;
  const descriptorRegistry = descriptorMode === 'registry-missing'
    ? undefined
    : {
        resolve: () => {
          resolveCount += 1;
          if (descriptorMode === 'missing') return undefined;
          return descriptorMode === 'replaced' && resolveCount > 1
            ? replacementDescriptor
            : initialDescriptor;
        },
      };
  const ctx = {
    pool,
    streamManager: { broadcastToolExecution: () => undefined },
    workspaceService: undefined,
    dynamicToolExecutorRegistry: descriptorRegistry,
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
    descriptorResolutionCount: () => resolveCount,
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
    expect(h.descriptorResolutionCount()).toBe(3);
  });

  it('refuses an AUTO grant for a system tool that the bridge must never shadow', async () => {
    const h = await boot(
      [{ name: 'pumpkin-speak', authMode: 'auto', registeredBy: 'system' }],
      { sub: 'google-oauth2|operator-1' },
    );
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {} });
    expect(res.status).toBe(403);
  });

  it('refuses missing authorization/executor wiring before a raw executor can run', async () => {
    const missingDescriptor = await boot(
      [{ name: 'pumpkin-speak' }],
      { sub: 'google-oauth2|operator-1' },
      'missing',
    );
    close = missingDescriptor.close;
    expect((await missingDescriptor.post({
      agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {},
    })).status).toBe(403);
    await missingDescriptor.close();
    close = null;

    const missingRegistry = await boot(
      [{ name: 'pumpkin-speak' }],
      { sub: 'google-oauth2|operator-1' },
      'registry-missing',
    );
    close = missingRegistry.close;
    expect((await missingRegistry.post({
      agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {},
    })).status).toBe(503);
  });

  it('refuses a descriptor replaced while the persisted grant is being read', async () => {
    const h = await boot(
      [{ name: 'pumpkin-speak' }],
      { sub: 'google-oauth2|operator-1' },
      'replaced',
    );
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {} });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('changed during authorization');
  });

  it('refuses execution when no exact caller identity reaches the bridge', async () => {
    const h = await boot([{ name: 'pumpkin-speak' }]);
    close = h.close;

    const res = await h.post({ agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {} });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('caller identity');
  });

  it('refuses an ASK grant until a server-owned approval workflow resolves it', async () => {
    const h = await boot(
      [{ name: 'pumpkin-speak', authMode: 'ask' }],
      { sub: 'google-oauth2|operator-1' },
    );
    close = h.close;

    const res = await h.post({
      agentId: 'agent-abc',
      toolName: 'pumpkin-speak',
      input: {},
      approved: true,
    });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('requires approval');
  });

  it('treats global disable and uninstall as immediate revocation of an AUTO grant', async () => {
    const globallyDisabled = await boot(
      [{ name: 'pumpkin-speak', authMode: 'auto', enabled: false, installed: true }],
      { sub: 'google-oauth2|operator-1' },
    );
    close = globallyDisabled.close;
    expect((await globallyDisabled.post({
      agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {},
    })).status).toBe(403);
    await globallyDisabled.close();
    close = null;

    const uninstalled = await boot(
      [{ name: 'pumpkin-speak', authMode: 'auto', enabled: true, installed: false }],
      { sub: 'google-oauth2|operator-1' },
    );
    close = uninstalled.close;
    expect((await uninstalled.post({
      agentId: 'agent-abc', toolName: 'pumpkin-speak', input: {},
    })).status).toBe(403);
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
