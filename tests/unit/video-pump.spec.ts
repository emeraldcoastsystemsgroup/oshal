/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the joke-shorts pump: the approval gate survives automation (no standing authorization, no spend), the daily cap is re-checked at approval time as well as at selection, joke seeds rotate instead of repeating, rotation is least-recently-started, and the pump is off unless it is switched on.
 */
/**
 * @description The pump is an automated loop that spends money on a shared machine, so the tests here
 * are about what it must REFUSE to do:
 *
 *   - approve a render for a show the operator never authorized;
 *   - approve past the day's cap, even when a concurrent cycle used the last slot after selection;
 *   - keep telling the same joke;
 *   - run at all without VIDEO_PUMP_ENABLED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/app/routes/remote-client-routes', () => ({
  remoteClientRegistry: { listClients: () => [], enqueueTask: vi.fn(), getCompletedResult: vi.fn(() => null) },
}));

import {
  autoApprovalDecision, nextJokeSeed, pickNextShow, startedTodayCount, startVideoPump, type PumpShow,
} from '@/app/series-pump';
import type { AppContext } from '@/app/composition/app-context';

const show = (over: Partial<PumpShow> = {}): PumpShow => ({
  showId: 's1', userSub: 'u1', slug: 'stupid-superheroes', title: 'Stupid Superheroes',
  premise: 'p', styleLock: null, cast: [], jokeSeeds: [], seedCursor: 0, scenesPerEpisode: 4,
  orientation: 'Landscape', standingAuthorization: false, dailyCap: 1, minIntervalMinutes: 240,
  consecutiveFailures: 0, ...over,
});

describe('the approval gate survives automation', () => {
  it('refuses to approve a show the operator never authorized', () => {
    const d = autoApprovalDecision(show({ standingAuthorization: false, dailyCap: 5 }), 0);
    expect(d.approve).toBe(false);
    expect(d.why).toContain('no standing authorization');
  });

  it('approves an authorized show inside its cap', () => {
    expect(autoApprovalDecision(show({ standingAuthorization: true, dailyCap: 2 }), 1).approve).toBe(true);
  });

  it('refuses once the day\'s cap is used up — the re-check that a race past selection needs', () => {
    // Selection saw 0 of 1 and let this episode start; a concurrent cycle then used the slot, so by
    // approval time the count (which includes this episode) is 2 against a cap of 1.
    const d = autoApprovalDecision(show({ standingAuthorization: true, dailyCap: 1 }), 2);
    expect(d.approve).toBe(false);
    expect(d.why).toContain('daily cap');
  });

  it('a cap of zero authorizes nothing, whatever the standing authorization says', () => {
    expect(autoApprovalDecision(show({ standingAuthorization: true, dailyCap: 0 }), 1).approve).toBe(false);
  });
});

describe('joke seeds', () => {
  const seeds = ['a', 'b', 'c'];

  it('walks the list in order', () => {
    expect(nextJokeSeed(show({ jokeSeeds: seeds, seedCursor: 0 }))).toEqual({ seed: 'a', nextCursor: 1 });
    expect(nextJokeSeed(show({ jokeSeeds: seeds, seedCursor: 1 }))).toEqual({ seed: 'b', nextCursor: 2 });
  });

  it('recycles rather than running out', () => {
    expect(nextJokeSeed(show({ jokeSeeds: seeds, seedCursor: 2 }))).toEqual({ seed: 'c', nextCursor: 0 });
  });

  it('survives a cursor that has drifted out of range', () => {
    expect(nextJokeSeed(show({ jokeSeeds: seeds, seedCursor: 97 })).seed).toBe('b');
    expect(nextJokeSeed(show({ jokeSeeds: seeds, seedCursor: -1 })).seed).toBe('c');
  });

  it('leaves the premise to the writer when a show has no seeds', () => {
    expect(nextJokeSeed(show({ jokeSeeds: [] }))).toEqual({ seed: null, nextCursor: 0 });
  });
});

describe('rotation and the daily cap', () => {
  /** A pool that answers the candidate query, then a count per show. */
  function pool(candidates: Array<Record<string, unknown>>, counts: number[]): Pool {
    let call = 0;
    return {
      query: vi.fn(async () => {
        if (call++ === 0) return { rows: candidates };
        return { rows: [{ n: counts[call - 2] ?? 0 }] };
      }),
    } as unknown as Pool;
  }

  const row = (slug: string, over: Record<string, unknown> = {}) => ({
    show_id: `id-${slug}`, user_sub: 'u1', slug, title: slug, premise: 'p', style_lock: null,
    cast_bible: [], joke_seeds: ['x'], seed_cursor: 0, scenes_per_episode: 4, orientation: 'Landscape',
    standing_authorization: true, daily_cap: 1, min_interval_minutes: 240, consecutive_failures: 0, ...over,
  });

  it('takes the first show in rotation order that is still under its cap', async () => {
    const picked = await pickNextShow(pool([row('breakfast-crew'), row('neon-noodle-jam')], [1, 0]));
    expect(picked?.slug).toBe('neon-noodle-jam');
  });

  it('returns nothing when every due show has hit its cap', async () => {
    expect(await pickNextShow(pool([row('a'), row('b')], [1, 1]))).toBeNull();
  });

  it('returns nothing when no show is due at all', async () => {
    expect(await pickNextShow(pool([], []))).toBeNull();
  });

  it('counts only episodes that actually started — a skipped cycle is not production', async () => {
    const p = { query: vi.fn(async () => ({ rows: [{ n: 3 }] })) } as unknown as Pool;
    await startedTodayCount(p, 's1', new Date('2026-07-29T22:00:00Z'));
    const sql = String((p.query as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(sql).toContain("outcome <> 'skipped'");
  });
});

