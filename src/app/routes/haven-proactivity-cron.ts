/**
 * Haven push proactivity — the opt-in outward delivery leg (ADR-030 property 3, ADR-079 deferral).
 *
 * ADR-079's proactivity is PULL: the lazy sweep computes suggestions and the Jarvis surface shows
 * them when the user arrives. This file is the PUSH leg — Haven reaching the user when they are not
 * looking — and every line of it exists to make that safe:
 *
 *   - **Per-user opt-in, default OFF** (operator directive). The gate reads the `haven-proactive`
 *     notification-preference row and NOTHING else. No row = no push. It deliberately does NOT go
 *     through `NotificationRouter.resolveRouting`'s fallback chain, which would inherit the welcome
 *     wizard's generic `default` row and then default again to *email-if-Gmail-else-none* — either
 *     of which would have switched unsolicited assistant messages on for people who never asked.
 *   - **Deployment gate on top.** The timer does not run at all unless `HAVEN_PUSH_CRON=1`, mirroring
 *     `JARVIS_BRIEF_CRON` — an operator turns the capability on, then each user turns themselves on.
 *   - **One notifier, not a second one.** Delivery is `NotificationRouter.notify(...)` — the existing
 *     per-user email / SMS / voice / Telegram senders, their availability checks, and their quiet
 *     hours. This file adds no transport.
 *   - **Bounded and honest.** At most {@link HAVEN_PUSH_DAILY_CAP} messages per user per day, each
 *     suggestion at most once ever (the durable `haven_push_deliveries` ledger), a teach nudge never
 *     pushed at all, and the ledger written only after a REAL delivery so a failed send retries
 *     instead of being silently marked done.
 *
 * `havenPushStatus` / `setHavenPushPreference` back the visible switch and its honest disabled state
 * on `/api/user-model/proactivity`.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: havenPushStatus/setHavenPushPreference (the visible per-user switch + honest disabled reason), pushProactiveForUser (explicit-topic-row gate → sweep → pushable selection → NotificationRouter delivery → durable ledger), pushProactiveForAllUsers over the opted-in set only, and the HAVEN_PUSH_CRON-gated timer.
 *
 * @module haven-proactivity-cron
 */

import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import {
  NOTIFY_CHANNELS,
  readUserPref,
  upsertUserPref,
  type NotifyChannel,
  type NotifyOutcome,
  type UserNotifyMessage,
} from '@/features/notifications';
import {
  HAVEN_PUSH_TOPIC,
  HAVEN_PUSH_DAILY_CAP,
  evaluatePushGate,
  formatHavenPush,
  selectPushableSuggestions,
  userModelFor,
  type HavenPushGate,
  type PendingSuggestion,
  type PushPreferenceLike,
} from '@/features/user-model';
import { buildNotificationRouter } from './notify-routes';

const logger = createChildLogger({ module: 'haven-proactivity-cron' });

/** How often the timer wakes. Delivery is still capped per user per day; this only sets latency. */
const TICK_MS = 30 * 60 * 1000;

let started = false;

export { HAVEN_PUSH_TOPIC, HAVEN_PUSH_DAILY_CAP };

/** What the settings surface renders: the switch state plus WHY it is off, in plain words. */
export interface HavenPushStatus extends HavenPushGate {
  topic: string;
  /** False when the deployment has not enabled the capability at all (HAVEN_PUSH_CRON unset). */
  deploymentEnabled: boolean;
  /** A sentence the surface can show verbatim. Never implies delivery that cannot happen. */
  explanation: string;
}

/** True only when the operator enabled the capability for this deployment. */
export function havenPushDeploymentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes'].includes(String(env.HAVEN_PUSH_CRON || '').toLowerCase());
}

/** The honest one-liner for a gate verdict — the disabled states must not read like "coming soon". */
function explain(gate: HavenPushGate, deploymentEnabled: boolean): string {
  if (!deploymentEnabled) {
    return 'Proactive updates are turned off for this deployment, so nothing will be sent even if you switch it on here.';
  }
  switch (gate.reason) {
    case 'ready':
      return `Haven can send you proactive updates over ${gate.channel} — at most ${HAVEN_PUSH_DAILY_CAP} a day, and never inside your quiet hours.`;
    case 'disabled':
      return 'You have muted proactive updates. Your saved channel is kept, so switching them back on takes one click.';
    case 'channel-none':
      return 'Proactive updates are on but routed to "none", so nothing is sent. Pick a channel to receive them.';
    case 'not-opted-in':
    default:
      return 'Haven never sends anything on its own. Turn this on to let it reach you about things it notices.';
  }
}

