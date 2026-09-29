/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 done-when, person reminders end to end on a private PostgreSQL whose tables the NOSUPERUSER NOBYPASSRLS runtime role owns (FORCE row-level security is what holds). Every fix goes through the real browser ingest with a scripted server clock: a 100 m place fires for a person stored at block precision on a point whose stored (rounded) form lies outside the place; a scripted visit enters once through edge jitter, holds a pending exit through a short absence, exits after three minutes and is held by the cooldown on a quick return; a back-dated observation does not qualify; a once rule fires once and finishes. Fires are dispatched after commit under the rule's actor over the production Jarvis shelf rail (ids only) and a real NotificationRouter whose senders report their tier: a deployment-tier SMS carries only the generic text, an own-tier email the full reminder; the daily cap holds; the recovery sweep delivers a fire no dispatcher took. An operator-stamped admin session then finds no place, subject or reminder text in jarvis_tasks or tickets and no location rule row at all. The Jarvis "I'm at the grocery store, remind me next time" turn proposes a place at the current fix, saves it on "yes", and the reminder fires on the next visit, not now; "the grocery store" later resolves to that saved place, and a place never saved gets the offer. The owner's purge removes the evaluation history. Synthetic identities and coordinates only.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { purgeOwnLocationHistory, type LocationPrincipal } from '@/features/location';
import { NotificationRouter, upsertUserPref, type UserNotifyMessage } from '@/features/notifications';
import { optInBrowserDevice } from '@/app/location-consent';
import {
  LOCATION_GENERIC_TEXT, defaultLocationDeliveryRails, dispatchClaimedFires, locationShelfTaskId, sweepPendingLocationFires,
  tierAwareSenders, type LocationDeliveryRails,
} from '@/app/location-fire-dispatch';
import { clearLocationProposals, parseLocationReminder, runJarvisLocationTurn, type JarvisLocationTurn } from '@/app/location-jarvis-intent';
import { createLocationPlace, parsePlaceInput } from '@/app/location-places';
import { ingestBrowserFix, parseBrowserFix } from '@/app/location-presence';
import { createLocationRule, listLocationFires, listLocationRules, parseRuleInput } from '@/app/location-rules';
import type { NotificationSenders, NotifyChannelTier, TieredChannelSender } from '@/app/routes/notify-routes';
import { EARTH_RADIUS_M, haversineM, minimiseGeoPoint, type GeoPoint } from '@/shared/utils/geo';
import { FIXTURE_ISSUER, asSession, convergeAppRole, locationDatabase, type FixtureSession } from '../helpers/location-postgres-fixture';

const EXTRA = ['005-conversation-history-and-usage.sql', '079-notification-prefs.sql',
  '099-notify-voice-channel.sql', '100-jarvis-tasks-base-schema.sql', '100-ticket-family-base-schema.sql'];
const db = locationDatabase('location-reminders', EXTRA);
let app: Pool;
const T0 = Date.now() - 6 * 3600_000;
const CENTER = { lat: -12.3464, lon: -31.9884 };
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const offset = (p: GeoPoint, northM: number, eastM = 0): GeoPoint => ({
  lat: p.lat + northM * DEG_PER_M, lon: p.lon + eastM * DEG_PER_M / Math.cos((p.lat * Math.PI) / 180),
});
const ROOT: FixtureSession = { sub: 'loc-l5-root', operator: true };
const principal = (sub: string): LocationPrincipal => ({ sub, principalIssuer: FIXTURE_ISSUER });

/** Sent messages per channel, with the tier each sender reported. */
const sent: Array<{ channel: string; sub: string; tier: NotifyChannelTier; message: UserNotifyMessage }> = [];

/** A fake sender with a fixed tier per channel: it records what the router hands it. */
function fakeSender(channel: 'email' | 'sms' | 'voice' | 'telegram', tier: NotifyChannelTier): TieredChannelSender {
  return {
    channel, tier: async () => tier, available: async () => tier !== 'unavailable',
    async send(sub, _pref, message) { sent.push({ channel, sub, tier, message }); return { delivered: true, id: `fake-${sent.length}` }; },
  };
}

