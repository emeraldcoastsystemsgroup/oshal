/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for ADR-169 slice L5 (reminders and group sharing). Two steps on the running build. The route step, as the Lab's signed-in person over the loopback: the rules, fires, shared-presence and group-sharing reads answer without a coordinate, accepting a restricted invitation and creating a guardian share are each refused without a fresh sign-in, a rule at a place that is not theirs is refused, and the person's rule count does not move. The lifecycle step runs the same services the routes and Jarvis call, for three uniquely tagged synthetic people on the real database with a scripted server clock: the Jarvis "I'm at the grocery store, remind me next time to buy milk" turn proposes a place at the person's fix and saves it on "yes"; the reminder does not fire while they stay, and fires exactly once when they come back; the fire is delivered under the actor over the production Jarvis shelf rail (ids only) and the tier-aware senders (a deployment-tier channel gets only the generic text, an own-tier channel the reminder); an operator-stamped session then finds no place, subject or reminder text in the shelf row and no location rule or fire row at all. Then an admin's group notice fires for the member who shared the group place and never evaluates the member who did not, and the projection shows the sharer's arrival by reference. Everything the step created is deleted (the shelf rows, the group with its memberships, then each person's location rows through the erase) and a zero-row check runs; incomplete cleanup is a failure. No real person's location is read or written.
 */

import { randomUUID } from 'node:crypto';
import { eraseLocationData, withLocationOwnerSession, type LocationPrincipal } from '@/features/location';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { GeoPoint } from '@/shared/utils/geo';
import { optInBrowserDevice } from '../location-consent';
import {
  LOCATION_GENERIC_TEXT, defaultLocationDeliveryRails, dispatchClaimedFires, locationFireMessage, locationShelfTaskId, tierAwareSenders,
  type LocationDeliveryRails,
} from '../location-fire-dispatch';
import { readSharedPresence } from '../location-group-shares';
import { parseLocationReminder, runJarvisLocationTurn, type JarvisLocationTurn } from '../location-jarvis-intent';
import { acceptMemberShare, parseShareRequest } from '../location-member-shares';
import { createLocationPlace, parsePlaceInput } from '../location-places';
import { ingestBrowserFix, parseBrowserFix } from '../location-presence';
import { createLocationRule, listLocationFires, listLocationRules, parseRuleInput } from '../location-rules';
import { addMember, createTenant } from './connector-tenancy';
import type { NotificationSenders, NotifyChannelTier, TieredChannelSender } from './notify-routes';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-location-reminders' });
const APP = 'location';
const ROUTES_LABEL = 'Reminders and sharing refuse what needs a proof or is not yours (ADR-169 L5)';
const LIFECYCLE_LABEL = 'A grocery-store reminder and a group notice for synthetic people (ADR-169 L5)';
const PROBE_ISSUER = 'urn:oshal:test-lab';
const STORE: GeoPoint = { lat: -12.3464, lon: -31.9884 };
const SCHOOL: GeoPoint = { lat: -12.4, lon: -31.9 };
const FAR: GeoPoint = { lat: -12.6, lon: -31.7 };
const COORDINATE_KEYS = /"(lat|lon|latitude|longitude|center|center_lat|center_lon|address|radius|radiusM)"/;
const DEG_PER_M = 180 / (Math.PI * 6_371_000);

type Check = [string, boolean];
type Pool = ScenarioRunContext['ctx']['pool'];
type Result = (state: StepResult['state'], detail: string, output?: unknown) => StepResult;
const resultFor = (label: string): Result => (state, detail, output) =>
  ({ app: APP, label, state, detail, ...(output === undefined ? {} : { output }) });

/** A loopback call to the location routes as the Lab's signed-in person. */
async function call(base: string, cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${base}/api/location${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> };
}

/** The refusals the route step makes; none of them may write. */
async function routeChecks(base: string, cookie: string): Promise<Check[]> {
  const group = randomUUID();
  const place = randomUUID();
  const accept = await call(base, cookie, 'POST', `/invites/${randomUUID()}/accept`, {});
  const guardian = await call(base, cookie, 'POST', '/guardian-shares', { tenantId: group, minorSub: 'test-lab-nobody', grantees: [{ sub: 'test-lab-nobody-else' }], placeIds: [place] });
  const rule = await call(base, cookie, 'POST', '/rules', { placeId: place, action: { kind: 'remind', text: 'Test Lab' } });
  return [
    ['accepting a restricted invitation is refused without a fresh sign-in', accept.status === 403 && accept.json.error === 'step_up_required'],
    ['creating a guardian share is refused without a fresh sign-in', guardian.status === 403 && guardian.json.error === 'step_up_required'],
    ['a reminder at a place that is not theirs is refused', rule.status === 404 && rule.json.error === 'place_not_found'],
  ];
}

