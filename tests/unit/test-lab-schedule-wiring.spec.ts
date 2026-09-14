/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove unattended execution re-resolves an exact observed account and its current administrator authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise real batch and runner watchdogs with fixed/all selectors and current operator revocation.
 */
import type { Request } from 'express';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { resolveTestLabScheduledActor } from '@/app/composition/test-lab-schedule-wiring';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { TestLabScheduleService } from '@/app/routes/test-lab-schedule-service';
import { TestLabRunService } from '@/app/routes/test-lab-run-service';
import type { TestLabRun, TestLabRunStore } from '@/app/routes/test-lab-run-types';
import type { TestLabSchedule, TestLabScheduleBatch, TestLabScheduleStore } from '@/app/routes/test-lab-schedule-types';
import type { InstalledAppTestCatalog, InstalledAppTestCase } from '@/features/swarm-apps';

function fixture() {
  const principal = { issuer: 'https://schedule-provider.test', sub: 'owner' };
  const state = { active: true, admin: true, targetIssuer: principal.issuer, reads: 0 };
  const current = createApplicationAuthorizationActorResolver({} as Pool, { env: {}, tenantIds: async () => [],
    nativePrincipal: async () => { state.reads++; return { isActive: state.active, isSwarmAdmin: state.admin }; } });
  const ports = {
    targetActor: async (): Promise<AuthorizationActor> => ({ ...principal, issuer: state.targetIssuer,
      isActive: state.active, isSwarmAdmin: false, directory: [] }),
    refreshActor: async (original: AuthorizationActor) => {
      expect(original.directory).toEqual([]); expect(original.allowedPermissions).toBeUndefined();
      const resolved = await current({ headers: {}, oidc: { isAuthenticated: () => true,
        user: { iss: original.issuer, sub: original.sub } } } as unknown as Request);
      return { ...resolved, isSwarmAdmin: resolved.isSwarmAdmin && original.isSwarmAdmin };
    },
  };
  return { principal, state, ports };
}

it('uses current provider administrator status and refuses the same saved owner after revocation', async () => {
  const f = fixture();
  expect(await resolveTestLabScheduledActor(f.ports, f.principal)).toMatchObject({ ...f.principal, isSwarmAdmin: true, directory: [] });
  f.state.admin = false;
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('authority is unavailable');
  expect(f.state.reads).toBe(2);
});

it('refuses disabled or wrong-issuer account lookup before current authority is considered', async () => {
  const f = fixture(); f.state.active = false;
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('account is unavailable');
  f.state.active = true; f.state.targetIssuer = 'https://another-provider.test';
  await expect(resolveTestLabScheduledActor(f.ports, f.principal)).rejects.toThrow('account is unavailable');
  expect(f.state.reads).toBe(0);
});

// Only persistence and sandbox ports are synthetic; both service loops and their real timers run.
function memoryRuns() {
  const state = { row: null as TestLabRun | null,pulses: 0 };
  const store: TestLabRunStore = {
    create: async run => { state.row = run; return run; },get: async () => state.row,list: async () => [],
    begin: async () => { state.row!.state = 'running'; return true; },
    pulse: async () => { state.pulses++; return state.row!.state; },
    cancel: async () => { state.row!.state = 'cancelling'; return state.row; },
    finish: async (_actor,_id,status,result) => { state.row!.state = status; state.row!.result = result; },
  };
  return { state,store };
}

function batchFixture(appName: string, revoke = false) {
  const actor = { issuer: 'https://schedule-provider.test',sub: 'owner' }, scopes: Array<string | undefined> = [];
  const state = { admin: true,finished: null as TestLabScheduleBatch | null,executing: Promise.resolve() };
  const schedule = { id: randomUUID(),actor,appName,levels: ['unit'],cadence: 'daily',enabled: false,revision: 1 } as TestLabSchedule;
  const batch = { id: randomUUID(),scheduleId: schedule.id,actor,state: 'running',oneOff: true,scheduleRevision: 1,
    summary: { selected: 0,deferred: 0,runs: [],unavailable: [],drift: [] } } as TestLabScheduleBatch;
  const test = { id: 'app:fixture:test:unit',appName: 'fixture',appVersion: '1.0.0',source: 'package',runnable: true,
    level: 'unit',revision: 'a'.repeat(64),executionRevision: 'b'.repeat(64),runner: { kind: 'node-test',scope: 'package' } } as InstalledAppTestCase;
  const catalog = { list: (visible: ReadonlyMap<string,string>) => visible.has('fixture') ? [test] : [],inventory: () => [],
    run: async () => {
      if (revoke) state.admin = false;
      state.executing = new Promise<void>(resolve => setTimeout(resolve,2300)); await state.executing;
      return { status: 'passed',cleanupVerified: true,durationMs: 2300 };
    } } as unknown as InstalledAppTestCatalog;
  const storage = memoryRuns(), runs = new TestLabRunService(storage.store,catalog);
  const store = { get: async () => schedule,claim: async () => ({ schedule,batch,created: true }),
    heartbeat: async () => true,checkpoint: async () => undefined,
    finish: async (_batch: TestLabScheduleBatch,status: TestLabScheduleBatch['state'],summary: TestLabScheduleBatch['summary']) => {
      state.finished = { ...batch,state: status,summary };
    } } as unknown as TestLabScheduleStore;
  const current = () => ({ actor,visibleApps: new Map([['fixture','Fixture'],['unrelated','Unrelated']]),auth: { canRunSuites: state.admin } });
  const service = new TestLabScheduleService({ store,runs,catalog,resolveScheduledContext: async (principal,scope) => {
    expect(principal).toEqual(actor); scopes.push(scope); return current();
  } });
  return { service,state,scopes,storage,start: () => service.runNow(schedule.id,{ revision: 1,requestId: randomUUID() },async () => current()) };
}

it.each(['fixture','*'])('reuses the %s selector in fresh batch, read and runner watchdog checks', async appName => {
  const f = batchFixture(appName);
  try {
    await f.start(); await vi.waitFor(() => expect(f.state.finished?.state).toBe('completed'),{ timeout: 6000 });
    expect(f.storage.state.row?.state).toBe('passed'); expect(f.storage.state.pulses).toBeGreaterThanOrEqual(3);
    expect(f.scopes.length).toBeGreaterThan(5);
    expect(new Set(f.scopes)).toEqual(new Set([appName === '*' ? undefined : appName]));
  } finally { await f.state.executing; f.service.stop(); }
},10000);

it('cancels a fixed-package batch and withholds output after current operator revocation', async () => {
  const f = batchFixture('fixture',true);
  try {
    await f.start(); await vi.waitFor(() => expect(f.state.finished?.state).toBe('cancelled'),{ timeout: 6000 });
    await vi.waitFor(() => expect(f.storage.state.row?.state).toBe('cancelled'),{ timeout: 6000 });
    expect(f.storage.state.row?.result).toMatchObject({ status: 'pending',cancelled: true,cleanupVerified: true });
    expect(new Set(f.scopes)).toEqual(new Set(['fixture'])); expect(f.storage.state.row?.result?.output).toBeUndefined();
  } finally { await f.state.executing; f.service.stop(); }
},10000);
