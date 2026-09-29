/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 (D4 "Action routing", remind/notify): deliver claimed location fires after commit, each under the rule's actor with is_operator off (D3 "Dispatch identity"). Two rails, as the trading-event reminders use: a Jarvis shelf row carrying ids only (its text is resolved from the fire row on the Settings, Location page, under the person's own identity), and the per-user NotificationRouter under topic `location`. The router's senders are wrapped so the full text rides only an `own`-tier channel (the person's own Gmail, their own Twilio); a `deployment`-tier channel (SMS or voice on the deployment's Twilio, Telegram on the deployment's bot) carries only "You have a location reminder — open oshal". Before delivering, the fire is re-checked under the actor: the rule still exists and, for a group rule, the actor is still an admin; a per-person daily cap (OSHAL_LOCATION_REMINDER_DAILY_CAP, default 20, the Haven precedent) holds deliveries. Each fire is then marked with its outcome through migration 177's actor-only marker. A crash between claim and delivery is recovered by a sweep that reads only claimed, undispatched fires under its own broker GUC (never SYSTEM, never is_operator) and dispatches each under its actor. Delivery is bounded by the trading alerts' deadline so a wedged sender never holds the sweep. Log lines carry ids, counts and literal outcomes only.
 *
 * @module app/location-fire-dispatch
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger, locationSafeError } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { withLocationOwnerSession, type LocationDb, type LocationPrincipal } from '@/features/location';
import { NotificationRouter, type NotifyOutcome, type UserNotifyMessage } from '@/features/notifications';
import type { NotificationSenders, TieredChannelSender } from './routes/notify-routes';

const log = createChildLogger({ module: 'location-fire-dispatch' });

/** @description The NotificationRouter topic location fires ride; a person's saved preference for it is looked up under this key. */
export const LOCATION_NOTIFY_TOPIC = 'location';

/** @description The only text a deployment-tier channel carries for a location fire (ADR-169 D4). */
export const LOCATION_GENERIC_TEXT = 'You have a location reminder — open oshal';

/** @description The Jarvis shelf conversation location fires are filed under. */
export const LOCATION_SHELF_SESSION = 'location-reminders';

/** @description The daily delivery cap per person when OSHAL_LOCATION_REMINDER_DAILY_CAP is unset. */
export const LOCATION_DAILY_CAP_DEFAULT = 20;

/** @description The two delivery rails, injectable so a spec can observe them. */
export interface LocationDeliveryRails {
  /** Write the ids-only Jarvis shelf row for one fire, as the actor. */
  shelf(actor: LocationPrincipal, fireId: string): Promise<boolean>;
  /** Notify the actor; the router's senders decide full or generic text by tier. */
  notify(actor: LocationPrincipal, message: UserNotifyMessage): Promise<NotifyOutcome | null>;
}

/** @description What happened to one fire. */
export type LocationDispatchOutcome =
  | 'delivered' | 'shelved' | 'capped' | 'disarmed' | 'rule-gone' | 'already-dispatched' | 'not-found' | 'actor-erased';

/** A fire as the actor reads it. */
interface FireRow {
  fireId: string;
  ruleId: string;
  aboutSelf: boolean;
  transition: 'enter' | 'exit';
  actionKind: string;
  placeName: string;
  reminderText: string | null;
}

/**
 * @description The deployment's daily cap: OSHAL_LOCATION_REMINDER_DAILY_CAP (1-1000), default 20.
 * @returns Deliveries per person per 24 hours.
 */
export function locationDailyCap(): number {
  const n = Number(process.env.OSHAL_LOCATION_REMINDER_DAILY_CAP);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : LOCATION_DAILY_CAP_DEFAULT;
}

/**
 * @description The generic message a deployment-tier channel carries.
 * @returns The message: no place, no subject, no reminder text.
 */
export function genericLocationMessage(): UserNotifyMessage {
  return { subject: 'You have a location reminder', body: LOCATION_GENERIC_TEXT, shortText: LOCATION_GENERIC_TEXT };
}

/**
 * @description The full message for one fire, for the actor's own channels and the Settings page.
 * @param fire - The fire.
 * @returns Subject, body and SMS-sized line.
 */
export function locationFireMessage(fire: Pick<FireRow, 'aboutSelf' | 'transition' | 'actionKind' | 'placeName' | 'reminderText'>): UserNotifyMessage {
  const verb = fire.transition === 'enter' ? 'arrived at' : 'left';
  const who = fire.aboutSelf ? 'You' : 'A member of your group';
  const event = `${who} ${verb} ${fire.placeName}.`;
  if (fire.actionKind === 'remind' && fire.reminderText) {
    return { subject: `Reminder: ${fire.placeName}`, body: `${fire.reminderText}\n\n${event}`, shortText: `${fire.reminderText} (${fire.placeName})`.slice(0, 160) };
  }
  const note = fire.reminderText ? ` ${fire.reminderText}` : '';
  return { subject: `${who} ${verb} ${fire.placeName}`, body: `${event}${note}`, shortText: `${event}${note}`.slice(0, 160) };
}

