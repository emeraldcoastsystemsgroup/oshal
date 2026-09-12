/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify fresh principal and application discovery checks at the deployed Test Lab composition boundary.
 */
import { expect, it } from 'vitest';
import type { Request } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { createTestLabWiring } from '@/app/composition/test-lab-wiring';
import { InstalledAppTestCatalog, type SwarmAppService, type AppAccessService } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';

function fixture() {
  const state = { actor: { issuer: 'https://provider.test', sub: 'owner', isActive: true, isSwarmAdmin: true,
    directory: [] } as AuthorizationActor, discovered: true, legacy: 'viewer', reads: 0 };
  const apps = { testLabCatalog: new InstalledAppTestCatalog(), listApps: async () => [{ name: 'fixture' }],
    getActiveManifests: async () => [{ name: 'fixture', access: { defaultTier: 'viewer' } }] } as unknown as SwarmAppService;
  const access = { resolve: async () => ({ tier: state.legacy }) } as unknown as AppAccessService;
  const authorization = { ready: Promise.resolve(), resolveActor: async () => { state.reads++; return state.actor; },
    runtime: { protectedApp: () => true, canDiscover: async () => state.discovered } };
  const ctx = { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;
  const wiring = createTestLabWiring(ctx, apps, access, authorization);
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
