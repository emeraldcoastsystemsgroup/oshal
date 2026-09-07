/**
 * Event-playbook alerts (ADR-136 D6 remainder) — how a plan TELLS its owner something happened.
 *
 * Two rails, both already in the kernel, both per-user: (1) the Jarvis catch-up shelf — a `done`
 * jarvis_tasks row the shelf poll (`/api/jarvis/tasks`, newest 50) announces as "results waiting",
 * written through saveTaskPending/finishTask, which log-and-swallow a DB failure; (2) the per-user
 * NotificationRouter under the topic `trading-events` — the saved preference (email via the user's
 * Gmail, SMS/voice via their Twilio, Telegram) wins, quiet hours are honored, and with no preference
 * the default is email when a Gmail-send connection exists, else none. The router is built LAZILY per
 * fire (buildNotificationRouter wires four senders) so a 5-minute leg tick that fires nothing pays
 * nothing. Neither rail may fail the caller: every write is its own try/catch at error level, and the
 * outward hop is raced against a deadline (TRADING_EVENT_NOTIFY_TIMEOUT_MS) so a wedged sender cannot
 * stall the leg tick that raised the alert.
 *
 * The first-seen S-1 hook (`alertFirstS1`) is claim-first: the `s1_alerted` timeline event is appended
 * with a `NOT (timeline @> …)` guard and the notification goes out only when that claim wins, so the
 * alert fires at most once per plan wherever the state machine calls it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — EventAlert contract, announceEventAlert over the Jarvis shelf + per-user NotificationRouter (lazy, topic TRADING_EVENT_ALERT_TOPIC → 'trading-events'), a shelf task id unique per user+plan+key (full planId + a sub hash — the id is a GLOBAL primary key with ON CONFLICT DO UPDATE, so a prefix collision across two users' plans would overwrite the other user's row), the S-1 alert text ("is on EDGAR (filed <date>)", never "today") with the claim-first alertFirstS1 hook, and normalizePricingDate (YYYY-MM-DD, Date.UTC round-trip, no clock/tz import) for the plan's `params.pricingDate` knob.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review round 2: normalizePricingDate also refuses a weekend date — the reminder leg runs weekdays only, so a Saturday pricing date produced a T-0 whose due minute could never be reached and which was then recorded `expired`. Refusing at the input is the honest failure.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review round 3: outward delivery is now BOUNDED — withDeliveryDeadline (env TRADING_EVENT_NOTIFY_TIMEOUT_MS, default 20s) races every router build+notify, so a wedged Gmail/Twilio/Telegram sender can no longer stall the trading-events leg tick that raised the alert (notify() not throwing was asserted; not HANGING was not). And alertNotifierFrom(deps) resolves the delivery seam off a caller's own deps bag, so the state-machine hook keeps the design's injectable notify seam without the plan module's EventPlanDeps interface having to change first: a caller that carries `notify` gets it, everyone else gets announceEventAlert.
 *
 * @module trading-event-alerts
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { NotificationRouter, NotifyOutcome } from '@/features/notifications';
import { ensureJarvisSchema, saveTaskPending, finishTask } from './routes/jarvis-task-store';

const logger = createChildLogger({ module: 'trading-event-alerts' });

/** One owner-facing alert about a plan. `key` is stable per event kind ('s1', 't3', …) — it makes the shelf row idempotent. */
export interface EventAlert {
  key: string;
  subject: string;
  body: string;
  /** The link the alert is about (EDGAR filing, the broker's IPO center), or null. */
  url: string | null;
  /** The SMS-sized line (≤ 160 chars when possible); falls back to the subject on the router. */
  shortText: string;
}

/** What announceEventAlert needs beyond the pool — injectable so the real-DB spec can fake the outward channel. */
export interface EventAlertDeps {
  pool: AppContext['pool'];
  /** Built per fire, never eagerly — see the module doc. */
  router: () => Promise<Pick<NotificationRouter, 'notify'>>;
}