/**
 * @description Wrap each per-user sender so the full text is sent only when that channel's tier for
 * the person is `own`; any other tier sends the generic message instead (ADR-169 D4).
 * @param senders - The production sender set (each answers tier()).
 * @param generic - The generic message.
 * @returns Senders for the NotificationRouter.
 */
export function tierAwareSenders(senders: NotificationSenders, generic: UserNotifyMessage = genericLocationMessage()): NotificationSenders {
  const wrap = (sender: TieredChannelSender): TieredChannelSender => ({
    channel: sender.channel,
    tier: (sub) => sender.tier(sub),
    available: (sub, pref) => sender.available(sub, pref),
    async send(sub, pref, message) {
      const tier = await sender.tier(sub);
      return sender.send(sub, pref, tier === 'own' ? message : generic);
    },
  });
  return { email: wrap(senders.email), sms: wrap(senders.sms), voice: wrap(senders.voice), telegram: wrap(senders.telegram) };
}

/**
 * @description Read one undispatched fire the actor may deliver, and decide whether to deliver it.
 * @param client - A client stamped as the actor.
 * @param actor - The actor.
 * @param fireId - The fire.
 * @param cap - The daily cap.
 * @returns The fire to deliver, or the outcome that stops it.
 */
async function prepareFire(client: PoolClient, actor: LocationPrincipal, fireId: string, cap: number): Promise<FireRow | LocationDispatchOutcome> {
  const row = (await client.query(`SELECT fire_id, rule_id, subject_ref, transition, action_kind, place_name, reminder_text, dispatched_at
    FROM location_rule_fires WHERE fire_id = $1 AND actor_sub = $2 AND actor_issuer = $3`, [fireId, actor.sub, actor.principalIssuer])).rows[0];
  if (!row) return 'not-found';
  if (row.dispatched_at) return 'already-dispatched';
  const rule = (await client.query(`SELECT (tenant_id IS NULL OR oshal_is_tenant_admin(tenant_id::text)) AS armed
    FROM location_rules WHERE rule_id = $1`, [row.rule_id])).rows[0];
  if (!rule) return 'rule-gone';
  if (rule.armed !== true) return 'disarmed';
  const today = (await client.query(`SELECT count(*)::int AS n FROM location_rule_fires
    WHERE actor_sub = $1 AND actor_issuer = $2 AND outcome IN ('delivered', 'shelved') AND dispatched_at > NOW() - interval '24 hours'`,
  [actor.sub, actor.principalIssuer])).rows[0];
  if (Number(today?.n ?? 0) >= cap) return 'capped';
  return {
    fireId, ruleId: String(row.rule_id), aboutSelf: String(row.subject_ref) === actor.sub,
    transition: row.transition === 'exit' ? 'exit' : 'enter', actionKind: String(row.action_kind),
    placeName: String(row.place_name ?? 'a saved place'), reminderText: row.reminder_text === null ? null : String(row.reminder_text),
  };
}

/**
 * @description Mark a fire dispatched with its outcome, as the actor.
 * @param db - The pool.
 * @param actor - The actor.
 * @param fireId - The fire.
 * @param outcome - The outcome word.
 * @returns Whether the mark took.
 */
async function markFire(db: LocationDb, actor: LocationPrincipal, fireId: string, outcome: LocationDispatchOutcome): Promise<boolean> {
  return withLocationOwnerSession(db, actor, async (client) =>
    (await client.query('SELECT location_mark_fire_dispatched($1, $2) AS ok', [fireId, outcome])).rows[0]?.ok === true);
}

/**
 * @description Run both rails for one fire. Each rail is its own try/catch: a failed shelf write
 * never stops the notification, and neither throws to the caller.
 * @param rails - The rails.
 * @param actor - The actor.
 * @param fire - The fire.
 * @returns 'delivered' when the notification went out, else 'shelved'.
 */