const senders: NotificationSenders = {
  email: fakeSender('email', 'own'), sms: fakeSender('sms', 'deployment'), voice: fakeSender('voice', 'deployment'), telegram: fakeSender('telegram', 'deployment'),
};

/** The production shelf rail and a real NotificationRouter over the tier-aware wrap of the fake senders. */
function rails(): LocationDeliveryRails {
  const router = new NotificationRouter({ pool: db.pool, senders: tierAwareSenders(senders), defaultChannel: async () => 'email' });
  return { shelf: defaultLocationDeliveryRails(app).shelf, notify: (actor, message) => router.notify(actor.sub, 'location', message) };
}

/** A person with an opted-in browser device at a precision class. */
async function person(sub: string, precisionClass: 'exact' | 'block'): Promise<{ who: LocationPrincipal; deviceId: string }> {
  const device = await optInBrowserDevice(app, principal(sub), { deviceId: null, precisionClass });
  return { who: principal(sub), deviceId: device.deviceId };
}

/** One browser fix through the real ingest at scripted second `s`; returns the fire ids it claimed. */
async function fixAt(p: { who: LocationPrincipal; deviceId: string }, point: GeoPoint, s: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const t = T0 + s * 1000;
  const claimed: string[] = [];
  await ingestBrowserFix(app, p.who, parseBrowserFix({ deviceId: p.deviceId, lat: point.lat, lon: point.lon, accuracyM: 10,
    observedAt: new Date(t).toISOString(), ...extra }, t), { minIntervalMs: 0, nowMs: t, onFired: (ids) => claimed.push(...ids) });
  return claimed;
}

/** A place of the person's own (at `center`, 100 m) and a remind rule at it. */
async function placeWithRule(who: LocationPrincipal, name: string, rule: Record<string, unknown>, center: GeoPoint = CENTER): Promise<{ placeId: string; ruleId: string }> {
  const place = await createLocationPlace(app, who, parsePlaceInput({ name, label: 'grocery', center, radiusM: 100 }, 'create'));
  const created = await createLocationRule(app, who, parseRuleInput({ placeId: place.placeId, action: { kind: 'remind', text: 'buy milk' }, ...rule }));
  return { placeId: place.placeId, ruleId: created.ruleId };
}

const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.pool.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n);

beforeAll(async () => {
  await db.start();
  app = await convergeAppRole(db);
}, 180_000);

afterAll(async () => { await db.stop(); }, 60_000);

describe('evaluation on the full-precision fix (D3 precision minimisation, D4)', () => {
  it('fires a 100 m place for a person stored at block precision, on a point whose stored form lies outside it', async () => {
    // A centre 95 m south of a 3-decimal rounding boundary: a fix 95 m north of it is inside the
    // place, and block precision stores it about 54 m further north, outside the place.
    const center = { lat: -12.346344, lon: -31.988 };
    const p = await person('loc-l5-block', 'block');
    await placeWithRule(p.who, 'Grocery', { repeat: 'every-visit' }, center);
    let inside: GeoPoint | null = null;
    for (let n = 70; n <= 96 && !inside; n += 1) {
      const candidate = offset(center, n);
      const stored = minimiseGeoPoint(candidate, 'block') as GeoPoint;
      if (haversineM(center, candidate) <= 96 && haversineM(center, stored) > 100) inside = candidate;
    }
    expect(inside).not.toBeNull();
    expect(await fixAt(p, offset(center, 2000), 0)).toEqual([]);
    expect(await fixAt(p, inside as GeoPoint, 60)).toEqual([]);
    expect(await fixAt(p, inside as GeoPoint, 95)).toHaveLength(1);
    const stored = (await db.pool.query('SELECT lat, lon FROM location_observations WHERE owner_sub = $1 ORDER BY received_at DESC LIMIT 1', [p.who.sub])).rows[0];
    expect(haversineM(center, { lat: Number(stored.lat), lon: Number(stored.lon) })).toBeGreaterThan(100);
  });
});

