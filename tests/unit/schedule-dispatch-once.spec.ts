/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One dispatch per due occurrence, across the real Redis store (2026-10-03: the index reconcile re-added an in-flight record at its past nextRunAt every 60 s, so a fire longer than a minute ran as up to four concurrent copies — the World depth refresh popped at 02:33:15, 02:34:15 and 02:36:15). A job held open across two reconcile cycles is dispatched once, although the reconcile really does put the past time back in the due index; after it finishes the next occurrence dispatches normally; and a job abandoned at the dispatch timeout releases the guard, so a hung handler never blocks its schedule's next occurrence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A fire whose handler fails releases the guard too (review of core #1030: the `.finally` on the due dispatch is the single release point).
 */

import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The dispatch timeout is read when the service module loads; 60 s is its floor.
vi.hoisted(() => { process.env.SCHEDULE_DISPATCH_TIMEOUT_MS = '60000'; });

import { DisposableRedis } from '../helpers/disposable-redis';
import { RedisScheduleStore, ScheduleService, type ScheduleDispatchResult, type ScheduleRecord } from '../../src/features/scheduling';

const NEXT_RUN_KEY = 'oshal:scheduler:next-run';

let fixture: DisposableRedis;
let raw: Redis;
let store: RedisScheduleStore;
let svc: ScheduleService;
/** Every handler start, in order (the schedule id). */
let calls: string[];
/** Gates the handler waits on, one per start; a test resolves them to let a fire finish. */
let gates: Array<() => void>;

/** Create one unowned schedule and make its occurrence due one second ago. */
async function dueSchedule(taskType: string): Promise<ScheduleRecord> {
  const created = await svc.createSchedule({ taskType, schedule: '0 3 * * *', taskData: { prompt: 'fixture' }, ownerSub: null });
  return makeDue(created.id);
}

/** Put a schedule's next occurrence one second in the past (what a due record looks like). */
async function makeDue(id: string): Promise<ScheduleRecord> {
  const record = (await store.getSchedule(id))!;
  const due = { ...record, status: 'active' as const, nextRunAt: new Date(Date.now() - 1000).toISOString() };
  await store.saveSchedule(due);
  return due;
}

/** One reconcile cycle followed by one runner cycle, as the scheduler does every minute. */
async function reconcileThenPop(): Promise<number> {
  await store.reconcileScheduleIndex();
  return svc.dispatchDueSchedules();
}

beforeAll(async () => {
  fixture = new DisposableRedis({ purpose: 'schedule-dispatch-once' });
  const conn = await fixture.start();
  raw = new Redis(conn.url);
  store = new RedisScheduleStore({ redisUrl: conn.url });
  svc = new ScheduleService(store, async (schedule): Promise<ScheduleDispatchResult> => {
    calls.push(schedule.id);
    if (schedule.taskType.includes('failing')) throw new Error('fixture handler failure');
    await new Promise<void>((resolve) => { gates.push(resolve); });
    return { success: true, scheduleId: schedule.id };
  }, { ensureSchedulingEnabled: async () => undefined });
}, 240_000);

afterAll(async () => {
  for (const release of gates ?? []) release();
  await store?.close();
  raw?.disconnect();
  await fixture?.stop();
  delete process.env.SCHEDULE_DISPATCH_TIMEOUT_MS;
});

beforeEach(async () => {
  for (const release of gates ?? []) release();
  calls = [];
  gates = [];
  await raw.flushall();
});

describe('one dispatch per due occurrence', () => {
  it('a fire held open across two reconcile cycles is dispatched once; the next occurrence dispatches after it finishes', async () => {
    const record = await dueSchedule('dispatch-once-fixture');
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000, interval: 25 });

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await store.reconcileScheduleIndex();
      // The reconcile really does hand the past occurrence back to the due index...
      expect(Number(await raw.zscore(NEXT_RUN_KEY, record.id))).toBe(Date.parse(record.nextRunAt!));
      // ...and the runner must not dispatch it a second time.
      expect(await svc.dispatchDueSchedules()).toBe(0);
    }
    expect(calls).toEqual([record.id]);

    gates.shift()!();
    await vi.waitFor(async () => expect((await store.getSchedule(record.id))?.executionCount).toBe(1), { timeout: 10_000, interval: 25 });
    const finished = (await store.getSchedule(record.id))!;
    expect(Date.parse(finished.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(await reconcileThenPop()).toBe(0);

    await makeDue(record.id); // the next occurrence comes due
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(() => expect(calls).toEqual([record.id, record.id]), { timeout: 10_000, interval: 25 });
  }, 60_000);

  it('a fire whose handler fails releases the guard, so its next occurrence still dispatches', async () => {
    const record = await dueSchedule('dispatch-failing-fixture');
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(async () => {
      const skipped = (await store.getSchedule(record.id))!;
      expect(Date.parse(skipped.nextRunAt!)).toBeGreaterThan(Date.now());
    }, { timeout: 10_000, interval: 25 });
    expect(calls).toEqual([record.id]);

    await makeDue(record.id);
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(() => expect(calls).toEqual([record.id, record.id]), { timeout: 10_000, interval: 25 });
  }, 60_000);

  it('a fire abandoned at the dispatch timeout releases the guard, so its next occurrence still dispatches', async () => {
    const record = await dueSchedule('dispatch-timeout-fixture');
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000, interval: 25 });

    // The handler never finishes on its own; at 60 s the scheduler abandons it and skips the occurrence.
    await vi.waitFor(async () => {
      const skipped = (await store.getSchedule(record.id))!;
      expect(Date.parse(skipped.nextRunAt!)).toBeGreaterThan(Date.now());
    }, { timeout: 90_000, interval: 500 });
    expect((await store.getSchedule(record.id))?.executionCount).toBe(0);

    await makeDue(record.id); // the next occurrence comes due while the abandoned fire is still running
    expect(await svc.dispatchDueSchedules()).toBe(1);
    await vi.waitFor(() => expect(calls).toEqual([record.id, record.id]), { timeout: 10_000, interval: 25 });

    // Let the abandoned fire finish first, then the next occurrence's: each completion is recorded.
    gates.shift()!();
    await vi.waitFor(async () => expect((await store.getSchedule(record.id))?.executionCount).toBe(1), { timeout: 10_000, interval: 25 });
    gates.shift()!();
    await vi.waitFor(async () => expect((await store.getSchedule(record.id))?.executionCount).toBe(2), { timeout: 10_000, interval: 25 });
    expect((await store.getSchedule(record.id))?.status).toBe('active');
  }, 150_000);
});