/**
 * @description As the signed-in person: the reads carry no coordinate, the two gated writes and a foreign place are refused, and the rule count does not move.
 * @param cookie - The Lab's session cookie.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function reminderRoutesStep(cookie: string, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(ROUTES_LABEL);
  if (!cookie || !runtime?.apiBaseUrl) return result('gap', 'Needs a signed-in Test Lab session on the running server.');
  const base = runtime.apiBaseUrl;
  const reads = await Promise.all(['/rules', '/fires', '/shared', '/group-sharing'].map((p) => call(base, cookie, 'GET', p)));
  if (reads.some((r) => r.status !== 200)) {
    return result('gap', `This session cannot read the reminder routes (HTTP ${reads.map((r) => r.status).join('/')}); it must be a browser sign-in with a verified issuer.`);
  }
  const checks: Check[] = [['the reads carry no coordinate', !COORDINATE_KEYS.test(reads.map((r) => JSON.stringify(r.json)).join(''))]];
  checks.push(...await routeChecks(base, cookie));
  const after = await call(base, cookie, 'GET', '/rules');
  const ruleCount = (r: Record<string, any>) => `${r.mine?.length}/${r.group?.length}`;
  checks.push(['the person\'s rules did not change', after.status === 200 && ruleCount(after.json) === ruleCount(reads[0].json)]);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Route checks failed: ${failed.join('; ')}.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}.`);
}

/** The synthetic people, their devices, the scripted clock and what the lifecycle created. */
interface LabWorld {
  admin: LocationPrincipal;
  sharer: LocationPrincipal;
  other: LocationPrincipal;
  devices: Record<string, string>;
  clock: Record<string, number>;
  groupId: string;
  fireIds: string[];
  sent: Array<{ channel: string; tier: NotifyChannelTier; body: string }>;
}

/** Run `fn` with the ambient identity of one person; the auditor is the only operator-stamped one. */
const as = <T>(who: LocationPrincipal, fn: () => Promise<T>, isOperator = false): Promise<T> =>
  runWithRequestIdentity({ sub: who.sub, principalIssuer: who.principalIssuer, isOperator }, fn);

/** A point `northM` metres north of `p`. */
const north = (p: GeoPoint, northM: number): GeoPoint => ({ lat: p.lat + northM * DEG_PER_M, lon: p.lon });

/** One fix through the real ingest on the person's scripted clock; returns the fire ids it claimed. */
async function fixAt(pool: Pool, w: LabWorld, who: LocationPrincipal, point: GeoPoint, afterSec: number): Promise<string[]> {
  w.clock[who.sub] = (w.clock[who.sub] ?? w.clock.start) + afterSec;
  const t = w.clock[who.sub] * 1000;
  const fired: string[] = [];
  await ingestBrowserFix(pool, who, parseBrowserFix({ deviceId: w.devices[who.sub], lat: point.lat, lon: point.lon, accuracyM: 10,
    observedAt: new Date(t).toISOString() }, t), { minIntervalMs: 0, nowMs: t, onFired: (ids) => fired.push(...ids) });
  return fired;
}

/** Arrive at a point from far away: a far baseline, then two inside fixes 35 s apart. */
async function arrive(pool: Pool, w: LabWorld, who: LocationPrincipal, point: GeoPoint): Promise<string[]> {
  await fixAt(pool, w, who, FAR, 35);
  await fixAt(pool, w, who, point, 35);
  return fixAt(pool, w, who, point, 35);
}

/** A sender of a fixed tier that records what it is handed and sends nothing. */
function recordingSender(w: LabWorld, channel: 'email' | 'sms' | 'voice' | 'telegram', tier: NotifyChannelTier): TieredChannelSender {
  return {
    channel, tier: async () => tier, available: async () => true,
    async send(_sub, _pref, message) { w.sent.push({ channel, tier, body: message.body }); return { delivered: true, id: `lab-${w.sent.length}` }; },
  };
}