describe('a scripted visit through the real ingest (hysteresis, cooldown, once, stale)', () => {
  const visit: Array<[number, number]> = [
    [2000, 0], [95, 60], [105, 75], [98, 95], [99, 125],
    [110, 160], [140, 230], [60, 260],
    [400, 300], [400, 360], [80, 400],
    [400, 500], [400, 600], [400, 680],
    [0, 700], [0, 730],
  ];

  it('enters once through edge jitter, cancels a short absence, exits after 3 min, and the cooldown holds a quick return', async () => {
    const p = await person('loc-l5-visit', 'exact');
    const { ruleId } = await placeWithRule(p.who, 'Grocery', { repeat: 'every-visit' });
    const fired: number[] = [];
    for (const [metres, s] of visit) if ((await fixAt(p, offset(CENTER, metres), s)).length) fired.push(s);
    expect(fired).toEqual([125]);
    const state = (await db.pool.query('SELECT presence, fire_count, transition_seq FROM location_rule_state WHERE rule_id = $1', [ruleId])).rows[0];
    expect(state).toEqual({ presence: 'inside', fire_count: 1, transition_seq: 4 });
    for (const [metres, s] of [[400, 800], [400, 900], [400, 1000], [0, 1700], [0, 1730]] as Array<[number, number]>) {
      if ((await fixAt(p, offset(CENTER, metres), s)).length) fired.push(s);
    }
    expect(fired).toEqual([125, 1730]);
  });

  it('a back-dated observation does not qualify, and a once rule fires once then finishes', async () => {
    const p = await person('loc-l5-once', 'exact');
    const { ruleId } = await placeWithRule(p.who, 'Grocery', { repeat: 'once' });
    await fixAt(p, offset(CENTER, 2000), 0);
    const backDated = new Date(T0 + 60_000 - 600_000).toISOString();
    expect(await fixAt(p, CENTER, 60, { observedAt: backDated })).toEqual([]);
    expect(await fixAt(p, CENTER, 90)).toEqual([]);
    expect(await fixAt(p, CENTER, 120)).toHaveLength(1);
    for (const [m, s] of [[400, 200], [400, 300], [400, 400], [0, 500], [0, 540]] as Array<[number, number]>) expect(await fixAt(p, offset(CENTER, m), s)).toEqual([]);
    expect((await db.pool.query('SELECT completed_at IS NOT NULL AS done FROM location_rules WHERE rule_id = $1', [ruleId])).rows[0].done).toBe(true);
    const rules = await listLocationRules(app, p.who);
    expect(rules.mine[0].completedAt).not.toBeNull();
  });
});

