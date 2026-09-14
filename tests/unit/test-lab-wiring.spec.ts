/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify fresh principal and application discovery checks at the deployed Test Lab composition boundary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise real history HTTP with unrelated held access and fresh selected-app revocation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Switch the boot-time runner probe off: this composition boundary is proven without starting a browser container.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createTestLabWiring } from '@/app/composition/test-lab-wiring';
import { InstalledAppTestCatalog, type SwarmAppService, type AppAccessService } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTestLabRunRoutes } from '@/app/routes/test-lab-run-routes';

// Schema behavior is exercised against PostgreSQL in the run/schedule integration suites.
vi.mock('@/app/routes/test-lab-run-schema', () => ({ ensureTestLabRunSchema: async () => undefined }));
vi.mock('@/app/routes/test-lab-schedule-schema', () => ({ ensureTestLabScheduleSchema: async () => undefined }));
const cleanup: Array<() => void> = [];
// The wiring probes the runner image once per boot; that is a real Docker run, proven in package-test-sandbox.spec.ts, not here.
process.env.OSHAL_TEST_LAB_RUNNER_PROBE = 'off';
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

function fixture() {
  const state = { actor: { issuer: 'https://provider.test', sub: 'owner', isActive: true, isSwarmAdmin: true,
    directory: [] } as AuthorizationActor, discovered: true, legacy: 'viewer', reads: 0,
    extra: false, checked: [] as string[], hold: Promise.resolve(), revokeAfterList: false, listed: 0 };
  const apps = { testLabCatalog: new InstalledAppTestCatalog(), listApps: async () =>
    (state.extra ? ['fixture','unrelated'] : ['fixture']).map(name => ({ name })),
    getActiveManifests: async () => (state.extra ? ['fixture','unrelated'] : ['fixture'])
      .map(name => ({ name, access: { defaultTier: 'viewer' } })) } as unknown as SwarmAppService;
  const access = { resolve: async (name: string) => {
    state.checked.push(name); if (name === 'unrelated') await state.hold;
    return { tier: state.legacy };
  } } as unknown as AppAccessService;
  const authorization = { ready: Promise.resolve(), targetActor: async () => state.actor, refreshActor: async () => state.actor,
    resolveActor: async () => { state.reads++; return state.actor; },
    runtime: { protectedApp: () => true, canDiscover: async () => state.discovered } };
  const ctx = { pool: { query: async (sql: string) => {
    if (!sql.startsWith('SELECT id,issuer')) return { rows: [] };
    state.listed++; if (state.revokeAfterList) state.discovered = false;
    return { rows: [{ id: 'receipt',issuer: state.actor.issuer,user_sub: state.actor.sub,
      state: 'passed',test: { id: 'app:fixture:test:example',appName: 'fixture' },created_at: new Date(),updated_at: new Date() }] };
  } } } as unknown as AppContext;
  const wiring = createTestLabWiring(ctx, apps, access, authorization);
  cleanup.push(() => wiring.scheduleService?.stop());
  const req = { headers: {}, body: { issuer: 'forged', sub: 'forged', canRunSuites: true } } as Request;
  return { state, wiring, req };
}

it('binds execution to the freshly resolved issuer and subject and current discoverability', async () => {
  const f = fixture();
  const first = await f.wiring.runContext!(f.req);
  expect(first.actor).toEqual({ issuer: 'https://provider.test', sub: 'owner' });
  expect(first.auth.canRunSuites).toBe(true); expect(first.visibleApps.has('fixture')).toBe(true);
  f.state.discovered = false;
  expect((await f.wiring.runContext!(f.req)).visibleApps.size).toBe(0);
  f.state.discovered = true; f.state.legacy = 'deny';
  expect((await f.wiring.runContext!(f.req)).visibleApps.size).toBe(0);
  f.state.legacy = 'viewer'; f.state.actor.isSwarmAdmin = false;
  expect((await f.wiring.runContext!(f.req)).auth.canRunSuites).toBe(false);
  f.state.actor.isActive = false;
  await expect(f.wiring.runContext!(f.req)).rejects.toMatchObject({ status: 401 });
  expect(f.state.reads).toBe(5);
});

async function historyServer(f: ReturnType<typeof fixture>) {
  const app = express(); app.use('/api/test-lab',createTestLabRunRoutes(f.wiring));
  const server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test-lab/runs`,
    close: () => new Promise<void>((resolve,reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

it('serves selected-app history while unrelated app access stays held beyond the authority deadline', async () => {
  const f = fixture(); f.state.extra = true;
  let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  const server = await historyServer(f);
  try {
    const response = await fetch(`${server.url}?app=fixture`);
    expect(response.status).toBe(200); expect((await response.json()).runs).toHaveLength(1);
    expect(f.state.reads).toBe(2); expect(f.state.checked).toEqual(['fixture','fixture']);
  } finally { release(); await server.close(); }
},10000);

it('retains all-app discovery and retracts selected-app history after current access changes', async () => {
  const f = fixture(); f.state.extra = true; const server = await historyServer(f);
  try {
    expect((await fetch(server.url)).status).toBe(200);
    expect(f.state.checked).toEqual(['fixture','unrelated','fixture','unrelated']);
    f.state.checked = [];
    expect((await fetch(`${server.url}?app=`)).status).toBe(200);
    expect(f.state.checked).toEqual(['fixture','unrelated','fixture','unrelated']);
    f.state.checked = []; f.state.revokeAfterList = true;
    expect((await (await fetch(`${server.url}?app=fixture`)).json()).runs).toEqual([]);
    expect(f.state.checked).toEqual(['fixture','fixture']); expect(f.state.reads).toBe(6);
    f.state.discovered = true; f.state.legacy = 'deny';
    expect((await (await fetch(`${server.url}?app=fixture`)).json()).runs).toEqual([]);
    f.state.actor.isActive = false; expect((await fetch(`${server.url}?app=fixture`)).status).toBe(401);
  } finally { await server.close(); }
});