/**
 * @description The caller's push-proactivity switch state — the opt-in row, the resulting gate, the
 * deployment gate, and an honest explanation for a disabled state.
 * @param ctx - App context (pool).
 * @param userSub - The signed-in caller.
 * @returns The switch state for the settings surface.
 */
export async function havenPushStatus(ctx: AppContext, userSub: string): Promise<HavenPushStatus> {
  const pref = await readUserPref(ctx.pool, userSub, HAVEN_PUSH_TOPIC);
  const gate = evaluatePushGate(pref);
  const deploymentEnabled = havenPushDeploymentEnabled();
  return { ...gate, topic: HAVEN_PUSH_TOPIC, deploymentEnabled, explanation: explain(gate, deploymentEnabled) };
}

/** The fields the switch may set. Everything is optional except the on/off itself. */
export interface HavenPushPreferenceInput {
  enabled: boolean;
  channel?: string;
  phone?: string | null;
  telegramChatId?: string | null;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
}

/** Clamp an incoming quiet-hour to 0-23, or null. */
function quietHour(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const hour = Math.floor(Number(value));
  return hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * @description Save the caller's push-proactivity preference (full replace, like every other
 * preference card). Turning it OFF keeps the saved channel so re-enabling is one click; an unknown
 * channel is rejected rather than silently degraded, so the surface can never claim a route that
 * does not exist.
 * @param ctx - App context (pool).
 * @param userSub - The signed-in caller.
 * @param input - The switch state to persist.
 * @returns The resulting status, or an `error` when the channel was not a known one.
 */
export async function setHavenPushPreference(
  ctx: AppContext, userSub: string, input: HavenPushPreferenceInput,
): Promise<{ ok: true; status: HavenPushStatus } | { ok: false; error: string }> {
  const requested = String(input.channel ?? (input.enabled ? 'email' : 'none')).trim().toLowerCase();
  if (!(NOTIFY_CHANNELS as readonly string[]).includes(requested)) {
    return { ok: false, error: `channel must be one of: ${NOTIFY_CHANNELS.join(', ')}` };
  }
  await upsertUserPref(ctx.pool, {
    userSub,
    topic: HAVEN_PUSH_TOPIC,
    channel: requested as NotifyChannel,
    enabled: input.enabled === true,
    quietHoursStart: quietHour(input.quietHoursStart),
    quietHoursEnd: quietHour(input.quietHoursEnd),
    phone: input.phone ? String(input.phone).trim() : null,
    telegramChatId: input.telegramChatId ? String(input.telegramChatId).trim() : null,
  });
  logger.info({ enabled: input.enabled === true, channel: requested }, 'haven push preference saved');
  return { ok: true, status: await havenPushStatus(ctx, userSub) };
}

/** What one user's push run did. */
export interface HavenPushRunResult {
  sent: number;
  reason: 'delivered' | 'nothing-to-push' | 'daily-cap' | 'deployment-disabled' | HavenPushGate['reason'];
}

/** The slice of the user model a push run touches (UserModelService satisfies this structurally). */
export interface HavenPushModel {
  sweep(userSub: string): Promise<void>;
  pushesSentLastDay(userSub: string): Promise<number>;
  pendingSuggestions(userSub: string): Promise<PendingSuggestion[]>;
  pushedSuggestionIds(userSub: string): Promise<string[]>;
  recordPush(userSub: string, suggestionId: string, channel: string): Promise<void>;
}

/** Everything a push run reaches outside itself — injected so the guard can drive it with fakes. */
export interface HavenPushDeps {
  notifier: { notify(userSub: string, topic: string, message: UserNotifyMessage): Promise<NotifyOutcome> };
  model: HavenPushModel;
  /** Reads the user's `haven-proactive` row ONLY — no fallback topic, no default channel. */
  readPreference(userSub: string): Promise<PushPreferenceLike | null>;
  deploymentEnabled(): boolean;
}

/**
 * @description The production wiring of a push run: the shared NotificationRouter, the real user
 * model, and a preference read pinned to the `haven-proactive` topic.
 * @param ctx - App context (pool).
 * @returns Dependencies for {@link pushProactiveForUser}.
 */
export function defaultHavenPushDeps(ctx: AppContext): HavenPushDeps {
  const notifier = buildNotificationRouter(ctx);
  return {
    notifier,
    model: userModelFor(ctx.pool),
    readPreference: (userSub) => readUserPref(ctx.pool, userSub, HAVEN_PUSH_TOPIC),
    deploymentEnabled: () => havenPushDeploymentEnabled(),
  };
}

