/**
 * Notifications — the per-user NotificationRouter (preference-center dispatch).
 *
 * `notify(userSub, topic, message)` is the ONE call any producer (career digest, trading
 * alerts, job pipelines) makes to reach a user: it resolves the user's saved pref for the
 * topic (default: email when the user has a Gmail-send connection, else none), holds sends
 * inside the user's quiet hours (America/Chicago), and dispatches through a registry of
 * per-user channel senders. The senders themselves are INJECTED from the app layer because
 * they wrap app-owned machinery (sendGmail, fixed connector operations, and Telegram)
 * — the router stays FSD-clean and unit-testable with fakes.
 *
 * Contract mirrors notification-service.ts: every send/skip is logged, an unavailable
 * channel is a `skipped` outcome (never an error), and notify() NEVER throws into the
 * caller — a digest batch must not die because one user's channel is misconfigured.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NotificationRouter (pref resolution with Gmail-else-none default, America/Chicago quiet hours, injected per-user sender registry, never-throw outcomes) + the UserChannelSender/UserNotifyMessage/NotifyOutcome contracts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | resolveRouting now falls back to the user's DEFAULT_TOPIC ('default') row before the injected default channel: the welcome wizard writes ONE opt-in row that should govern every topic the user hasn't customized — without this, a wizard "text me" answer only ever covered the literal topic 'default' and every real producer topic silently kept the Gmail-else-none default. Topic-specific rows still win, and the fallback row's quiet hours apply when it is the one that resolved.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Document the SEC-05 fixed-operation boundary after retirement of the generic Twilio CLI carrier; routing behavior is unchanged.
 *
 * @module features/notifications/services/notification-router
 */

import { createChildLogger } from '@/shared/logger';
import {
  hourInTimeZone,
  isQuietHours,
  readUserPref,
  type NotifyChannel,
  type PgLike,
  type UserNotificationPref,
} from './notification-prefs';

const logger = createChildLogger({ module: 'notifications:router' });

/**
 * The catch-all topic the welcome wizard (and any generic opt-in surface) writes: a saved
 * row for this topic routes every topic the user has not customized. Topic-specific rows
 * always win over it; it wins over the injected Gmail-else-none default.
 */
export const DEFAULT_TOPIC = 'default';

/** One user-facing notification. `shortText` is the SMS-sized nudge; email gets subject+body. */
export interface UserNotifyMessage {
  subject: string;
  body: string;
  /** Optional one-liner for length-constrained channels (SMS); falls back to subject. */
  shortText?: string;
}

/** What one notify() attempt did — a result, never an exception. */
export interface NotifyOutcome {
  delivered: boolean;
  /** The channel that was (or would have been) used. */
  channel: NotifyChannel;
  /** True when nothing was attempted (prefs off, quiet hours, channel unavailable). */
  skipped?: boolean;
  /** Machine-readable why for skips/failures (e.g. 'quiet-hours', 'channel-unavailable'). */
  reason?: string;
  /** Provider message id when delivered. */
  id?: string;
  /** Sanitized error text (never a token/secret). */
  error?: string;
}

/**
 * A per-user channel sender the app layer registers with the router. Unlike the operator
 * `NotificationTransport` (env-configured, one destination), these resolve the DESTINATION
 * and credentials per user (their own Gmail address, their own Twilio, their chat id).
 * Both methods must resolve, never throw — the router also guards, but the contract is theirs.
 */
export interface UserChannelSender {
  /** The channel this sender carries. */
  readonly channel: Exclude<NotifyChannel, 'none'>;
  /** True only when this user can actually be reached right now (creds + destination present). */
  available(userSub: string, pref: UserNotificationPref | null): Promise<boolean>;
  /** Deliver to this user. Resolves with a result; a failure is a result, not an exception. */
  send(
    userSub: string,
    pref: UserNotificationPref | null,
    message: UserNotifyMessage,
  ): Promise<{ delivered: boolean; id?: string; error?: string }>;
}

/** Router construction dependencies — all injected so the feature layer owns no app machinery. */
export interface NotificationRouterDeps {
  /** Postgres (PgLike; structurally a pg.Pool) for pref reads. */
  pool: PgLike;
  /** The registered per-user senders, keyed by channel. */
  senders: Partial<Record<Exclude<NotifyChannel, 'none'>, UserChannelSender>>;
  /** Default channel when the user saved no pref for the topic (spec: Gmail-connected → email, else none). */
  defaultChannel: (userSub: string) => Promise<NotifyChannel>;
  /** Clock override for quiet-hours tests. */
  now?: () => Date;
  /** Timezone override for tests; production is America/Chicago per spec. */
  timeZone?: string;
}

