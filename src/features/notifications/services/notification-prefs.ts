/**
 * Notifications — the per-user, per-topic preference store (preference-center data layer).
 *
 * The existing transports in this slice are OPERATOR-level (env-configured, one destination).
 * The preference center adds the PER-USER dimension: each user picks, per topic (e.g.
 * 'career-digest'), which channel carries the notification — their own Gmail, their own
 * Twilio SMS, Telegram (once the BotFather token lands), or none — plus quiet hours in
 * America/Chicago. This file owns the `user_notification_prefs` table access
 * (079-notification-prefs.sql) and the pure quiet-hours math; the NotificationRouter
 * consumes both. Postgres is injected as a minimal `PgLike` so the feature layer never
 * imports app-layer context (FSD: features must not depend on app/).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NotifyChannel union, UserNotificationPref shape, read/list/upsert over user_notification_prefs (read fails OPEN to null so a prefs-table hiccup never mutes/blocks a producer), and the timezone-aware quiet-hours predicate (wrap-midnight supported).
 *
 * @module features/notifications/services/notification-prefs
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'notifications:prefs' });

/** Every channel a user can route a topic to. `none` = an explicit "do not notify me". */
export const NOTIFY_CHANNELS = ['email', 'sms', 'telegram', 'none'] as const;

/** A user's chosen delivery channel for one topic. */
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * The minimal Postgres surface this feature needs. Structurally satisfied by `pg.Pool` —
 * injected (never imported from app/) so the slice stays FSD-clean and unit-testable.
 */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** One saved routing preference: how (and when not) to reach this user about this topic. */
export interface UserNotificationPref {
  userSub: string;
  topic: string;
  channel: NotifyChannel;
  /** FALSE mutes the topic while keeping the saved routing for later re-enable. */
  enabled: boolean;
  /** Quiet-window start hour (0-23, America/Chicago); null = no quiet window. */
  quietHoursStart: number | null;
  /** Quiet-window end hour (0-23, America/Chicago); start > end wraps midnight. */
  quietHoursEnd: number | null;
  /** E.164 destination the sms channel texts (the user's own cell). */
  phone: string | null;
  /** Per-user Telegram chat id — deliverable once TELEGRAM_BOT_TOKEN is configured. */
  telegramChatId: string | null;
  updatedAt: string | null;
}

/** Map a `user_notification_prefs` row to the typed pref; unknown channel degrades to 'none'. */
function rowToPref(row: Record<string, unknown>): UserNotificationPref {
  const rawChannel = String(row.channel || '');
  return {
    userSub: String(row.user_sub || ''),
    topic: String(row.topic || ''),
    channel: (NOTIFY_CHANNELS as readonly string[]).includes(rawChannel) ? (rawChannel as NotifyChannel) : 'none',
    enabled: row.enabled !== false,
    quietHoursStart: row.quiet_hours_start == null ? null : Number(row.quiet_hours_start),
    quietHoursEnd: row.quiet_hours_end == null ? null : Number(row.quiet_hours_end),
    phone: row.phone ? String(row.phone) : null,
    telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  };
}

/**
 * @description Read one user's saved preference for a topic. FAILS OPEN: a query error
 * (e.g. migration not yet applied) logs at ERROR and returns null — "no saved pref" — so
 * a prefs-table hiccup can never break a producer like the career digest, only revert it
 * to default routing.
 * @param pool - Postgres pool (PgLike).
 * @param userSub - OIDC subject owning the pref.
 * @param topic - Producer topic key (e.g. 'career-digest').
 * @returns The saved pref, or null when none exists (or the read failed).
 */
export async function readUserPref(pool: PgLike, userSub: string, topic: string): Promise<UserNotificationPref | null> {
  try {
    const r = await pool.query(
      `SELECT user_sub, topic, channel, enabled, quiet_hours_start, quiet_hours_end, phone, telegram_chat_id, updated_at
         FROM user_notification_prefs WHERE user_sub=$1 AND topic=$2`,
      [userSub, topic]);
    return r.rows.length ? rowToPref(r.rows[0]) : null;
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, userSub, topic }, 'readUserPref failed — treating as no saved pref (default routing)');
    return null;
  }
}

/**
 * @description List every saved preference for a user (the GET /api/notify/prefs payload).
 * Throws on a DB error — routes surface it as a 500 (unlike readUserPref, nothing here
 * needs to fail open).
 * @param pool - Postgres pool (PgLike).
 * @param userSub - OIDC subject whose prefs to list.
 * @returns All saved prefs, topic-ordered.
 */
export async function listUserPrefs(pool: PgLike, userSub: string): Promise<UserNotificationPref[]> {
  const r = await pool.query(
    `SELECT user_sub, topic, channel, enabled, quiet_hours_start, quiet_hours_end, phone, telegram_chat_id, updated_at
       FROM user_notification_prefs WHERE user_sub=$1 ORDER BY topic`,
    [userSub]);
  return r.rows.map(rowToPref);
}

/**
 * @description Create or replace one (user, topic) preference row. Full replace (not a
 * patch) so a cleared quiet window / destination really clears — the POST route always
 * sends the whole card.
 * @param pool - Postgres pool (PgLike).
 * @param pref - The pref to persist (updatedAt is set server-side).
 * @returns Resolves when written; throws on DB error (route surfaces 500).
 */
export async function upsertUserPref(pool: PgLike, pref: Omit<UserNotificationPref, 'updatedAt'>): Promise<void> {
  await pool.query(
    `INSERT INTO user_notification_prefs
       (user_sub, topic, channel, enabled, quiet_hours_start, quiet_hours_end, phone, telegram_chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_sub, topic) DO UPDATE SET
       channel=$3, enabled=$4, quiet_hours_start=$5, quiet_hours_end=$6, phone=$7, telegram_chat_id=$8, updated_at=NOW()`,
    [pref.userSub, pref.topic, pref.channel, pref.enabled, pref.quietHoursStart, pref.quietHoursEnd, pref.phone, pref.telegramChatId]);
  logger.info({ userSub: pref.userSub, topic: pref.topic, channel: pref.channel, enabled: pref.enabled }, 'notification pref saved');
}

/**
 * @description The current hour-of-day (0-23) in a named IANA timezone — quiet hours are
 * stored as LOCAL America/Chicago hours, so the check must convert, not trust host TZ
 * (Git Bash on this host reports UTC; containers run UTC).
 * @param date - The instant to convert (usually now).
 * @param timeZone - IANA zone; defaults to America/Chicago per the preference-center spec.
 * @returns Hour 0-23 in that zone.
 */
export function hourInTimeZone(date: Date, timeZone: string = 'America/Chicago'): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
}

/**
 * @description Whether an hour falls inside a quiet window. Half-open [start, end): a
 * 22→6 window wraps midnight (quiet at 23 and 2, loud at 12); start === end means an
 * empty window (use enabled=false to mute entirely); either bound null = no window.
 * @param start - Quiet start hour (0-23) or null.
 * @param end - Quiet end hour (0-23) or null.
 * @param hour - The local hour to test (from hourInTimeZone).
 * @returns True when notifications should be held.
 */
export function isQuietHours(start: number | null, end: number | null, hour: number): boolean {
  if (start == null || end == null || !Number.isFinite(hour)) return false;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
