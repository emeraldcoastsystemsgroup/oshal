/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Prove deterministic package schedule manifest validation, confined named-export dispatch, immutable bodies, and lifecycle teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import type { AppContext } from '@/app/composition/app-context';
import {
  ManifestServiceRouteScheduleRegistry,
  manifestServiceRouteTaskType,
} from '@/app/manifest-service-route-schedule';
import {
  createManifestScheduleDeregistrar,
  createManifestScheduleRegistrar,
} from '@/app/swarm-app-schedule-wiring';
import { setHomeScheduleService } from '@/app/home-schedule-dispatch';
import {
  MANIFEST_SERVICE_ROUTE_TASK_KIND,
  ScheduleTaskDataSchema,
  type ScheduleRecord,
} from '@/features/scheduling';
import { readManifest, SwarmAppService } from '@/features/swarm-apps';

const HANDLER_JS = `'use strict';
exports.runPolicyTick = async function (ctx, input) {
  if (!Object.isFrozen(input.body) || !Object.isFrozen(input.body.nested)) throw new Error('body not frozen');
  try { input.body.execute = false; } catch (_) {}
  ctx.events.push({ body: input.body, packageDir: ctx.appPackageDir, scheduleId: input.scheduleId });
  return { summary: 'evaluated=2; started=0' };
};
exports.badResult = async function () { return { ownerSub: 'must-not-escape' }; };
`;

const manifestDirs: string[] = [];
let packageDir: string;
let events: Array<Record<string, unknown>>;
let context: AppContext;
const nodeRequire = createRequire(import.meta.url);
const { validateScheduleDeclarations: validatePackageSchedules } = nodeRequire(
  '../../scripts/oshal-app-schedules.js',
) as { validateScheduleDeclarations: (manifest: Record<string, unknown>) => string[] };

function scheduleRecord(scheduleId = 'example-policy-tick'): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: manifestServiceRouteTaskType(scheduleId).replaceAll(':', '-'),
    taskType: manifestServiceRouteTaskType(scheduleId),
    cron: '7 * * * *',
    taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: scheduleId },
    status: 'active',
    createdAt: now,
    updatedAt: now,
    nextRunAt: now,
    lastRunAt: null,
    executionCount: 0,
    ownerSub: null,
    queue: 'example',
  };
}

function writeManifest(scheduleLines: string[], routeAuth = 'service'): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-service-schedule-manifest-'));
  manifestDirs.push(dir);
  const manifestPath = join(dir, 'oshal-app.yaml');
  writeFileSync(manifestPath, [
    'name: schedule-app',
    'displayName: Schedule App',
    'suite: ai-home',
    'routes:',
    '  - module: route.js',
    '    factory: createRoutes',
    '    mountPath: /api/schedule-app',
    `    auth: ${routeAuth}`,
    'schedules:',
    ...scheduleLines,
    '',
  ].join('\n'), 'utf8');
  return manifestPath;
}

const validSchedule = [
  '  - id: policy-tick',
  '    cron: "7 * * * *"',
  '    target: service-route',
  '    route: /api/schedule-app/tick',
  '    handler: runPolicyTick',
  '    body:',
  '      execute: true',
  '      nested:',
  '        lane: safe',
  '    scope: framework',
];

beforeAll(() => {
  packageDir = mkdtempSync(join(tmpdir(), 'oshal-service-schedule-package-'));
  writeFileSync(join(packageDir, 'route.js'), HANDLER_JS, 'utf8');
  events = [];
  context = {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    events,
  } as unknown as AppContext;
});

afterAll(() => {
  rmSync(packageDir, { recursive: true, force: true });
  for (const dir of manifestDirs) rmSync(dir, { recursive: true, force: true });
});