async function deliver(rails: LocationDeliveryRails, actor: LocationPrincipal, fire: FireRow): Promise<LocationDispatchOutcome> {
  try {
    await rails.shelf(actor, fire.fireId);
  } catch (error) {
    log.error({ op: 'shelf', outcome: 'failed', fireId: fire.fireId, err: locationSafeError(error) }, 'location fire shelf row failed');
  }
  try {
    const outcome = await rails.notify(actor, locationFireMessage(fire));
    return outcome?.delivered === true ? 'delivered' : 'shelved';
  } catch (error) {
    log.error({ op: 'notify', outcome: 'failed', fireId: fire.fireId, err: locationSafeError(error) }, 'location fire notification failed');
    return 'shelved';
  }
}

/**
 * @description Dispatch one claimed fire under its actor (ADR-169 D3 "Dispatch identity"): re-check,
 * cap, deliver over both rails, mark. Never throws for a delivery failure.
 * @param db - The pool.
 * @param rails - The delivery rails.
 * @param fireId - The fire.
 * @param actor - The rule's actor (subject and issuer).
 * @returns What happened.
 */
export async function dispatchLocationFire(db: LocationDb, rails: LocationDeliveryRails, fireId: string, actor: LocationPrincipal): Promise<LocationDispatchOutcome> {
  const started = Date.now();
  return runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.principalIssuer, isOperator: false }, async () => {
    const prepared = await withLocationOwnerSession(db, actor, (client) => prepareFire(client, actor, fireId, locationDailyCap()));
    if (prepared === 'not-found' || prepared === 'already-dispatched') return prepared;
    const outcome = typeof prepared === 'string' ? prepared : await deliver(rails, actor, prepared);
    await markFire(db, actor, fireId, outcome);
    log.info({ op: 'dispatch', outcome: outcome === 'delivered' ? 'delivered' : outcome === 'shelved' ? 'shelved' : outcome === 'capped' ? 'capped' : 'held',
      fireId, durationMs: Date.now() - started }, 'location fire dispatched');
    return outcome;
  });
}

/**
 * @description The actors of fires the subject just claimed, read as the subject (who owns them).
 * @param db - The pool.
 * @param subject - The subject whose ingest claimed them.
 * @param fireIds - The fire ids.
 * @returns fire id to actor, for fires that still name one.
 */
async function actorsOf(db: LocationDb, subject: LocationPrincipal, fireIds: string[]): Promise<Array<[string, LocationPrincipal]>> {
  return withLocationOwnerSession(db, subject, async (client) => (await client.query(
    'SELECT fire_id, actor_sub, actor_issuer FROM location_rule_fires WHERE fire_id = ANY($1::uuid[]) AND actor_sub IS NOT NULL', [fireIds])).rows
    .map((r) => [String(r.fire_id), { sub: String(r.actor_sub), principalIssuer: String(r.actor_issuer) }] as [string, LocationPrincipal]));
}

/**
 * @description Dispatch the fires one ingest claimed, each under its actor.
 * @param db - The pool.
 * @param rails - The delivery rails.
 * @param fireIds - Fires claimed by the subject's ingest.
 * @param subject - The subject.
 * @returns Outcomes by fire id.
 */
export async function dispatchClaimedFires(db: LocationDb, rails: LocationDeliveryRails, fireIds: string[], subject: LocationPrincipal): Promise<Record<string, LocationDispatchOutcome>> {
  const out: Record<string, LocationDispatchOutcome> = {};
  for (const [fireId, actor] of await actorsOf(db, subject, fireIds)) {
    out[fireId] = await dispatchLocationFire(db, rails, fireId, actor);
  }
  return out;
}

/**
 * @description An after-commit dispatcher for the ingest path: it starts the dispatch and returns at
 * once, so a slow connector never holds the ingest response; failures are logged.
 * @param db - The pool.
 * @param rails - The delivery rails.
 * @returns A callback for ingest's `onFired`.
 */
export function createLocationDispatcher(db: LocationDb, rails: LocationDeliveryRails): (fireIds: string[], subject: LocationPrincipal) => void {
  return (fireIds, subject) => {
    dispatchClaimedFires(db, rails, fireIds, subject).catch((error: unknown) => {
      log.error({ op: 'dispatch', outcome: 'failed', fireCount: fireIds.length, err: locationSafeError(error) }, 'location fire dispatch failed; the sweep will retry');
    });
  };
}

/**
 * @description Run `work` in one transaction as the dispatch-recovery broker: no subject, no issuer,
 * is_operator off, oshal.location_dispatch_broker on (transaction-local).
 * @param db - The pool.
 * @param work - The statements.
 * @returns What `work` returns.
 */
