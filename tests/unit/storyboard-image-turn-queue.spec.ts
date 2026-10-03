/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for ImageTurnQueue, the in-process queue that lets each render bot run one image turn at a time (operator decision 2026-10-03, "Throttle image renders"). No doubles: the real class under fake timers (setTimeout and Date). Pins: one turn at a time per bot, in arrival order; two bots do not wait for each other; a waiter whose startBy passes gives up its place with started:false and the queue moves on to the next waiter (it is never wedged by one that left); a start-by time already past is refused even when the bot is free (no attempt starts that cannot finish in budget); the turn is released when the work throws; the wait is reported. The same queue is crossed through the real executor wiring in storyboard-cli-image-wiring.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageTurnQueue } from '../../src/app/storyboard-image-turn-queue';

const BOT = 'a0000000-0000-0000-0000-000000000099';
const OTHER_BOT = 'a0000000-0000-0000-0000-000000000042';

/** A piece of work the test finishes by hand, recording when it started. */
function heldWork(name: string, log: string[]): { work: () => Promise<string>; finish: () => void; fail: () => void } {
  let finish: () => void = () => undefined;
  let fail: () => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve(name);
    fail = () => reject(new Error(`${name} failed`));
  });
  return { work: () => { log.push(`start ${name}`); return done; }, finish: () => finish(), fail: () => fail() };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('ImageTurnQueue: one image turn at a time per render bot', () => {
  it('runs one turn at a time per bot, in arrival order, and reports how long each waited', async () => {
    const queue = new ImageTurnQueue();
    const log: string[] = [];
    const [a, b, c] = ['a', 'b', 'c'].map((name) => heldWork(name, log));
    const runs = [queue.run(BOT, undefined, a.work), queue.run(BOT, undefined, b.work), queue.run(BOT, undefined, c.work)];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual(['start a']);
    expect(queue.busy(BOT)).toBe(true);
    a.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start a', 'start b']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(log, 'c still waits while b holds the turn').toEqual(['start a', 'start b']);
    b.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start a', 'start b', 'start c']);
    c.finish();
    expect(await Promise.all(runs)).toEqual([
      { started: true, value: 'a', waitedMs: 0 },
      { started: true, value: 'b', waitedMs: 1_000 },
      { started: true, value: 'c', waitedMs: 3_000 },
    ]);
    expect(queue.busy(BOT), 'the line is dropped once nobody holds or waits').toBe(false);
  });

  it('two render bots do not wait for each other', async () => {
    const queue = new ImageTurnQueue();
    const log: string[] = [];
    const [a, other] = [heldWork('a', log), heldWork('other', log)];
    const runs = [queue.run(BOT, undefined, a.work), queue.run(OTHER_BOT, undefined, other.work)];
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start a', 'start other']);
    a.finish();
    other.finish();
    expect((await Promise.all(runs)).map((run) => run.started)).toEqual([true, true]);
  });

  it('a waiter whose start-by time passes gives up its place, and the queue moves on to the next waiter', async () => {
    const queue = new ImageTurnQueue();
    const log: string[] = [];
    const [holder, late, patient] = ['holder', 'late', 'patient'].map((name) => heldWork(name, log));
    const first = queue.run(BOT, undefined, holder.work);
    const gaveUp = queue.run(BOT, Date.now() + 500, late.work);
    const next = queue.run(BOT, undefined, patient.work);
    await vi.advanceTimersByTimeAsync(500);
    expect(await gaveUp).toEqual({ started: false, waitedMs: 500 });
    holder.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start holder', 'start patient']);
    patient.finish();
    expect((await first).started).toBe(true);
    expect(await next).toEqual({ started: true, value: 'patient', waitedMs: 500 });
    expect(queue.busy(BOT)).toBe(false);
  });

  it('a start-by time already past is refused even when the bot is free: no attempt starts that cannot finish in time', async () => {
    const queue = new ImageTurnQueue();
    const log: string[] = [];
    const work = heldWork('too-late', log);
    expect(await queue.run(BOT, Date.now() - 1, work.work)).toEqual({ started: false, waitedMs: 0 });
    expect(log).toEqual([]);
    expect(queue.busy(BOT)).toBe(false);
  });

  it('the turn passes on when the work throws', async () => {
    const queue = new ImageTurnQueue();
    const log: string[] = [];
    const [broken, after] = [heldWork('broken', log), heldWork('after', log)];
    const failed = queue.run(BOT, undefined, broken.work);
    const next = queue.run(BOT, undefined, after.work);
    broken.fail();
    await expect(failed).rejects.toThrow('broken failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start broken', 'start after']);
    after.finish();
    expect((await next).started).toBe(true);
    expect(queue.busy(BOT)).toBe(false);
  });
});