/**
 * @description Push this user's pending proactive suggestions, if and only if they opted in. Order
 * is deliberate: deployment gate → explicit per-user gate → sweep (so the suggestions are current)
 * → pushable selection under the once-ever + daily-cap guards → delivery through the shared
 * NotificationRouter (which applies their quiet hours and channel availability) → ledger the ones
 * that actually went out.
 * @param ctx - App context (pool, for prefs / suggestions / ledger).
 * @param userSub - The user to push to.
 * @param deps - Injected collaborators; defaults to the production wiring.
 * @returns How many messages went out and why, for the logs.
 */
export async function pushProactiveForUser(
  ctx: AppContext,
  userSub: string,
  deps: HavenPushDeps = defaultHavenPushDeps(ctx),
): Promise<HavenPushRunResult> {
  if (!deps.deploymentEnabled()) return { sent: 0, reason: 'deployment-disabled' };
  // The gate reads the haven-proactive row DIRECTLY. A generic `default` pref row must never
  // opt a user into unsolicited assistant messages — see the module doc.
  const gate = evaluatePushGate(await deps.readPreference(userSub));
  if (!gate.enabled) return { sent: 0, reason: gate.reason };

  const { model } = deps;
  await model.sweep(userSub);
  const remaining = HAVEN_PUSH_DAILY_CAP - (await model.pushesSentLastDay(userSub));
  if (remaining <= 0) return { sent: 0, reason: 'daily-cap' };

  const candidates = selectPushableSuggestions(
    await model.pendingSuggestions(userSub),
    await model.pushedSuggestionIds(userSub),
    remaining,
  );
  if (candidates.length === 0) return { sent: 0, reason: 'nothing-to-push' };

  let sent = 0;
  for (const suggestion of candidates) {
    const outcome = await deps.notifier.notify(userSub, HAVEN_PUSH_TOPIC, formatHavenPush(suggestion));
    if (!outcome.delivered) {
      logger.info({ suggestionId: suggestion.suggestionId, reason: outcome.reason }, 'haven push not delivered — ledger untouched, will retry');
      continue;
    }
    // Only a REAL delivery is ledgered, so a quiet-hours hold or a dead channel retries later.
    await model.recordPush(userSub, suggestion.suggestionId, outcome.channel);
    sent += 1;
  }
  return { sent, reason: sent > 0 ? 'delivered' : 'nothing-to-push' };
}

/** Every user who explicitly enabled the haven-proactive topic. Fails closed to [] (push nobody). */
async function listOptedInUsers(ctx: AppContext): Promise<string[]> {
  try {
    const result = await ctx.pool.query(
      `SELECT user_sub FROM user_notification_prefs
        WHERE topic = $1 AND enabled = TRUE AND channel <> 'none'`,
      [HAVEN_PUSH_TOPIC],
    );
    return result.rows.map((row: { user_sub: string }) => String(row.user_sub));
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack }, 'haven push: opted-in list failed — pushing to nobody this tick');
    return [];
  }
}

/**
 * @description One batch: push to every opted-in user. A per-user failure is logged and never
 * aborts the batch.
 * @param ctx - App context.
 */
export async function pushProactiveForAllUsers(ctx: AppContext): Promise<void> {
  const opted = await listOptedInUsers(ctx);
  if (opted.length === 0) return;
  const deps = defaultHavenPushDeps(ctx);
  for (const userSub of opted) {
    try {
      const result = await pushProactiveForUser(ctx, userSub, deps);
      if (result.sent > 0) logger.info({ ...result }, 'haven push: user delivered');
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'haven push: user failed');
    }
  }
}

/**
 * @description Start the gated push timer once. No-op unless `HAVEN_PUSH_CRON` is truthy — and even
 * then it only reaches users who individually opted in, so a deployment that flips the env var does
 * not start messaging anybody.
 * @param ctx - App context.
 */
export function startHavenProactivityCron(ctx: AppContext): void {
  if (started) return;
  started = true;
  if (!havenPushDeploymentEnabled()) {
    logger.info('haven push proactivity disabled (set HAVEN_PUSH_CRON=1; each user still opts in separately)');
    return;
  }
  logger.info({ tickMinutes: TICK_MS / 60000, dailyCap: HAVEN_PUSH_DAILY_CAP }, 'haven push proactivity enabled (per-user opt-in still required)');
  const timer = setInterval(() => {
    void runWithSystemIdentity(() => pushProactiveForAllUsers(ctx))
      .catch((err) => logger.error({ err, stack: (err as Error).stack }, 'haven push tick failed'));
  }, TICK_MS);
  timer.unref();
}