async function withDispatchBroker<T>(db: LocationDb, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.current_sub', '', true), set_config('oshal.current_issuer', '', true), "
      + "set_config('oshal.is_operator', 'off', true), set_config('oshal.location_dispatch_broker', 'on', true)");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      log.error({ op: 'broker-rollback', outcome: 'failed', err: locationSafeError(rollbackError) }, 'location dispatch broker rollback failed');
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @description The crash-recovery sweep (ADR-169 D3): find fires claimed before `olderThan` and never
 * dispatched, and dispatch each under its actor; a fire whose actor was erased is closed as such.
 * @param db - The pool.
 * @param rails - The delivery rails.
 * @param options - How old a pending fire must be (so the immediate dispatcher is not raced) and how many to take.
 * @returns How many were dispatched and how many were closed without delivery.
 */
export async function sweepPendingLocationFires(
  db: LocationDb, rails: LocationDeliveryRails, options: { olderThanMs?: number; limit?: number } = {},
): Promise<{ dispatchedCount: number; skippedCount: number }> {
  const cutoff = new Date(Date.now() - (options.olderThanMs ?? 60_000));
  const pending = await withDispatchBroker(db, async (client) => (await client.query(`SELECT fire_id, actor_sub, actor_issuer
    FROM location_rule_fires WHERE dispatched_at IS NULL AND claimed_at < $1 ORDER BY claimed_at LIMIT $2`,
  [cutoff, options.limit ?? 100])).rows);
  let dispatchedCount = 0;
  let skippedCount = 0;
  for (const row of pending) {
    if (!row.actor_sub) {
      await withDispatchBroker(db, (client) => client.query("SELECT location_mark_fire_dispatched($1, 'actor-erased')", [row.fire_id]));
      skippedCount += 1;
      continue;
    }
    const outcome = await dispatchLocationFire(db, rails, String(row.fire_id), { sub: String(row.actor_sub), principalIssuer: String(row.actor_issuer) });
    if (outcome === 'delivered' || outcome === 'shelved') dispatchedCount += 1; else skippedCount += 1;
  }
  if (pending.length) log.info({ op: 'sweep', outcome: 'ok', dispatchedCount, skippedCount }, 'location dispatch sweep ran');
  return { dispatchedCount, skippedCount };
}

/**
 * @description Start the recovery sweep on an unref'd timer.
 * @param db - The pool.
 * @param rails - The delivery rails.
 * @param every - Interval, ms; 0 starts nothing.
 * @returns A function that stops the sweep.
 */
export function startLocationDispatchSweep(db: LocationDb, rails: LocationDeliveryRails, every: number): () => void {
  if (!every) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepPendingLocationFires(db, rails).catch((error: unknown) => {
      log.error({ op: 'sweep', outcome: 'failed', err: locationSafeError(error) }, 'location dispatch sweep failed');
    }).finally(() => { running = false; });
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * @description The shelf row id for a fire: unique per fire (fire ids are UUIDs), so a retry is idempotent.
 * @param fireId - The fire.
 * @returns The jarvis_tasks id.
 */
export function locationShelfTaskId(fireId: string): string {
  return `loc-${fireId}`;
}

/**
 * @description The production rails: the Jarvis shelf (ids only) and the NotificationRouter over the
 * tier-aware wrap of the production senders. Both modules are loaded on first use, so an ingest that
 * fires nothing pays nothing.
 * @param pool - The app's GUC-wrapped pool.
 * @returns The rails.
 */
export function defaultLocationDeliveryRails(pool: Pool): LocationDeliveryRails {
  let router: Promise<{ notify: (sub: string, topic: string, m: UserNotifyMessage) => Promise<NotifyOutcome> }> | null = null;
  const loadRouter = () => {
    router ??= (async () => {
      const { buildNotificationSenders } = await import('./routes/notify-routes.js');
      const senders = buildNotificationSenders(pool);
      return new NotificationRouter({ pool, senders: tierAwareSenders(senders),
        defaultChannel: async (sub: string) => ((await senders.email.tier(sub)) === 'own' ? 'email' : 'none') });
    })();
    return router;
  };
  return {
    async shelf(actor, fireId) {
      const store = await import('./routes/jarvis-task-store.js');
      await store.ensureJarvisSchema(pool);
      const id = locationShelfTaskId(fireId);
      const saved = await store.saveTaskPending(pool, id, actor.sub, LOCATION_SHELF_SESSION, 'Location reminder');
      if (saved) await store.finishTask(pool, id, true, `You have a location reminder. Open Settings, Location to read it: /cockpit/tools/location.html#fire=${fireId}`);
      return saved;
    },
    async notify(actor, message) {
      const { withDeliveryDeadline } = await import('./trading-event-alerts.js');
      return withDeliveryDeadline((async () => (await loadRouter()).notify(actor.sub, LOCATION_NOTIFY_TOPIC, message))());
    },
  };
}
