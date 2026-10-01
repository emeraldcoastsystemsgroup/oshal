/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Jarvis "where am I" on a private PostgreSQL whose tables the NOSUPERUSER NOBYPASSRLS runtime role owns (FORCE row-level security is what holds). Fixes go through the real browser ingest of an opted-in device. A person with no position is pointed to Settings, Location; a fresh fix inside a saved place is answered with that place; a fix outside every saved place says so and offers to save it; an old fix leads with its age; no answer carries a coordinate; and a second person asking sees no position at all, because the read runs under their own owner session. Synthetic identities and coordinates only.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocationPrincipal } from '@/features/location';
import { optInBrowserDevice } from '@/app/location-consent';
import { runJarvisLocationTurn } from '@/app/location-jarvis-intent';
import { createLocationPlace, parsePlaceInput } from '@/app/location-places';
import { ingestBrowserFix, parseBrowserFix } from '@/app/location-presence';
import { EARTH_RADIUS_M, type GeoPoint } from '@/shared/utils/geo';
import { FIXTURE_ISSUER, convergeAppRole, locationDatabase } from '../helpers/location-postgres-fixture';

const db = locationDatabase('location-where-am-i');
let app: Pool;
const CENTER = { lat: -21.4712, lon: -27.3051 };
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const north = (p: GeoPoint, metres: number): GeoPoint => ({ lat: p.lat + metres * DEG_PER_M, lon: p.lon });
const principal = (sub: string): LocationPrincipal => ({ sub, principalIssuer: FIXTURE_ISSUER });
/** Any decimal with two or more places: a coordinate, however it was rounded. */
const COORDINATE = /\d+\.\d{2,}/;

/** Ask "where am I" as this person at a given clock. */
const ask = (who: LocationPrincipal, nowMs: number = Date.now()): Promise<string> =>
  runJarvisLocationTurn(app, { kind: 'where', principal: who }, nowMs);

/** A person with an opted-in browser device, a saved "Home" around CENTER, and one fix at `point`. */
async function personAt(sub: string, point: GeoPoint): Promise<{ who: LocationPrincipal; fixedAt: number }> {
  const who = principal(sub);
  const device = await optInBrowserDevice(app, who, { deviceId: null, precisionClass: 'block' });
  await createLocationPlace(app, who, parsePlaceInput({ name: 'Home', label: 'home', center: CENTER, radiusM: 150 }, 'create'));
  const fixedAt = Date.now();
  await ingestBrowserFix(app, who, parseBrowserFix({ deviceId: device.deviceId, lat: point.lat, lon: point.lon, accuracyM: 10,
    observedAt: new Date(fixedAt).toISOString() }, fixedAt), { minIntervalMs: 0, nowMs: fixedAt });
  return { who, fixedAt };
}

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
}, 180_000);

afterAll(async () => { await db.stop(); }, 60_000);

describe('Jarvis "where am I" answers from the person\'s own latest position, by reference only', () => {
  it('points a person with no position yet to Settings, Location', async () => {
    const answer = await ask(principal('where-nobody'));
    expect(answer).toContain('I don\'t have a position for you yet');
    expect(answer).toContain('/cockpit/tools/location.html');
  });

  it('names the saved place a fresh fix fell in, without a coordinate', async () => {
    const { who, fixedAt } = await personAt('where-at-home', CENTER);
    const answer = await ask(who, fixedAt + 20_000);
    expect(answer).toBe('You\'re at Home (updated just now).');
    expect(answer).not.toMatch(COORDINATE);
  });

  it('says a fix outside every saved place is in none of them, and offers to save it', async () => {
    const { who, fixedAt } = await personAt('where-away', north(CENTER, 2_000));
    const answer = await ask(who, fixedAt + 4 * 60_000);
    expect(answer).toMatch(/^You're not at one of your saved places \(updated 4 min ago\)\./);
    expect(answer).toContain('save where you are as a place');
    expect(answer).not.toMatch(COORDINATE);
  });

  it('leads with the age of an old fix instead of presenting it as now', async () => {
    const { who, fixedAt } = await personAt('where-stale', CENTER);
    const answer = await ask(who, fixedAt + 3 * 3600_000 + 60_000);
    expect(answer).toMatch(/^As of 3 hours ago, you were at Home\. No device has reported since/);
  });

  it('shows a second person nothing of the first person\'s position', async () => {
    await personAt('where-owner', CENTER);
    const answer = await ask(principal('where-other'));
    expect(answer).toContain('I don\'t have a position for you yet');
    expect(answer).not.toContain('Home');
  });
});
