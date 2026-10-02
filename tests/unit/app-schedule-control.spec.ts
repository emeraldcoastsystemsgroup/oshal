/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operator control of application-manifest schedules, across the real Redis store: the routes refuse non-operators; on/off and cadence are applied to the live record, stored as an override, and survive a re-registration (restart) and a deregistration + registration (app toggle); a cron tighter than the floor or unreadable is refused; a stored cron that no longer parses registers the manifest cron; and a pause made while a fire is in flight is not undone when that fire finishes, nor is a schedule deleted mid-run written back.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposableRedis } from '../helpers/disposable-redis';
import { RedisScheduleStore, ScheduleService, type ScheduleDispatchResult } from '../../src/features/scheduling';
import type { SwarmAppManifest } from '../../src/features/swarm-apps';

const h = vi.hoisted(() => ({ svc: null as unknown }));
vi.mock('../../src/app/home-schedule-dispatch', () => ({ getHomeScheduleService: () => h.svc }));

import { registerAppScheduleControlRoutes } from '../../src/app/routes/app-schedule-control-routes';
import { createManifestScheduleRegistrar } from '../../src/app/swarm-app-schedule-wiring';

const OPERATOR = 'fixture-operator-sub';
const VIEWER = 'fixture-viewer-sub';
const PULSE_CRON = '*/5 8-23 * * 1-5';
const REFRESH_CRON = '0 */6 * * *';
const PULSE_RECORD = 'app_fixture-world-ticker-pulse';

const manifest = {
  name: 'fixture-world',
  schedules: [
    { id: 'ticker-pulse', cron: PULSE_CRON, scope: 'framework', description: 'pulse', prompt: 'pulse', targetAgent: 'b00d0000-0000-0000-0000-000000000001' },
    { id: 'world-refresh', cron: REFRESH_CRON, scope: 'framework', prompt: 'refresh', targetAgent: 'b00d0000-0000-0000-0000-000000000001' },
    { id: 'digest', cron: '0 7 * * *', scope: 'per-user', prompt: 'digest' },
  ],
} as unknown as SwarmAppManifest;

let redisFixture: DisposableRedis;
let raw: Redis;
let store: RedisScheduleStore;
let svc: ScheduleService;
let server: Server;
let base: string;
/** The dispatch handler's gate: a test holds a fire open by setting this before triggering it. */
let holdFire: Promise<void> | null = null;

const registrar = createManifestScheduleRegistrar({ register: () => undefined, unregister: () => undefined } as never);

/** Register every framework schedule of the fixture manifest, as activation does. */
async function registerAll(): Promise<void> {
  for (const s of manifest.schedules ?? []) {
    if (s.scope === 'per-user') continue;
    await registrar({
      scheduleId: `${manifest.name}-${s.id}`, cron: s.cron, queue: manifest.name,
      target: { kind: 'prompt', prompt: (s as { prompt: string }).prompt, targetAgent: (s as { targetAgent?: string }).targetAgent },
    } as never);
  }
}

/** Call the routes as a signed-in caller. */
async function call(method: string, path: string, sub: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/swarm/apps${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-fixture-sub': sub },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeAll(async () => {
  redisFixture = new DisposableRedis({ purpose: 'app-schedule-control' });
  const conn = await redisFixture.start();
  raw = new Redis(conn.url);
  store = new RedisScheduleStore({ redisUrl: conn.url });
  svc = new ScheduleService(store, async (schedule): Promise<ScheduleDispatchResult> => {
    if (holdFire) await holdFire;
    return { success: true, scheduleId: schedule.id };
  }, { ensureSchedulingEnabled: async () => undefined });
  h.svc = svc;
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { user: { sub: req.header('x-fixture-sub') }, isAuthenticated: () => true };
    next();
  });
  const router = express.Router();
  registerAppScheduleControlRoutes(router, { getActiveManifests: async () => [manifest] }, { scheduler: () => svc });
  app.use('/api/swarm/apps', router);
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await store?.close();
  raw?.disconnect();
  await redisFixture?.stop();
  delete process.env.OSHAL_OPERATOR_SUBS;
});

beforeEach(async () => {
  holdFire = null;
  await raw.flushall();
  await registerAll();
});

