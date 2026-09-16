/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove unattended execution re-resolves an exact observed account and its current administrator authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise real batch and runner watchdogs with fixed/all selectors and current operator revocation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prove local schedule polling survives a first-attempt bootstrap failure instead of staying stopped until the process restarts.
 */
import type { Request } from 'express';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createTestLabScheduleWiring, resolveTestLabScheduledActor } from '@/app/composition/test-lab-schedule-wiring';
import type { AppContext } from '@/app/composition/app-context';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { TestLabScheduleService } from '@/app/routes/test-lab-schedule-service';
import { TestLabRunService } from '@/app/routes/test-lab-run-service';
import type { TestLabRun, TestLabRunStore } from '@/app/routes/test-lab-run-types';
import type { TestLabSchedule, TestLabScheduleBatch, TestLabScheduleStore } from '@/app/routes/test-lab-schedule-types';
import type { InstalledAppTestCatalog, InstalledAppTestCase, SwarmAppService } from '@/features/swarm-apps';

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

/**
 * The boundary these two cases cross is the readiness the controller HANDS the schedule wiring -
 * the authorization bootstrap passed at `server.ts`. On a busy box its first attempt loses a pool
 * acquire and rejects; `createRetryableReady` drops that attempt so every later ask starts a fresh
 * one. That is injected here at the real seam (`options.ready`), with the same rejection PostgreSQL
 * raises, and everything downstream of it runs for real: the wiring, the schedule schema bootstrap
 * and its advisory-lock DDL, the store's claim transaction, and the service's own poll timer.
 *
 * The pg pool is the one scoped double, because a real one cannot fail-then-recover without a
 * server. Its real companion is tests/unit/authorization-readiness-consumers.spec.ts, which drives
 * the same readiness through a genuine lost acquire against disposable PostgreSQL.
 */
function pollingFixture(failFirstAttempt = true) {
  const statements: string[] = [];
  const record = async (text: unknown) => {
    statements.push(typeof text === 'string' ? text : String((text as { text?: string } | null)?.text ?? ''));
    return { rows: [] as unknown[] };
  };
  const pool = { query: record,connect: async () => ({ query: record,release: () => undefined }) } as unknown as Pool;
  let asks = 0;
  const service = createTestLabScheduleWiring({
    ctx: { pool } as unknown as AppContext,
    apps: { testLabCatalog: { list: () => [],inventory: () => [] } } as unknown as SwarmAppService,
    runs: {} as unknown as TestLabRunService,
    ready: async () => { asks++; if (failFirstAttempt && asks === 1) throw new Error('timeout exceeded when trying to connect'); },
    authorization: { targetActor: async () => null,refreshActor: async () => null },
    visible: async () => new Map<string,string>(),
  });
  const matching = (fragment: string) => statements.filter(text => text.includes(fragment));
  return { service,asks: () => asks,
    schema: () => matching('CREATE TABLE IF NOT EXISTS oshal_test_lab_schedules'),
    claims: () => matching('FOR UPDATE SKIP LOCKED') };
}
/** Advance the poll timer and let the store's promise chain finish; nothing below the timer uses timers. */
async function settle(advanceMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(advanceMs);
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

it('polls again after the boot-time bootstrap attempt fails, instead of staying stopped until restart', async () => {
  vi.useFakeTimers();
  const f = pollingFixture();
  try {
    await settle(0);
    // The boot attempt ran and lost the acquire, so nothing reached the schema.
    expect(f.asks()).toBe(1); expect(f.schema()).toHaveLength(0); expect(f.claims()).toHaveLength(0);
    // One poll cycle must re-ask the readiness. Starting the timer inside the boot attempt's .then()
    // meant this cycle never happened and local scheduling stayed dead for the life of the process.
    await settle(15000);
    expect(f.asks()).toBeGreaterThan(1);
    expect(f.schema().length).toBeGreaterThan(0);
    expect(f.claims().length).toBeGreaterThan(0);
  } finally { f.service.stop(); vi.useRealTimers(); }
},20000);

it('stops claiming once the registered shutdown path stops the service', async () => {
  vi.useFakeTimers();
  const f = pollingFixture(false);
  try {
    await settle(15000);
    const claimed = f.claims().length;
    expect(claimed).toBeGreaterThan(0);
    f.service.stop();
    await settle(60000);
    expect(f.claims()).toHaveLength(claimed);
  } finally { f.service.stop(); vi.useRealTimers(); }
},20000);
