/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Jarvis "where am I" Test Lab card is registered exactly once with suites that exist on disk, its step passes for real against a disposable PostgreSQL owned by the NOBYPASSRLS runtime role and leaves no synthetic row behind (counted as the superuser, past row-level security), and a run without the server is graded a gap, never a pass.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_WHERE_SCENARIOS } from '@/app/routes/test-lab-location-where-scenarios';
import { countRows, startLocationBrowserServer, type LocationBrowserServer } from '../helpers/location-browser-server';

let fx: LocationBrowserServer;
const [card] = LOCATION_WHERE_SCENARIOS;
const [step] = card.steps;
const runtime = (): ScenarioRunContext =>
  ({ ctx: { pool: fx.runtime } as never, ownerSub: 'mock-user-001', issuer: 'urn:oshal:mock-oidc', apiBaseUrl: fx.base });

/** Every row the step could leave behind, counted as the superuser. */
async function syntheticRows(): Promise<number> {
  const like = "LIKE 'test-lab-location-where-%'";
  const counts = await Promise.all([
    countRows(fx, `location_observations WHERE owner_sub ${like}`),
    countRows(fx, `location_current WHERE owner_sub ${like}`),
    countRows(fx, `location_devices WHERE owner_sub ${like}`),
    countRows(fx, `location_places WHERE owner_sub ${like} OR created_by_sub ${like}`),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

beforeAll(async () => { fx = await startLocationBrowserServer('test-lab-location-where'); }, 180_000);
afterAll(async () => { await fx?.close(); }, 60_000);

describe('Jarvis "where am I" Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    expect(SCENARIOS.filter((s) => s.id === card.id)).toEqual([card]);
    expect(card.steps.map((s) => s.id)).toEqual(['where-am-i']);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes on the real database and leaves nothing behind', async () => {
    const r = await step.run('', {}, runtime());
    expect(r.state, r.detail).toBe('pass');
    expect(r.detail).toContain('5 checks hold');
    expect(await syntheticRows()).toBe(0);
  });

  it('grades a run without the server as a gap, never a pass', async () => {
    expect((await step.run('', {})).state).toBe('gap');
  });
});
