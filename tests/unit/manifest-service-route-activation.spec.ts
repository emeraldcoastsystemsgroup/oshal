/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | ADR-157 S1: prove the runner at the boundary that broke — the real registry dispatching a real compiled package handler through the real execution guard. A protected app with no activation skips at INFO (asserted against the shipped logger's own JSON log file, not a mocked logger) and logs no ERROR; a system activation runs as the service principal; a user activation runs as that person with userSub pinned; a run-time denial suspends the activation instead of failing every cadence.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppContext } from '@/app/composition/app-context';
import {
  ManifestServiceRouteScheduleRegistry, manifestServiceRouteTaskType,
} from '@/app/manifest-service-route-schedule';
import { setManifestServiceActivationRuntime } from '@/app/manifest-service-route-activation';
import {
  ApplicationServiceActivationService, MemoryApplicationServiceActivationStore,
  MemoryAuthorizationStore, APPLICATION_SERVICE_PRINCIPAL_ISSUER,
} from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationDecision } from '@/shared/application-authorization';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { MANIFEST_SERVICE_ROUTE_TASK_KIND, type ScheduleRecord } from '@/features/scheduling';
import { getRequestIdentity } from '@/shared/services/database/request-identity';

const APP = 'metrics-app';
const LOCAL_ID = 'daily-ingest';
const SCHEDULE_ID = `${APP}-${LOCAL_ID}`;
const ISSUER = 'https://identity.fixture.test';
const LOG_FILE = resolve(process.cwd(), 'output', 'logs', `${process.env.SERVICE_NAME || 'OSHAL'}.log`);

const HANDLER_JS = `'use strict';
exports.runDailyIngest = async function (ctx, input) {
  ctx.events.push({ scheduleId: input.scheduleId, identity: ctx.readIdentity() });
  return { summary: 'ingested' };
};
`;

const admin: AuthorizationActor = { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };

let packageDir: string;
let events: Array<{ scheduleId: string; identity?: { sub?: string; principalIssuer?: string } }>;
let registry: ManifestServiceRouteScheduleRegistry;
let activations: MemoryApplicationServiceActivationStore;
let service: ApplicationServiceActivationService;
let decision: AuthorizationDecision;
let registered: string[];

/** @description Build one schedule record, optionally as a person's own per-user instance. */
function scheduleRecord(ownerSub: string | null = null): ScheduleRecord {
  const now = new Date().toISOString();
  const suffix = ownerSub ? `:${ownerSub.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16)}` : '';
  return {
    id: `${SCHEDULE_ID}${suffix}`, taskType: `${manifestServiceRouteTaskType(SCHEDULE_ID)}${suffix}`,
    cron: '15 6 * * *', taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: SCHEDULE_ID },
    status: 'active', createdAt: now, updatedAt: now, nextRunAt: now, lastRunAt: null,
    executionCount: 0, ownerSub, queue: APP,
  };
}

/** @description Read whatever the shipped logger appended to its JSON log since `from` bytes. */
async function logTail(from: number): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(done => setTimeout(done, 50));
    try {
      const size = statSync(LOG_FILE).size;
      if (size > from) return readFileSync(LOG_FILE, 'utf8').slice(from);
    } catch { /* the transport has not created it yet */ }
  }
  return '';
}

/** @description Current size of the shipped logger's JSON log, or 0 before it exists. */
function logSize(): number {
  try { return statSync(LOG_FILE).size; } catch { return 0; }
}

beforeAll(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'oshal-activation-runner-'));
  writeFileSync(join(packageDir, 'route.js'), HANDLER_JS, 'utf8');
});

afterAll(() => {
  rmSync(packageDir, { recursive: true, force: true });
});