/** The production shelf rail, and a notify rail over the tier-aware wrap of recording senders (one own, one deployment). */
function labRails(pool: Pool, w: LabWorld): LocationDeliveryRails {
  const senders: NotificationSenders = {
    email: recordingSender(w, 'email', 'own'), sms: recordingSender(w, 'sms', 'deployment'),
    voice: recordingSender(w, 'voice', 'deployment'), telegram: recordingSender(w, 'telegram', 'deployment'),
  };
  const wrapped = tierAwareSenders(senders);
  return {
    shelf: defaultLocationDeliveryRails(pool).shelf,
    async notify(actor, message) {
      await wrapped.sms.send(actor.sub, null, message);
      const mail = await wrapped.email.send(actor.sub, null, message);
      return { channel: 'email', delivered: mail.delivered, ...(mail.error ? { error: mail.error } : {}) };
    },
  };
}

/** The Jarvis turn for a sentence, as the /ask path would build it for the person. */
const turn = (who: LocationPrincipal, message: string): JarvisLocationTurn =>
  ({ kind: 'reminder', principal: who, key: `test-lab-${who.sub}`, ...parseLocationReminder(message)! });

/** "I'm at the grocery store, remind me next time to buy milk": proposal, save, no fire while staying, one fire on return. */
async function groceryChecks(pool: Pool, w: LabWorld): Promise<Check[]> {
  const who = w.admin;
  await fixAt(pool, w, who, STORE, 0);
  const proposal = await runJarvisLocationTurn(pool, turn(who, 'I\'m at the grocery store, remind me next time to buy milk'), w.clock[who.sub] * 1000 + 1000);
  const saved = await runJarvisLocationTurn(pool, { kind: 'reply', principal: who, key: `test-lab-${who.sub}`, reply: 'confirm' }, w.clock[who.sub] * 1000 + 2000);
  const rules = await listLocationRules(pool, who);
  const staying = [await fixAt(pool, w, who, STORE, 35), await fixAt(pool, w, who, north(STORE, 40), 35)].flat();
  for (const s of [60, 100, 100]) await fixAt(pool, w, who, north(STORE, 500), s);
  const back = await arrive(pool, w, who, STORE);
  w.fireIds.push(...back);
  const again = await fixAt(pool, w, who, STORE, 35);
  return [
    ['Jarvis proposes saving the place at the current fix', proposal.includes('"Grocery store" (grocery,')],
    ['"yes" saves the place and arms a once-only reminder', saved.startsWith('Saved "Grocery store".')
      && rules.mine.some((r) => r.place.name === 'Grocery store' && r.action.text === 'buy milk' && r.repeat === 'once')],
    ['it does not fire while the person stays where they said it', staying.length === 0],
    ['it fires exactly once on the next visit', back.length === 1 && again.length === 0],
  ];
}

/** Delivery over both rails, and what an operator-stamped auditor can and cannot read afterwards. */
async function deliveryChecks(pool: Pool, w: LabWorld): Promise<Check[]> {
  const outcomes = await dispatchClaimedFires(pool, labRails(pool, w), w.fireIds, w.admin);
  const fires = await listLocationFires(pool, w.admin);
  const full = fires[0] ? locationFireMessage({ aboutSelf: true, transition: 'enter', actionKind: 'remind', placeName: 'Grocery store', reminderText: 'buy milk' }).body : '';
  const auditor: LocationPrincipal = { sub: `test-lab-location-l5-auditor-${randomUUID()}`, principalIssuer: PROBE_ISSUER };
  const seen = await as(auditor, async () => ({
    shelf: (await pool.query('SELECT id, title, result, error FROM jarvis_tasks WHERE id = ANY($1::text[])', [w.fireIds.map(locationShelfTaskId)])).rows,
    rules: Number((await pool.query('SELECT count(*)::int AS n FROM location_rules')).rows[0].n),
    fires: Number((await pool.query('SELECT count(*)::int AS n FROM location_rule_fires WHERE fire_id = ANY($1::uuid[])', [w.fireIds])).rows[0].n),
  }), true);
  const sms = w.sent.filter((m) => m.channel === 'sms');
  const mail = w.sent.filter((m) => m.channel === 'email');
  return [
    ['the fire is delivered under the actor', w.fireIds.every((id) => outcomes[id] === 'delivered')],
    ['the person reads the full reminder text under their own identity', fires[0]?.body === full && full.includes('buy milk')],
    ['a deployment-tier channel carries only the generic text', sms.length === 1 && sms[0].body === LOCATION_GENERIC_TEXT],
    ['an own-tier channel carries the reminder', mail.length === 1 && mail[0].body.includes('buy milk')],
    ['the shelf row exists and an operator-stamped session finds no place, subject or reminder text in it',
      seen.shelf.length === w.fireIds.length && !/milk|Grocery|arrived|test-lab-location-l5-(admin|sharer|other)/.test(JSON.stringify(seen.shelf))],
    ['an operator-stamped session reads no location rule or fire row', seen.rules === 0 && seen.fires === 0],
  ];
}