describe('two-rail delivery with tier-aware text (D4 "Action routing")', () => {
  it('sends only the generic text over a deployment-tier SMS, the full reminder over own-tier email, and a shelf row with ids only', async () => {
    const texting = await person('loc-l5-sms', 'exact');
    const mailing = await person('loc-l5-mail', 'exact');
    await upsertUserPref(db.pool, { userSub: texting.who.sub, topic: 'location', channel: 'sms', enabled: true, quietHoursStart: null, quietHoursEnd: null, phone: '+15555550100', telegramChatId: null });
    const fireIds: string[] = [];
    for (const p of [texting, mailing]) {
      const place = await createLocationPlace(app, p.who, parsePlaceInput({ name: 'Hardware store', center: CENTER, radiusM: 100 }, 'create'));
      await createLocationRule(app, p.who, parseRuleInput({ placeId: place.placeId, action: { kind: 'remind', text: 'buy batteries' } }));
      await fixAt(p, offset(CENTER, 2000), 3000);
      await fixAt(p, CENTER, 3060);
      const ids = await fixAt(p, CENTER, 3090);
      expect(ids).toHaveLength(1);
      expect(await dispatchClaimedFires(app, rails(), ids, p.who)).toEqual({ [ids[0]]: 'delivered' });
      fireIds.push(ids[0]);
    }
    const sms = sent.filter((m) => m.sub === texting.who.sub);
    expect(sms).toEqual([{ channel: 'sms', sub: texting.who.sub, tier: 'deployment', message: { subject: 'You have a location reminder', body: LOCATION_GENERIC_TEXT, shortText: LOCATION_GENERIC_TEXT } }]);
    const mail = sent.filter((m) => m.sub === mailing.who.sub);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ channel: 'email', tier: 'own' });
    expect(mail[0].message.body).toContain('buy batteries');
    const shelf = (await db.pool.query('SELECT id, user_sub, title, result, status FROM jarvis_tasks WHERE id = ANY($1::text[]) ORDER BY id', [fireIds.map(locationShelfTaskId)])).rows;
    expect(shelf).toHaveLength(2);
    for (const row of shelf) {
      expect(row).toMatchObject({ title: 'Location reminder', status: 'done' });
      expect(JSON.stringify(row)).not.toMatch(/batteries|Hardware/);
    }
    const listed = await listLocationFires(app, mailing.who);
    expect(listed[0]).toMatchObject({ aboutMe: true, place: 'Hardware store', outcome: 'delivered' });
    expect(listed[0].body).toContain('buy batteries');
  });
});