/** The delivery seam: what actually announces one alert. Production is {@link announceEventAlert}. */
export type EventAlertNotifier = (ctx: AppContext, sub: string, planId: string, alert: EventAlert) => Promise<unknown>;

/** Bounds on the outward hop (see {@link notifyTimeoutMs}). */
const NOTIFY_TIMEOUT_DEFAULT_MS = 20_000, NOTIFY_TIMEOUT_MIN_MS = 1_000, NOTIFY_TIMEOUT_MAX_MS = 120_000;

/** The subset of a plan row the alert text needs (structural, so the state machine can pass its own row). */
export interface AlertPlanRef { planId: string; name: string; bookRef: string; params: { issuer: string } }
/** The first public registration statement as the EDGAR watch recorded it. */
export interface S1Filing { form: string; date: string; url: string }

/**
 * @description The NotificationRouter topic the alerts ride. Config → env TRADING_EVENT_ALERT_TOPIC
 * (letters/digits/dashes) → 'trading-events'. It is the key a user's saved notification preference is
 * looked up under, so it must stay stable once operators have set preferences.
 * @returns The topic name.
 */
export function eventAlertTopic(): string {
  const t = String(process.env.TRADING_EVENT_ALERT_TOPIC ?? '').trim();
  return /^[a-z0-9][a-z0-9-]{0,60}$/i.test(t) ? t : 'trading-events';
}

/**
 * @description How long an outward delivery may take before the caller stops waiting for it. The alert
 * rails run INSIDE a leg tick (stepWatching, the reminders tick): the router really talks to Gmail,
 * Twilio and Telegram, and a wedged sender with no deadline stalls that user's whole tick. Config -> env
 * TRADING_EVENT_NOTIFY_TIMEOUT_MS (1000-120000) -> 20000.
 * @returns Milliseconds.
 */