/** The group: a notice at the school fires for the member who shared and never evaluates the one who did not. */
async function groupChecks(pool: Pool, w: LabWorld): Promise<Check[]> {
  w.groupId = (await as(w.admin, () => createTenant(pool, { name: `Test Lab L5 ${w.admin.sub.slice(-12)}`, createdBySub: w.admin.sub }))).tenant_id;
  for (const who of [w.sharer, w.other]) await as(w.admin, () => addMember(pool, w.groupId, who.sub, w.admin.sub));
  const school = await createLocationPlace(pool, w.admin, parsePlaceInput({ name: 'Test Lab school', center: SCHOOL, radiusM: 150, groupId: w.groupId }, 'create'));
  await createLocationRule(pool, w.admin, parseRuleInput({ placeId: school.placeId, groupId: w.groupId, subject: 'any-member', repeat: 'every-visit', action: { kind: 'notify' } }));
  await acceptMemberShare(pool, w.sharer, parseShareRequest({ tenantId: w.groupId, placeIds: [school.placeId] }));
  const sharerFired = await arrive(pool, w, w.sharer, SCHOOL);
  const otherFired = await arrive(pool, w, w.other, SCHOOL);
  w.fireIds.push(...sharerFired);
  const notified = await dispatchClaimedFires(pool, labRails(pool, w), sharerFired, w.sharer);
  const otherState = await withLocationOwnerSession(pool, w.other, async (client) =>
    Number((await client.query('SELECT count(*)::int AS n FROM location_rule_state')).rows[0].n));
  const projection = await readSharedPresence(pool, w.other);
  return [
    ['the group notice fires once for the member who shared the place', sharerFired.length === 1],
    ['it is delivered to the admin who armed it', sharerFired.every((id) => notified[id] === 'delivered')],
    ['the member who did not share is never evaluated', otherFired.length === 0 && otherState === 0],
    ['a member sees the sharer\'s arrival by reference, with no coordinate',
      projection.some((r) => r.subjectSub === w.sharer.sub && r.place.placeId === school.placeId && r.transition === 'enter') && !COORDINATE_KEYS.test(JSON.stringify(projection))],
  ];
}

/** Rows the lifecycle could leave, counted per person under their own identity. */
async function remainingRows(pool: Pool, w: LabWorld): Promise<number> {
  let n = 0;
  for (const who of [w.admin, w.sharer, w.other]) {
    n += await withLocationOwnerSession(pool, who, async (client) => Number((await client.query(`SELECT
        (SELECT count(*) FROM location_rules WHERE owner_sub = $1 OR armed_by_sub = $1)
      + (SELECT count(*) FROM location_rule_state WHERE owner_sub = $1) + (SELECT count(*) FROM location_rule_fires WHERE owner_sub = $1 OR actor_sub = $1)
      + (SELECT count(*) FROM location_share_presence WHERE owner_sub = $1) + (SELECT count(*) FROM location_shares WHERE owner_sub = $1)
      + (SELECT count(*) FROM location_observations WHERE owner_sub = $1) + (SELECT count(*) FROM location_current WHERE owner_sub = $1)
      + (SELECT count(*) FROM location_devices WHERE owner_sub = $1) + (SELECT count(*) FROM location_places WHERE owner_sub = $1)
      + (SELECT count(*) FROM oshal_tenant_memberships WHERE user_sub = $1) + (SELECT count(*) FROM jarvis_tasks WHERE user_sub = $1) AS n`,
    [who.sub])).rows[0].n));
  }
  return n + await withLocationOwnerSession(pool, w.admin, async (client) =>
    Number((await client.query('SELECT count(*)::int AS n FROM oshal_tenants WHERE tenant_id::text = $1', [w.groupId || ''])).rows[0].n));
}

/** Delete what the step created: shelf rows and the group as the admin, then every person's location rows. */
async function cleanup(pool: Pool, w: LabWorld): Promise<number> {
  await withLocationOwnerSession(pool, w.admin, async (client) => {
    await client.query('DELETE FROM jarvis_tasks WHERE id = ANY($1::text[]) AND user_sub = $2', [w.fireIds.map(locationShelfTaskId), w.admin.sub]);
    if (w.groupId) await client.query('DELETE FROM oshal_tenants WHERE tenant_id = $1', [w.groupId]);
  });
  for (const who of [w.admin, w.sharer, w.other]) await eraseLocationData(pool, who);
  return remainingRows(pool, w);
}

