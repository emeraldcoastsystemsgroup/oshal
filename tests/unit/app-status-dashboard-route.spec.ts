/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-145 REAL-BOUNDARY guard. The seam this contract exists to protect is app-declares / kernel-calls, so the guard crosses it for real: startAppStatusDashboardFixture puts the REAL swarm-app router (real SwarmAppService, real manifest resolution, real getAppStatusPlan) and synthetic packages on one live listener, and every assertion below is made over an actual HTTP round trip — the plan is fetched, then the probe path the plan named is fetched at that same origin and coerced by the shipped coercion. No resolver, route, mount or probe is mocked. Doubled, and named as such: the installation repository, the pg driver behind the D5 fallback read, and the caller's identity middleware.
 */

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { coerceSummaryPayload } from '@/features/swarm-apps';
import {
  FIXTURE_CALLER,
  startAppStatusDashboardFixture,
  type AppStatusDashboardFixture,
} from '../fixtures/app-status-dashboard';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let fixture: AppStatusDashboardFixture;

beforeAll(async () => { fixture = await startAppStatusDashboardFixture(); });
afterAll(async () => { await fixture?.close(); });
afterEach(() => fixture.resetQuery());

/**
 * @description Fetch JSON over the real listener, the way the page does.
 * @param path - An absolute path on the fixture origin.
 * @returns The status and parsed body.
 */
async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${fixture.origin}${path}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('GET /:name/setup over a real HTTP mount — an APP, not only a group (ADR-145 D4)', () => {
  it('resolves a plain app and names the probe path the app itself declared', async () => {
    const { status, body } = await get('/api/swarm/apps/fixture-ok/setup');
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'fixture-ok', kind: 'app', members: ['fixture-ok'] });
    expect(body.summary).toEqual([expect.objectContaining({ app: 'fixture-ok', path: '/api/fixture-ok/summary' })]);
    expect(body.steps[0]).toMatchObject({ label: 'Connect inbox', probe: { path: '/api/fixture-ok/state' } });
    expect(body.steps[1]).toMatchObject({ label: 'Import history', probe: { path: '/api/fixture-ok/history' } });
  });

  it('asks the declared probe at that same origin and bounds what comes back (D2)', async () => {
    const plan = (await get('/api/swarm/apps/fixture-ok/setup')).body;
    const probe = plan.summary[0];
    const answered = await get(probe.path);
    expect(answered.status).toBe(200);

    const coerced = coerceSummaryPayload(answered.body, probe);
    expect(coerced.checked).toBe(true);
    // Over-cap TRUNCATES rather than rejecting: five tiles in, four out.
    expect(coerced.tiles).toHaveLength(4);
    expect(coerced.tiles.map((t) => t.value)).toEqual(['116W-215L', '-$18.24', '3', '9']);
    // An unrecognised tone degrades to neutral and never escalates.
    expect(coerced.tiles[1].tone).toBe('neutral');
    expect(coerced.tiles[2].tone).toBe('good');
    expect(coerced.items.map((i) => i.text)).toContain('4 documents awaiting your approval');
  });

  it('a readiness probe answered over the same mount reads true, so the step is done', async () => {
    const plan = (await get('/api/swarm/apps/fixture-ok/setup')).body;
    expect((await get(plan.steps[0].probe.path)).body.ready).toBe(true);
    expect((await get(plan.steps[1].probe.path)).body.ready).toBe(false);
  });

  it('a probe that answers HTTP 500 is "can\'t check" — never a green state and never a zero', async () => {
    const plan = (await get('/api/swarm/apps/fixture-broken/setup')).body;
    const answered = await get(plan.summary[0].path);
    expect(answered.status).toBe(500);
    // The page treats a non-ok answer as unchecked; nothing about the app is asserted.
    const coerced = coerceSummaryPayload(answered.body, plan.summary[0]);
    expect(coerced.checked).toBe(false);
    expect(coerced.tiles).toEqual([]);
  });

  it('a pointer that resolves to the WRONG TYPE is "can\'t check", not an empty fact', async () => {
    const plan = (await get('/api/swarm/apps/fixture-typed/setup')).body;
    const answered = await get(plan.summary[0].path);
    expect(answered.status).toBe(200);
    expect(coerceSummaryPayload(answered.body, plan.summary[0])).toMatchObject({ checked: false, tiles: [] });
  });
});

describe('GET /:name/setup — the D5 fallback and the visibility rule', () => {
  it('an app that declares no summary: gets items from THIS user\'s own jarvis_tasks rows', async () => {
    const { body } = await get('/api/swarm/apps/fixture-quiet/setup');
    expect(body.undeclared).toEqual([{ name: 'fixture-quiet', displayName: 'fixture-quiet display' }]);
    expect(body.fallbackItems.map((i: { text: string }) => i.text)).toEqual([
      'swept the queue — done (today)',
      'reconciled the ledger — failed (today)',
    ]);
    expect(body.fallbackItems[1].tone).toBe('warn');
    // Scoped to the caller, and to this app's own title prefixes — never a whole-table read.
    expect(fixture.lastQuery()?.values[0]).toBe(FIXTURE_CALLER);
    expect(fixture.lastQuery()?.values[1]).toEqual(['fixture-quiet display:%', 'fixture-quiet:%']);
  });

  it('an app that DOES declare summary: never triggers the fallback read', async () => {
    const { body } = await get('/api/swarm/apps/fixture-ok/setup');
    expect(body.fallbackItems).toEqual([]);
    expect(fixture.lastQuery()).toBeNull();
  });

  it('404s for an unknown name and for an app this caller may not see, indistinguishably', async () => {
    expect((await get('/api/swarm/apps/not-installed/setup')).status).toBe(404);
    expect((await get('/api/swarm/apps/fixture-private/setup')).status).toBe(404);
  });
});

describe('GET /:name/setup-dashboard — the kernel page is served for an app, not only a group', () => {
  it('serves the shipped page for a plain app and 404s for a name that resolves to nothing', async () => {
    const page = await fetch(`${fixture.origin}/api/swarm/apps/fixture-ok/setup-dashboard`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("What's going on");
    expect(html).toContain('What still needs you');
    expect((await fetch(`${fixture.origin}/api/swarm/apps/not-installed/setup-dashboard`)).status).toBe(404);
    expect((await fetch(`${fixture.origin}/api/swarm/apps/fixture-private/setup-dashboard`)).status).toBe(404);
  });
});