describe('the daily cap and the recovery sweep (D4 "Action routing", D3 "Crash recovery")', () => {
  it('holds deliveries past the daily cap, and the recovery sweep delivers a fire no dispatcher took', async () => {
    vi.stubEnv('OSHAL_LOCATION_REMINDER_DAILY_CAP', '1');
    try {
      const p = await person('loc-l5-cap', 'exact');
      await placeWithRule(p.who, 'Grocery', { repeat: 'every-visit', cooldownSec: 0 });
      await fixAt(p, offset(CENTER, 2000), 4000);
      await fixAt(p, CENTER, 4060);
      const first = await fixAt(p, CENTER, 4090);
      for (const [m, s] of [[400, 4100], [400, 4200], [400, 4300], [0, 4400]] as Array<[number, number]>) await fixAt(p, offset(CENTER, m), s);
      const second = await fixAt(p, CENTER, 4430);
      expect([first.length, second.length]).toEqual([1, 1]);
      const swept = await sweepPendingLocationFires(app, rails(), { olderThanMs: 0 });
      expect(swept.dispatchedCount + swept.skippedCount).toBeGreaterThanOrEqual(2);
      const outcomes = (await db.pool.query('SELECT fire_id, outcome FROM location_rule_fires WHERE fire_id = ANY($1::uuid[]) ORDER BY fired_at', [[...first, ...second]])).rows;
      expect(outcomes.map((r) => r.outcome)).toEqual(['delivered', 'capped']);
      expect(await count('location_rule_fires WHERE dispatched_at IS NULL')).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('an admin session reads no place, subject or reminder text (D4 "a fire leaves ids only", Q2)', () => {
  it('finds ids only in jarvis_tasks, no ticket at all, and no location rule row', async () => {
    expect(await count('location_rule_fires')).toBeGreaterThan(0);
    const seen = await asSession(ROOT, async () => ({
      tasks: (await app.query('SELECT id, session_id, title, result, error FROM jarvis_tasks')).rows,
      tickets: (await app.query('SELECT * FROM tickets')).rows,
      fires: (await app.query('SELECT count(*)::int AS n FROM location_rule_fires')).rows[0].n,
      rules: (await app.query('SELECT count(*)::int AS n FROM location_rules')).rows[0].n,
      state: (await app.query('SELECT count(*)::int AS n FROM location_rule_state')).rows[0].n,
    }));
    expect(seen.tasks.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen.tasks)).not.toMatch(/batteries|milk|Hardware|Grocery|arrived|loc-l5-(sms|mail|cap|visit|once|block)/);
    expect(seen.tickets).toEqual([]);
    expect(await count('tickets')).toBe(0);
    expect({ fires: seen.fires, rules: seen.rules, state: seen.state }).toEqual({ fires: 0, rules: 0, state: 0 });
  });
});

describe('Jarvis: "I\'m at the grocery store, remind me next time to buy milk" (L5)', () => {
  const turn = (who: LocationPrincipal, message: string): JarvisLocationTurn => ({ kind: 'reminder', principal: who, key: `k-${who.sub}`, ...parseLocationReminder(message)! });

  it('proposes a place at the current fix, saves it on "yes", and fires on the next visit, not now', async () => {
    clearLocationProposals();
    const store = offset(CENTER, 5000, 5000);
    const p = await person('loc-l5-jarvis', 'block');
    await fixAt(p, store, 6000);
    const proposal = await runJarvisLocationTurn(app, turn(p.who, 'I\'m at the grocery store, remind me next time to buy milk'), T0 + 6001_000);
    expect(proposal).toContain('"Grocery store" (grocery, 150 m)');
    const saved = await runJarvisLocationTurn(app, { kind: 'reply', principal: p.who, key: `k-${p.who.sub}`, reply: 'confirm' }, T0 + 6002_000);
    expect(saved).toBe('Saved "Grocery store". Next time you arrive at it, I\'ll remind you to buy milk.');
    const rules = await listLocationRules(app, p.who);
    expect(rules.mine.map((r) => [r.place.name, r.place.label, r.action.text, r.repeat])).toEqual([['Grocery store', 'grocery', 'buy milk', 'once']]);
    const fired: number[] = [];
    const script: Array<[GeoPoint, number]> = [[store, 6030], [store, 6070], [offset(store, 400), 6100], [offset(store, 400), 6200],
      [offset(store, 400), 6300], [store, 7000], [store, 7040]];
    for (const [point, s] of script) if ((await fixAt(p, point, s)).length) fired.push(s);
    expect(fired).toEqual([7040]);
    const fires = await listLocationFires(app, p.who);
    expect(fires[0]).toMatchObject({ place: 'Grocery store', transition: 'enter' });
    expect(fires[0].body).toContain('buy milk');
  });

  it('resolves "the grocery store" to that saved place later, and offers to save a place it has never seen', async () => {
    const who = principal('loc-l5-jarvis');
    const armed = await runJarvisLocationTurn(app, turn(who, 'remind me to buy eggs next time I\'m at the grocery store'));
    expect(armed).toBe('Done. Next time you arrive at Grocery store, I\'ll remind you to buy eggs.');
    expect((await listLocationRules(app, who)).mine.map((r) => r.action.text)).toContain('buy eggs');
    const offer = await runJarvisLocationTurn(app, turn(who, 'remind me to post a letter next time I\'m at the post office'));
    expect(offer).toContain('You don\'t have a saved place called "Post office" yet');
  });
});

describe('the owner\'s purge (Q4) removes the evaluation history', () => {
  it('deletes the person\'s rule state and fires, keeps their rules, and touches no one else\'s', async () => {
    const who = principal('loc-l5-visit');
    const others = await count('location_rule_fires WHERE owner_sub <> $1', [who.sub]);
    expect(await count('location_rule_state WHERE owner_sub = $1', [who.sub])).toBeGreaterThan(0);
    const purged = await purgeOwnLocationHistory(app, who);
    expect(purged.evaluationCount).toBeGreaterThan(0);
    expect(await count('location_rule_state WHERE owner_sub = $1', [who.sub])).toBe(0);
    expect(await count('location_rule_fires WHERE owner_sub = $1', [who.sub])).toBe(0);
    expect(await count('location_rules WHERE owner_sub = $1', [who.sub])).toBe(1);
    expect(await count('location_rule_fires WHERE owner_sub <> $1', [who.sub])).toBe(others);
  });
});