describe('the pump is opt-in', () => {
  const saved = process.env.VIDEO_PUMP_ENABLED;
  afterEach(() => { if (saved === undefined) delete process.env.VIDEO_PUMP_ENABLED; else process.env.VIDEO_PUMP_ENABLED = saved; });
  beforeEach(() => { delete process.env.VIDEO_PUMP_ENABLED; });

  it('does not start without VIDEO_PUMP_ENABLED', () => {
    expect(startVideoPump({ pool: {} as Pool } as AppContext)).toBeNull();
  });

  it('starts, and hands back a stop handle, when it is switched on', () => {
    process.env.VIDEO_PUMP_ENABLED = 'true';
    const stop = startVideoPump({ pool: {} as Pool } as AppContext, 3_600_000);
    expect(typeof stop).toBe('function');
    stop?.();
  });
});

describe('the ordering the pump depends on', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'series-pump.ts'), 'utf8');

  it('selects least-recently-started first, so one show cannot monopolise the node', () => {
    expect(src).toMatch(/ORDER BY last_started_at ASC NULLS FIRST/);
  });

  it('never selects an auto-paused show', () => {
    expect(src).toMatch(/paused_reason IS NULL/);
  });

  it('checks the node BEFORE opening any work', () => {
    const gate = src.indexOf('checkVidsNodeAvailability(pool');
    const open = src.indexOf('return produceEpisode(');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(open);
  });
});

/**
 * "The conductor is resumable" was only half true: it CAN resume, but nothing asked it to. An
 * episode interrupted between stages parked forever — the daily cap correctly refused to start a
 * replacement, and the render reconciler only looks at episodes already `rendering`. Seen live on
 * 2026-07-29 when another lane's deploy recreated the api mid-storyboard.
 */
describe('an interrupted episode gets picked back up', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'series-pump.ts'), 'utf8');

  it('resumes BEFORE it considers starting anything new', () => {
    const resume = src.indexOf('const resumed = await resumeInFlight(');
    const pick = src.indexOf('const show = await pickNextShow(pool, now)');
    expect(resume).toBeGreaterThan(0);
    expect(resume).toBeLessThan(pick);
  });

  it('returns immediately when it resumed something — one episode at a time, across every show', () => {
    expect(src).toMatch(/const resumed = await resumeInFlight\(ctx, now\);\s*\n\s*if \(resumed\) return resumed;/);
  });

  it('looks for every non-terminal stage, not just the one that failed today', () => {
    expect(src).toMatch(/s\.status IN \('scripting','awaiting_approval','storyboarding','rendering'\)/);
    expect(src).toMatch(/r\.outcome IN \('started','rendering'\)/);
  });

  it('takes the OLDEST open episode, so nothing can be starved by newer work', () => {
    expect(src).toMatch(/ORDER BY r\.created_at ASC\s*\n\s*LIMIT 1/);
  });

  it('re-runs the authorization decision at the gate — a day may have turned over while it sat', () => {
    const gate = src.indexOf("if (String(r.status) === 'awaiting_approval')");
    const decide = src.indexOf('autoApprovalDecision(', gate);
    const approve = src.indexOf('approveSeries(ctx.pool, seriesId)', gate);
    expect(gate).toBeGreaterThan(0);
    expect(decide).toBeGreaterThan(gate);
    expect(decide).toBeLessThan(approve);
  });
});

/**
 * Every show file names a cached intro clip, and five of them have been sitting on the render node
 * since 2026-07-08. Declaring one and never using it is the "documented but not real" failure this
 * project keeps writing rules about, so the wiring is checked end to end: pump → series row →
 * render plan → the node prepending it at the stitch.
 */
describe('a show opens its episodes with its own cached intro', () => {
  const pump = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'series-pump.ts'), 'utf8');
  const dispatch = readFileSync(join(__dirname, '..', '..', 'src', 'app', 'series-dispatch.ts'), 'utf8');
  const renderer = readFileSync(join(__dirname, '..', '..', 'packages', 'oshal-vids-operator', 'episode-render.js'), 'utf8');

  it('the pump copies the show\'s intro onto the series it opens', () => {
    expect(pump).toMatch(/intro_clip/);
    expect(pump).toMatch(/show\.introClip/);
  });

  it('the dispatcher puts it in the render plan', () => {
    expect(dispatch).toMatch(/s\.intro_clip/);
    expect(dispatch).toMatch(/introClip: \(e\.intro_clip as string \| null\) \?\? null/);
  });

  it('the node prepends it BEFORE the scenes', () => {
    expect(renderer).toMatch(/clips\.unshift\(introPath\)/);
  });

  it('a named intro missing from the node does not throw away paid scenes', () => {
    expect(renderer).toMatch(/intro MISSING on this node, continuing without it/);
  });
});