beforeEach(() => {
  events = [];
  registered = [];
  decision = { allowed: true, reason: 'authorization_allowed', decisionId: 'fixture', revision: 1, app: APP, grants: [] };
  registry = new ManifestServiceRouteScheduleRegistry({ events, readIdentity: () => getRequestIdentity() } as unknown as AppContext);
  registry.register({
    appName: APP, scheduleId: SCHEDULE_ID, packageDir, module: 'route.js',
    handler: 'runDailyIngest', route: '/api/metrics-app/ingest', body: {},
  });
  activations = new MemoryApplicationServiceActivationStore();
  service = new ApplicationServiceActivationService({
    activations, policy: new MemoryAuthorizationStore(),
    describeApp: () => ({ source: 'fixture-store', catalogRevision: 'rev-1', catalog: null }),
    declaredServices: async () => [{
      app: APP, id: LOCAL_ID, scheduleId: SCHEDULE_ID, cron: '15 6 * * *',
      runsAs: undefined, requires: [], queue: APP,
    }],
    authorize: async () => decision,
    registerUserInstance: async input => { registered.push(input.userSub); },
    removeUserInstance: async input => { registered = registered.filter(sub => sub !== input.userSub); },
  });
  setManifestServiceActivationRuntime({
    resolveDispatch: input => service.resolveDispatch(input),
    suspend: (activation, reason) => service.suspend(activation, reason),
  });
  configureApplicationExecutionPolicy({
    owner: async () => APP,
    protectedApp: async () => true,
    authorize: async () => decision,
  });
});

afterEach(() => {
  setManifestServiceActivationRuntime(undefined);
  configureApplicationExecutionPolicy(undefined);
});

describe('ADR-157 service-route dispatch under an activation', () => {
  it('skips an unactivated protected schedule at INFO, with no ERROR and no handler run', async () => {
    const from = logSize();
    const result = await registry.dispatch(scheduleRecord());
    expect(result).toMatchObject({ success: false, error: 'skipped: not-activated' });
    expect(events).toEqual([]);
    const tail = await logTail(from);
    const lines = tail.split('\n').filter(line => line.includes(SCHEDULE_ID));
    expect(lines.some(line => line.includes('Manifest service-route schedule skipped: not activated')
      && line.includes('"level":30'))).toBe(true);
    expect(lines.some(line => line.includes('"level":50'))).toBe(false);
  });

  it('runs a system activation as the application service principal', async () => {
    await service.activate(admin, { app: APP, scheduleId: SCHEDULE_ID, runsAs: 'system' });
    const result = await registry.dispatch(scheduleRecord());
    expect(result).toMatchObject({ success: true });
    expect(events).toHaveLength(1);
    expect(events[0].identity).toMatchObject({
      sub: `service:${APP}`, principalIssuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER, isOperator: false,
    });
  });

  it('runs a user activation as that person, on their own instance, and not on the framework one', async () => {
    await service.activate(alice, { app: APP, scheduleId: SCHEDULE_ID, runsAs: 'user' });
    expect(registered).toEqual([alice.sub]);
    const framework = await registry.dispatch(scheduleRecord());
    expect(framework).toMatchObject({ success: false, error: 'skipped: not-activated' });
    const own = await registry.dispatch(scheduleRecord(alice.sub));
    expect(own).toMatchObject({ success: true });
    expect(events).toHaveLength(1);
    expect(events[0].identity).toMatchObject({ sub: alice.sub, principalIssuer: ISSUER, isOperator: false });
  });

  it('suspends the activation when current rights refuse the tick, and skips afterwards', async () => {
    const activation = await service.activate(admin, { app: APP, scheduleId: SCHEDULE_ID, runsAs: 'system' });
    decision = { allowed: false, reason: 'authorization_permission_denied', decisionId: 'fixture', revision: 2, app: APP, grants: [] };
    const denied = await registry.dispatch(scheduleRecord());
    expect(denied).toMatchObject({ success: false, error: 'skipped: denied' });
    expect((await activations.read(activation.id))?.suspendedReason).toBe('authorization_permission_denied');
    decision = { allowed: true, reason: 'authorization_allowed', decisionId: 'fixture', revision: 3, app: APP, grants: [] };
    const afterwards = await registry.dispatch(scheduleRecord());
    expect(afterwards).toMatchObject({ success: false, error: 'skipped: suspended' });
    expect(events).toEqual([]);
  });

  it('leaves an unprotected application running exactly as before', async () => {
    configureApplicationExecutionPolicy({
      owner: async () => APP, protectedApp: async () => false, authorize: async () => decision,
    });
    const result = await registry.dispatch(scheduleRecord());
    expect(result).toMatchObject({ success: true });
    expect(events).toHaveLength(1);
    expect(events[0].identity).toBeUndefined();
  });
});