describe('who may read and change an application schedule', () => {
  it('refuses a signed-in non-operator on both routes and leaves the record untouched', async () => {
    expect((await call('GET', '/fixture-world/schedules', VIEWER)).status).toBe(403);
    expect((await call('PATCH', '/fixture-world/schedules/ticker-pulse', VIEWER, { enabled: false })).status).toBe(403);
    expect((await store.getSchedule(PULSE_RECORD))?.status).toBe('active');
    expect(await raw.hget('oshal:scheduler:manifest-overrides', 'fixture-world-ticker-pulse')).toBeNull();
  });

  it('lists the manifest schedules with their live records for the operator', async () => {
    const { status, json } = await call('GET', '/fixture-world/schedules', OPERATOR);
    expect(status).toBe(200);
    const pulse = json.schedules.find((s: { id: string }) => s.id === 'ticker-pulse');
    expect(pulse).toMatchObject({ manifestCron: PULSE_CRON, cron: PULSE_CRON, enabled: true, registered: true, controllable: true, override: null });
    expect(json.schedules.find((s: { id: string }) => s.id === 'digest')).toMatchObject({ controllable: false, registered: false });
    expect(json.minIntervalMinutes).toBe(5);
  });
});

describe('on/off and cadence are durable', () => {
  it('a switched-off schedule stops firing and stays off across a restart and an app toggle', async () => {
    const off = await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.schedule).toMatchObject({ enabled: false, status: 'paused', nextRunAt: null });
    expect(await raw.zscore('oshal:scheduler:next-run', PULSE_RECORD)).toBeNull();

    await registerAll(); // restart: the manifest registers again with its own cron
    expect((await store.getSchedule(PULSE_RECORD))?.status).toBe('paused');

    await store.deleteSchedule(PULSE_RECORD); // toggle off deletes the record ...
    await registerAll(); // ... and toggle on registers it from scratch
    expect((await store.getSchedule(PULSE_RECORD))?.status).toBe('paused');
  });

  it('a changed cadence replaces the manifest cron and survives re-registration; null returns to the manifest', async () => {
    const slower = await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { cron: '*/15 8-23 * * 1-5' });
    expect(slower.status).toBe(200);
    expect(slower.json.schedule).toMatchObject({ cron: '*/15 8-23 * * 1-5', manifestCron: PULSE_CRON, enabled: true });
    await registerAll();
    expect((await store.getSchedule(PULSE_RECORD))?.cron).toBe('*/15 8-23 * * 1-5');

    const reset = await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { cron: null, enabled: true });
    expect(reset.json.schedule).toMatchObject({ cron: PULSE_CRON, enabled: true, override: null });
    expect(await raw.hget('oshal:scheduler:manifest-overrides', 'fixture-world-ticker-pulse')).toBeNull();
    await registerAll();
    expect((await store.getSchedule(PULSE_RECORD))?.cron).toBe(PULSE_CRON);
  });

  it('refuses a cadence under the floor, an unreadable cron, an empty body, an unknown and a per-user schedule', async () => {
    const tight = await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { cron: '* * * * *' });
    expect(tight.status).toBe(400);
    expect(tight.json.error).toMatch(/shortest interval allowed is 5 minutes/);
    expect((await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { cron: 'every so often' })).status).toBe(400);
    expect((await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, {})).status).toBe(400);
    expect((await call('PATCH', '/fixture-world/schedules/nope', OPERATOR, { enabled: false })).status).toBe(404);
    expect((await call('PATCH', '/fixture-world/schedules/digest', OPERATOR, { enabled: false })).status).toBe(409);
    expect((await store.getSchedule(PULSE_RECORD))?.cron).toBe(PULSE_CRON);
  });

  it('a stored cron that no longer parses registers the manifest cron instead of dropping the schedule', async () => {
    await raw.hset('oshal:scheduler:manifest-overrides', 'fixture-world-world-refresh',
      JSON.stringify({ cron: 'not a cron', updatedBy: OPERATOR, updatedAt: new Date().toISOString() }));
    await registerAll();
    const record = await store.getSchedule('app_fixture-world-world-refresh');
    expect(record).toMatchObject({ cron: REFRESH_CRON, status: 'active' });
  });
});

describe('a change made while a fire is in flight', () => {
  it('is not undone when the fire finishes', async () => {
    let release!: () => void;
    holdFire = new Promise<void>((resolve) => { release = resolve; });
    const fire = svc.triggerSchedule(PULSE_RECORD);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await call('PATCH', '/fixture-world/schedules/ticker-pulse', OPERATOR, { enabled: false, cron: '*/10 8-23 * * 1-5' })).status).toBe(200);
    release();
    await fire;
    const record = await store.getSchedule(PULSE_RECORD);
    expect(record).toMatchObject({ status: 'paused', cron: '*/10 8-23 * * 1-5', nextRunAt: null, executionCount: 1 });
    expect(record?.lastRunAt).not.toBeNull();
  });

  it('a schedule deleted while its fire runs is not written back', async () => {
    let release!: () => void;
    holdFire = new Promise<void>((resolve) => { release = resolve; });
    const fire = svc.triggerSchedule(PULSE_RECORD);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await store.deleteSchedule(PULSE_RECORD);
    release();
    await fire;
    expect(await store.getSchedule(PULSE_RECORD)).toBeNull();
  });
});