export function notifyTimeoutMs(): number {
  const n = Number(String(process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n >= NOTIFY_TIMEOUT_MIN_MS && n <= NOTIFY_TIMEOUT_MAX_MS ? Math.round(n) : NOTIFY_TIMEOUT_DEFAULT_MS;
}

/**
 * @description Race one delivery against the deadline. The work is NOT cancelled (an HTTP send cannot
 * be), it is only stopped being waited on - Promise.race keeps a handler on it, so a late rejection is
 * still handled and never surfaces as an unhandled rejection. The timer is always cleared, so a fast
 * delivery leaves nothing keeping the process alive.
 * @param work - The delivery in flight.
 * @param ms - The deadline (default {@link notifyTimeoutMs}).
 * @returns The delivery result; rejects once the deadline passes.
 */
export async function withDeliveryDeadline<T>(work: Promise<T>, ms: number = notifyTimeoutMs()): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`event alert delivery exceeded ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @description Resolve the delivery seam from a caller's own deps bag. The state-machine hook is called
 * with the plan module's EventPlanDeps, whose `notify` is OPTIONAL: a caller (or a spec) that carries one
 * gets it, everyone else gets the real two-rail announce. Typed `unknown` on purpose - the hook line
 * compiles whether or not the plan module has declared the field yet, so the seam never blocks wiring.
 * @param deps - Whatever deps bag the caller has.
 * @returns The seam to deliver through.
 */
export function alertNotifierFrom(deps: unknown): EventAlertNotifier {
  const n = (deps as { notify?: unknown } | null | undefined)?.notify;
  return typeof n === 'function' ? (n as EventAlertNotifier) : announceEventAlert;
}

/**
 * @description The Jarvis shelf task id for one (owner, plan, alert key). jarvis_tasks.id is a GLOBAL
 * primary key upserted with ON CONFLICT DO UPDATE, so the id carries the FULL planId plus a hash of the
 * owner — two users can never share a row, and a retry of the same alert is idempotent.
 * @param sub - Owner.
 * @param planId - The plan (36-char uuid).
 * @param key - The alert key.
 * @returns The task id.
 */
export function eventAlertTaskId(sub: string, planId: string, key: string): string {
  const owner = crypto.createHash('sha256').update(String(sub)).digest('hex').slice(0, 12);
  return `evt-${planId}-${key}-${owner}`;
}

/**
 * @description The production deps: the context pool + a router built on first use of each fire.
 * @param ctx - App context (its pool is the shelf rail; the router is built from it lazily).
 * @returns The deps announceEventAlert uses when the caller injects none.
 */
export function defaultAlertDeps(ctx: AppContext): EventAlertDeps {
  return {
    pool: ctx.pool,
    // Dynamic import: notify-routes pulls the whole connector/email surface in; the alert module must
    // stay a leaf so the state machine can import it without a cycle, and the router is per fire anyway.
    router: async () => (await import('./routes/notify-routes.js')).buildNotificationRouter(ctx),
  };
}

/**
 * @description Deliver one alert to the plan's owner over both rails. Never throws: each rail is its
 * own try/catch logged at error, so an alert failure never fails the state-machine tick that raised it.
 * @param ctx - App context.
 * @param sub - Owner.
 * @param planId - The plan the alert is about.
 * @param alert - Subject/body/url/shortText.
 * @param deps - Pool + lazy router (production by default; the spec injects a fake router).
 * @returns The router outcome (null when the router rail itself failed) and the shelf task id written.
 */
export async function announceEventAlert(ctx: AppContext, sub: string, planId: string, alert: EventAlert, deps: EventAlertDeps = defaultAlertDeps(ctx)): Promise<{ notified: NotifyOutcome | null; jarvisTaskId: string }> {
  const t0 = Date.now();
  const jarvisTaskId = eventAlertTaskId(sub, planId, alert.key);
  await writeShelfRow(deps.pool, sub, planId, jarvisTaskId, alert);
  let notified: NotifyOutcome | null = null;
  try {
    // Build + send inside ONE deadline: buildNotificationRouter reads connections and the senders talk to
    // Gmail/Twilio/Telegram, so either half can wedge the leg tick that raised this alert.
    notified = await withDeliveryDeadline((async () => {
      const router = await deps.router();
      return router.notify(sub, eventAlertTopic(), { subject: alert.subject, body: bodyWithLink(alert), shortText: alert.shortText });
    })());
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, sub, planId, key: alert.key }, 'event alert: notification router failed or exceeded its deadline');
  }
  logger.info({ sub, planId, key: alert.key, jarvisTaskId, notified, ms: Date.now() - t0 }, 'event alert announced');
  return { notified, jarvisTaskId };
}

/** The body with its link on the last line — unless the text already carries it (the COTP reminders do). */
const bodyWithLink = (a: EventAlert): string => a.url && !a.body.includes(a.url) ? `${a.body}\n\n${a.url}` : a.body;

/** The Jarvis catch-up shelf rail: a done row under the owner (the store helpers themselves log-and-swallow). */
async function writeShelfRow(pool: AppContext['pool'], sub: string, planId: string, id: string, alert: EventAlert): Promise<void> {
  try {
    await ensureJarvisSchema(pool);
    await saveTaskPending(pool, id, sub, `trading-events-${planId}`, alert.subject, 'simple');
    await finishTask(pool, id, true, bodyWithLink(alert));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, sub, planId, id }, 'event alert: jarvis shelf write failed');
  }
}

/**
 * @description The alert for the first public S-1/F-1 the watch saw. The body names the FILING date —
 * a plan armed after the registration statement is already public sees it on its first tick, so
 * "filed today" would be false; "is on EDGAR (filed <date>)" is true either way.
 * @param plan - The plan (issuer, name, book).
 * @param s1 - The filing as recorded.
 * @returns The alert.
 */
export function s1FiledAlert(plan: AlertPlanRef, s1: S1Filing): EventAlert {
  const issuer = plan.params.issuer;
  return {
    key: 's1',
    subject: `${issuer}: public ${s1.form} is on EDGAR (filed ${s1.date})`,
    body: `The public registration statement for ${issuer} is on EDGAR (${s1.form}, filed ${s1.date}). Your event playbook "${plan.name}" on ${plan.bookRef} is watching for the pricing prospectus (424B4) next. If you want IPO shares at the offer price, the Conditional Offer to Purchase is yours to submit on schwab.com — set the expected pricing date on the plan to get the reminders.`,
    url: s1.url || null,
    shortText: `${issuer} ${s1.form} filed ${s1.date} — ${s1.url}`.slice(0, 160),
  };
}

/**
 * @description The state machine's first-seen-S-1 hook. Claim-first: appends the `s1_alerted` timeline
 * event only when the plan has none, and announces the alert only when that claim won — so however
 * many times the caller reaches this point, the owner hears about the S-1 once. Never throws.
 * @param ctx - App context.
 * @param sub - Owner.
 * @param plan - The plan row as the tick loaded it.
 * @param s1 - The filing just seen.
 * @param notify - The delivery seam (production: announceEventAlert; a caller passes alertNotifierFrom(deps)
 * so its own injected seam wins; the spec injects a fake).
 * @returns True when this call raised the alert, false when it was already raised (or the claim failed).
 */
export async function alertFirstS1(ctx: AppContext, sub: string, plan: AlertPlanRef, s1: S1Filing, notify: EventAlertNotifier = announceEventAlert): Promise<boolean> {
  const alert = s1FiledAlert(plan, s1);
  const claimed = await claimTimelineEvent(ctx.pool, sub, plan.planId, 's1_alerted', s1.url || s1.form);
  if (!claimed) { logger.info({ sub, planId: plan.planId }, 'S-1 alert already raised for this plan — not repeating'); return false; }
  try {
    // Bounded HERE too, not only inside announceEventAlert: this runs inside stepWatching, and an
    // injected seam (or a future rail) must never be able to hold the state machine open.
    await withDeliveryDeadline(Promise.resolve(notify(ctx, sub, plan.planId, alert)));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, sub, planId: plan.planId }, 'S-1 alert delivery failed or timed out (the claim stands — no retry storm)');
  }
  return true;
}

/**
 * @description Append one timeline event to a plan UNLESS an event of that name is already on it —
 * the one UPDATE is the idempotency arbiter (no read-then-write race between two ticks).
 * @param pool - DB pool.
 * @param sub - Owner (the UPDATE is owner-scoped, so another sub can never claim on this plan).
 * @param planId - The plan.
 * @param event - The timeline event name to claim ('s1_alerted').
 * @param detail - Optional detail stored with the event.
 * @returns True when the event was appended by this call.
 */
export async function claimTimelineEvent(pool: AppContext['pool'], sub: string, planId: string, event: string, detail?: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `UPDATE oshal_trading_event_plans SET timeline = timeline || $3::jsonb, updated_at = now()
        WHERE user_sub = $1 AND plan_id = $2 AND NOT (timeline @> $4::jsonb) RETURNING plan_id`,
      [sub, planId, JSON.stringify([{ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }]), JSON.stringify([{ event }])]);
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, sub, planId, event }, 'event alert: timeline claim failed');
    return false;
  }
}

/**
 * @description Validate an operator-entered pricing date for `params.pricingDate`: YYYY-MM-DD that
 * round-trips through Date.UTC (so 2026-02-30 is refused) AND falls on a weekday, else null — never a
 * guessed date. The weekday rule is not cosmetic: an offering prices on a trading day, and the leg that
 * fires the reminders runs weekdays only, so a Saturday pricing date would give a T-0 whose due minute
 * can never be reached and which would later be recorded `expired`. Pure and import-free so the plan
 * normalizer can call it without pulling the clock module in (that module imports the plan module; a
 * static import back would be a cycle). Exchange holidays are NOT checked here — weekdays in v1.
 * @param raw - Whatever was posted.
 * @returns The date string, or null.
 */
export function normalizePricingDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (!(dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100)) return null;
  const wd = dt.getUTCDay();
  return wd === 0 || wd === 6 ? null : s;
}