describe('service-route schedule manifest trust boundary', () => {
  it('accepts a canonical static handler target and keeps prompt schedules compatible', () => {
    const manifest = readManifest(writeManifest(validSchedule));
    expect(manifest.schedules?.[0]).toMatchObject({
      target: 'service-route', route: '/api/schedule-app/tick', handler: 'runPolicyTick',
    });
    expect(() => readManifest(writeManifest([
      '  - id: digest',
      '    cron: "0 13 * * *"',
      '    prompt: Summarize the day.',
      '    scope: framework',
    ]))).not.toThrow();
  });

  it.each([
    ['non-service owner', validSchedule, 'oidc', /auth mode is exactly service/],
    ['path traversal', validSchedule.map((line) => line.replace('/api/schedule-app/tick', '/api/schedule-app/../admin')), 'service', /canonical/],
    ['secret interpolation', validSchedule.map((line) => line.replace('lane: safe', 'lane: "${SECRET}"')), 'service', /interpolation/],
    ['mixed prompt', [...validSchedule, '    prompt: do not dispatch me'], 'service', /unknown field.*prompt/],
    ['invalid export', validSchedule.map((line) => line.replace('runPolicyTick', 'not-a-name')), 'service', /named JavaScript export/],
    ['six-field cron', validSchedule.map((line) => line.replace('7 * * * *', '0 7 * * * *')), 'service', /five-field/],
  ])('rejects %s', (_name, lines, auth, expected) => {
    expect(() => readManifest(writeManifest(lines, auth))).toThrow(expected);
  });

  it('requires exactly one persisted task-data mode', () => {
    expect(ScheduleTaskDataSchema.parse({ prompt: 'run me' })).toMatchObject({ prompt: 'run me' });
    expect(ScheduleTaskDataSchema.parse({
      kind: MANIFEST_SERVICE_ROUTE_TASK_KIND,
      scheduleKey: 'schedule-app-policy-tick',
    })).toMatchObject({ kind: MANIFEST_SERVICE_ROUTE_TASK_KIND });
    expect(() => ScheduleTaskDataSchema.parse({ kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'x', prompt: 'fake' }))
      .toThrow(/cannot contain prompt/);
    expect(() => ScheduleTaskDataSchema.parse({})).toThrow(/requires prompt/);
  });

  it('mirrors the service-route trust boundary in the pre-install package validator', () => {
    const manifest = {
      routes: [{ module: 'route.js', factory: 'createRoutes', mountPath: '/api/schedule-app', auth: 'service' }],
      schedules: [{
        id: 'policy-tick', cron: '7 * * * *', target: 'service-route',
        route: '/api/schedule-app/tick', handler: 'runPolicyTick', body: { execute: true },
      }],
    };
    expect(validatePackageSchedules(manifest)).toEqual([]);
    expect(validatePackageSchedules({
      ...manifest,
      schedules: [{ ...manifest.schedules[0], body: { token: '${SECRET}' } }],
    })).toEqual(expect.arrayContaining([expect.stringContaining('interpolation')]));
  });
});

describe('active deterministic package schedule registry', () => {
  it('loads the confined named export, freezes/clones the body, and bounds its result', async () => {
    const registry = new ManifestServiceRouteScheduleRegistry(context);
    const body = { execute: true, nested: { lane: 'safe' } };
    registry.register({
      appName: 'example', scheduleId: 'example-policy-tick', packageDir,
      module: 'route.js', handler: 'runPolicyTick', route: '/api/example/tick', body,
    });
    body.execute = false;
    body.nested.lane = 'mutated';

    const result = await registry.dispatch(scheduleRecord());
    expect(result).toMatchObject({ success: true, taskId: 'app-route-example-policy-tick' });
    expect(events.at(-1)).toMatchObject({
      body: { execute: true, nested: { lane: 'safe' } },
      packageDir,
      scheduleId: 'example-policy-tick',
    });
  });

  it('fails closed on stale metadata, invalid results, escaped modules, and unregister', async () => {
    const registry = new ManifestServiceRouteScheduleRegistry(context);
    registry.register({
      appName: 'example', scheduleId: 'example-policy-tick', packageDir,
      module: 'route.js', handler: 'badResult', route: '/api/example/tick', body: {},
    });
    expect(await registry.dispatch(scheduleRecord())).toMatchObject({ success: false });
    expect(await registry.dispatch({
      ...scheduleRecord(), taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'wrong' },
    })).toMatchObject({ success: false, error: expect.stringContaining('metadata') });
    expect(() => registry.register({
      appName: 'escaped', scheduleId: 'escaped-policy-tick', packageDir,
      module: '../outside.js', handler: 'runPolicyTick', route: '/api/escaped/tick', body: {},
    })).toThrow(/outside package/);
    registry.unregister('example', ['policy-tick']);
    expect(await registry.dispatch(scheduleRecord())).toMatchObject({ success: false, error: expect.stringContaining('No active') });
  });

  it('wires a no-prompt Redis record and retracts authority before deletion', async () => {
    const registry = new ManifestServiceRouteScheduleRegistry(context);
    const created: any[] = [];
    const deleted: string[] = [];
    const fakeScheduleService = {
      createSchedule: async (input: any) => { created.push(input); return input; },
      listSchedules: async () => created.map((input, index) => ({ ...scheduleRecord(), id: `stored-${index}`, ...input })),
      deleteSchedule: async (id: string) => { deleted.push(id); return true; },
    };
    setHomeScheduleService(fakeScheduleService as never);
    const registrar = createManifestScheduleRegistrar(registry);
    await registrar({
      scheduleId: 'example-policy-tick', cron: '7 * * * *', queue: 'example',
      target: {
        kind: 'service-route', appName: 'example', packageDir, module: 'route.js',
        handler: 'runPolicyTick', path: '/api/example/tick', body: { execute: true, nested: {} },
      },
    });
    expect(created[0]).toMatchObject({
      taskType: 'app-route:example-policy-tick',
      taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: 'example-policy-tick' },
    });
    expect(created[0].taskData).not.toHaveProperty('prompt');
    expect(await registry.dispatch(scheduleRecord())).toMatchObject({ success: true });

    await createManifestScheduleDeregistrar(registry)({ appName: 'example', scheduleIds: ['policy-tick'] });
    expect(deleted).toEqual(['stored-0']);
    expect(await registry.dispatch(scheduleRecord())).toMatchObject({ success: false });
  });
});