/** Routes one notification to one user over their preferred channel. See module doc. */
export class NotificationRouter {
  private readonly deps: NotificationRouterDeps;

  constructor(deps: NotificationRouterDeps) {
    this.deps = deps;
  }

  /**
   * @description Resolve the effective routing for (user, topic): the saved pref row when
   * one exists, else the user's DEFAULT_TOPIC row (the wizard's one-answer opt-in — its
   * channel, destinations, AND quiet hours apply), else the injected default
   * (email-if-Gmail-else-none) with enabled=true and no quiet window. Split out so
   * producers can preview routing without sending.
   * @param userSub - OIDC subject to route for.
   * @param topic - Producer topic key.
   * @returns The effective channel/enabled plus the pref row that resolved (null when defaulted).
   */
  async resolveRouting(userSub: string, topic: string): Promise<{ channel: NotifyChannel; enabled: boolean; pref: UserNotificationPref | null }> {
    const pref = await readUserPref(this.deps.pool, userSub, topic);
    if (pref) return { channel: pref.channel, enabled: pref.enabled, pref };
    if (topic !== DEFAULT_TOPIC) {
      const fallback = await readUserPref(this.deps.pool, userSub, DEFAULT_TOPIC);
      if (fallback) return { channel: fallback.channel, enabled: fallback.enabled, pref: fallback };
    }
    return { channel: await this.deps.defaultChannel(userSub), enabled: true, pref: null };
  }

  /**
   * @description Send one notification to one user, honoring their per-topic preference and
   * quiet hours. NEVER throws — every path (prefs off, quiet hours, unavailable channel,
   * sender failure, even a broken prefs read) resolves to a logged NotifyOutcome, so batch
   * producers can loop users safely.
   * @param userSub - OIDC subject to notify.
   * @param topic - Producer topic key (matches the pref row, e.g. 'career-digest').
   * @param message - Subject/body (+ optional shortText for SMS).
   * @returns What happened (delivered / skipped+reason / error).
   */
  async notify(userSub: string, topic: string, message: UserNotifyMessage): Promise<NotifyOutcome> {
    const startedAt = Date.now();
    try {
      const { channel, enabled, pref } = await this.resolveRouting(userSub, topic);
      if (!enabled || channel === 'none') {
        const reason = !enabled ? 'disabled' : 'channel-none';
        logger.info({ userSub, topic, channel, reason }, 'notify skipped by preference');
        return { delivered: false, channel, skipped: true, reason };
      }
      if (pref && isQuietHours(pref.quietHoursStart, pref.quietHoursEnd, hourInTimeZone((this.deps.now ?? (() => new Date()))(), this.deps.timeZone))) {
        logger.info({ userSub, topic, channel, quiet: [pref.quietHoursStart, pref.quietHoursEnd] }, 'notify held: inside quiet hours');
        return { delivered: false, channel, skipped: true, reason: 'quiet-hours' };
      }
      return await this.dispatch(userSub, topic, channel, pref, message, startedAt);
    } catch (err) {
      // Last-resort guard: notify() must never throw into a producer.
      logger.error({ err, stack: (err as Error).stack, userSub, topic }, 'notify failed unexpectedly');
      return { delivered: false, channel: 'none', reason: 'error', error: (err as Error).message };
    }
  }

  /** Run the resolved channel's sender: availability gate → send → logged outcome. */
  private async dispatch(
    userSub: string, topic: string, channel: Exclude<NotifyChannel, 'none'>,
    pref: UserNotificationPref | null, message: UserNotifyMessage, startedAt: number,
  ): Promise<NotifyOutcome> {
    const sender = this.deps.senders[channel];
    if (!sender) {
      logger.warn({ userSub, topic, channel }, 'notify skipped: no sender registered for channel');
      return { delivered: false, channel, skipped: true, reason: 'no-sender-registered' };
    }
    if (!(await sender.available(userSub, pref))) {
      logger.info({ userSub, topic, channel }, 'notify skipped: channel unavailable for user (creds/destination missing)');
      return { delivered: false, channel, skipped: true, reason: 'channel-unavailable' };
    }
    const result = await sender.send(userSub, pref, message);
    const durationMs = Date.now() - startedAt;
    logger.info({ userSub, topic, channel, delivered: result.delivered, id: result.id, error: result.error, durationMs }, 'notify dispatched');
    if (result.delivered) return { delivered: true, channel, ...(result.id ? { id: result.id } : {}) };
    return { delivered: false, channel, reason: 'send-failed', ...(result.error ? { error: result.error } : {}) };
  }
}