/**
 * @description The grocery-store reminder, two-rail delivery, the auditor's blind read and a group notice for three synthetic people on the real database, with a full cleanup and a zero-row check.
 * @param runtime - The Lab's server-derived context.
 * @returns The Lab step result.
 */
export async function remindersLifecycleStep(runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = resultFor(LIFECYCLE_LABEL);
  if (!runtime?.ctx?.pool) return result('gap', 'Needs the running server\'s database pool; run it from the Test Lab.');
  const pool = runtime.ctx.pool;
  const tag = randomUUID();
  const person = (role: string): LocationPrincipal => ({ sub: `test-lab-location-l5-${role}-${tag}`, principalIssuer: PROBE_ISSUER });
  const w: LabWorld = { admin: person('admin'), sharer: person('sharer'), other: person('other'), devices: {},
    clock: { start: Math.floor(Date.now() / 1000) - 6 * 3600 }, groupId: '', fireIds: [], sent: [] };
  let checks: Check[] = [];
  let failure = '';
  try {
    for (const who of [w.admin, w.sharer, w.other]) w.devices[who.sub] = (await optInBrowserDevice(pool, who, { deviceId: null, precisionClass: 'block' })).deviceId;
    checks = [...await groceryChecks(pool, w), ...await deliveryChecks(pool, w), ...await groupChecks(pool, w)];
  } catch (error) {
    logger.error({ op: 'lab-lifecycle', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location reminders lifecycle could not run');
    failure = `The lifecycle could not run: ${(error as { code?: string }).code ?? (error as Error).name}.`;
  }
  let left = -1;
  try {
    left = await cleanup(pool, w);
  } catch (error) {
    logger.error({ op: 'lab-cleanup', outcome: 'failed', err: locationSafeError(error) }, 'Test Lab location reminders cleanup failed');
  }
  if (left !== 0) return result('fail', `${failure} Cleanup incomplete: ${left < 0 ? 'the cleanup failed' : `${left} synthetic rows remain`}.`.trim());
  if (failure) return result('fail', `${failure} Synthetic rows were deleted.`);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) return result('fail', `Lifecycle failed: ${failed.join('; ')}. Synthetic rows were deleted.`, { failed });
  return result('pass', `${checks.length} checks hold: ${checks.map(([name]) => name).join('; ')}. Every synthetic shelf row, group, membership and location row was deleted and no row of theirs remains.`);
}

/** The ADR-169 L5 Test Lab card. */
export const LOCATION_REMINDERS_SCENARIOS: Scenario[] = [{
  id: 'location-reminders',
  title: 'Location — reminders and group sharing (ADR-169 L5)',
  group: 'tool',
  description: 'Checks ADR-169 slice L5 on the running build. As the signed-in person, the rules, fires, shared-presence and group-sharing reads carry no coordinate; accepting a restricted invitation and creating a guardian share are refused without a fresh sign-in; a reminder at a place that is not theirs is refused; and their rules do not change. Then three uniquely tagged synthetic people on the real database with a scripted clock: "I\'m at the grocery store, remind me next time to buy milk" proposes a place at the fix and saves it on "yes"; the reminder does not fire while the person stays and fires exactly once when they return; it is delivered under the actor over the production Jarvis shelf rail (ids only) and tier-aware senders (a deployment-tier channel gets only "You have a location reminder", an own-tier channel the reminder); an operator-stamped session finds no place, subject or reminder text in the shelf row and no location rule or fire row. An admin\'s group notice fires for the member who shared the place and never evaluates the member who did not, and a member sees the sharer\'s arrival by reference. Everything created is deleted and a zero-row check runs. No real person\'s location is read or written.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/location-evaluator.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-jarvis-intent.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-reminders-postgres.spec.ts' },
    { level: 'integration', path: 'tests/unit/location-group-shares-postgres.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-route-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-rls-no-operator-guard.spec.ts' },
    { level: 'unit', path: 'tests/unit/location-log-guard.spec.ts' },
    { level: 'integration', path: 'tests/unit/test-lab-location-reminders-registration.spec.ts' },
  ],
  steps: [
    { id: 'reminder-routes', app: APP, label: ROUTES_LABEL, run: async (cookie, _prior, runtime) => reminderRoutesStep(cookie, runtime) },
    { id: 'reminders-lifecycle', app: APP, label: LIFECYCLE_LABEL, run: async (_cookie, _prior, runtime) => remindersLifecycleStep(runtime) },
  ],
}];
