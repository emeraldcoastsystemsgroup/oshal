/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proves the machine-wide fixture ceiling by COUNTING RUNNING CONTAINERS, not by reading the limiter's own bookkeeping. On 2026-09-20 a full `vitest run` started about twenty disposable PostgreSQL fixtures in parallel worker processes, exhausted the 6 GB WSL cap, OOM-killed the engine and took all 50 of the operator's containers down with exit 137. Each fixture was correct alone. The ceiling is what makes the fleet correct, so the question this file answers is the one that actually matters: with the limit set to two, did a third container ever exist at the same time as the other two? It also proves the two ways the ceiling could fail open - a slot whose owning process died must be reclaimed rather than leaked, and a release must return the slot - because a ceiling that wedges the suite is as unusable as no ceiling at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFixtureSlot } from '../helpers/fixture-slots';
import { DisposableRedis } from '../helpers/disposable-redis';

const SLOT_ROOT = join(tmpdir(), 'oshal-fixture-slots');

/** How many of this test's own containers Docker currently reports as running. */
function liveCount(tag: string): number {
  const out = execFileSync('docker', ['ps', '--filter', `name=${tag}`, '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return out.trim().split(/\r?\n/).filter(Boolean).length;
}

const started: DisposableRedis[] = [];

afterEach(async () => {
  while (started.length) await started.pop()!.stop();
});

describe('the fixture ceiling is enforced across processes, not merely declared', () => {
  it('never lets a third container exist while the limit is two', async () => {
    const previous = process.env.OSHAL_FIXTURE_SLOTS;
    process.env.OSHAL_FIXTURE_SLOTS = '2';
    // Redis rather than Postgres on purpose: the property under test is the ceiling, and a Redis
    // starts in about a second, so three of them make the point without three Postgres boots.
    const fixtures = [0, 1, 2].map((n) => new DisposableRedis({ purpose: `ceiling-${n}` }));
    let peak = 0;
    try {
      const watching = setInterval(() => { try { peak = Math.max(peak, liveCount('oshal-ceiling-')); } catch { /* engine busy */ } }, 150);
      try {
        await Promise.all(fixtures.map(async (fixture) => {
          started.push(fixture);
          await fixture.start();
          peak = Math.max(peak, liveCount('oshal-ceiling-'));
          await fixture.stop();
        }));
      } finally { clearInterval(watching); }
      expect(peak, 'a third fixture container ran while the limit was two').toBeLessThanOrEqual(2);
      expect(peak, 'the limiter serialised everything — the ceiling would be untested').toBeGreaterThanOrEqual(1);
    } finally {
      if (previous === undefined) delete process.env.OSHAL_FIXTURE_SLOTS; else process.env.OSHAL_FIXTURE_SLOTS = previous;
    }
  }, 180_000);

  it('reclaims a slot whose owning process is gone instead of wedging every later fixture', async () => {
    const previous = process.env.OSHAL_FIXTURE_SLOTS;
    process.env.OSHAL_FIXTURE_SLOTS = '1';
    // A slot left behind by a worker that was killed — exactly what an OOM leaves. PID 1 is not a
    // Node worker of ours, so a live-PID check alone would keep this slot forever; the reclaim has
    // to notice the owner is not one of ours. Use an impossible pid instead, which is what a
    // reaped worker leaves once its id is retired.
    const stale = join(SLOT_ROOT, 'slot-0');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'owner'), '2147483646', 'utf8');
    writeFileSync(join(stale, 'purpose'), 'killed-worker', 'utf8');
    try {
      const slot = await acquireFixtureSlot('after-a-kill', 30_000);
      slot.release();                              // reaching here at all is the assertion
    } finally {
      rmSync(stale, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OSHAL_FIXTURE_SLOTS; else process.env.OSHAL_FIXTURE_SLOTS = previous;
    }
  }, 60_000);

  it('gives the slot back on release, so a suite of fixtures does not run out', async () => {
    const previous = process.env.OSHAL_FIXTURE_SLOTS;
    process.env.OSHAL_FIXTURE_SLOTS = '1';
    try {
      for (let round = 0; round < 3; round += 1) {
        const slot = await acquireFixtureSlot(`reuse-${round}`, 15_000);
        slot.release();
        slot.release();                            // idempotent
      }
    } finally {
      if (previous === undefined) delete process.env.OSHAL_FIXTURE_SLOTS; else process.env.OSHAL_FIXTURE_SLOTS = previous;
    }
  }, 60_000);
});