describe('SwarmAppService deterministic schedule lifecycle', () => {
  it('forwards the owning route module and treats registration failure as activation failure', async () => {
    const manifestPath = writeManifest(validSchedule);
    let record: any;
    const repo = {
      findByName: async () => record ?? null,
      upsert: async (manifest: any) => {
        record = {
          appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
          description: '', version: '1', status: 'active', manifestPath, agentIds: [], toolNames: [],
          manifest, scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null,
          loadedAt: new Date(), updatedAt: new Date(),
        };
        return record;
      },
      list: async () => record ? [record] : [],
      updateStatus: async () => record,
    };
    const calls: any[] = [];
    const service = new SwarmAppService(
      context.pool,
      repo as never,
      { updateAgentStatus: async () => undefined } as never,
      undefined,
      undefined,
      async (input) => { calls.push(input); },
    );
    await service.loadApp(manifestPath);
    expect(calls[0]).toMatchObject({
      scheduleId: 'schedule-app-policy-tick',
      target: { kind: 'service-route', module: 'route.js', handler: 'runPolicyTick' },
    });

    const failing = new SwarmAppService(
      context.pool,
      { ...repo, upsert: async (manifest: any) => ({ ...(await repo.upsert(manifest)), status: 'active' }) } as never,
      { updateAgentStatus: async () => undefined } as never,
      undefined,
      undefined,
      async () => { throw new Error('handler missing'); },
    );
    await expect(failing.loadApp(manifestPath)).rejects.toThrow(/handler missing/);
  });

  it('retracts a service handler removed by an active manifest hot reload', async () => {
    const manifestPath = writeManifest(validSchedule);
    let record: any;
    const repo = {
      findByName: async () => record ?? null,
      upsert: async (manifest: any) => {
        record = {
          appId: manifest.name, name: manifest.name, displayName: manifest.displayName,
          description: '', version: '1', status: 'active', manifestPath, agentIds: [], toolNames: [],
          manifest, scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null,
          loadedAt: new Date(), updatedAt: new Date(),
        };
        return record;
      },
      list: async () => record ? [record] : [],
      updateStatus: async () => record,
    };
    const registered: string[] = [];
    const retired: string[] = [];
    const service = new SwarmAppService(
      context.pool,
      repo as never,
      { updateAgentStatus: async () => undefined } as never,
      undefined,
      undefined,
      async (input) => { registered.push(input.scheduleId); },
      undefined,
      async (input) => { retired.push(`${input.appName}:${input.scheduleIds.join(',')}`); },
    );
    await service.loadApp(manifestPath);
    writeFileSync(manifestPath, [
      'name: schedule-app',
      'displayName: Schedule App',
      'suite: ai-home',
      'routes:',
      '  - module: route.js',
      '    factory: createRoutes',
      '    mountPath: /api/schedule-app',
      '    auth: service',
      '',
    ].join('\n'), 'utf8');
    await service.loadApp(manifestPath);
    expect(registered).toEqual(['schedule-app-policy-tick']);
    expect(retired).toContain('schedule-app:policy-tick');
  });
});
