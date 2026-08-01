/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Notification preference center: proves pref resolution (saved row wins; no row = injected default of email-if-Gmail-else-none), America/Chicago quiet-hours math incl. wrap-midnight, and every transport skip path (disabled, channel none, unavailable channel, unregistered sender, sender failure, sender throw, broken prefs table) resolves to a logged outcome — notify() never throws into a producer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | DEFAULT_TOPIC fallback + voice channel: a saved 'default' row governs topics with no row of their own (incl. its quiet hours), a topic-specific row still wins, topic==='default' never double-reads, and NOTIFY_CHANNELS carries 'voice' (migration 099) so a stored voice row routes instead of degrading to none.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOPIC,
  NOTIFY_CHANNELS,
  NotificationRouter,
  hourInTimeZone,
  isQuietHours,
  readUserPref,
  upsertUserPref,
  type NotifyChannel,
  type PgLike,
  type UserChannelSender,
  type UserNotificationPref,
} from '../../src/features/notifications';

/** A fake PgLike returning canned rows (or rejecting) and capturing calls. */
function fakePool(rows: Array<Record<string, unknown>> = [], fail = false) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const pool: PgLike = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      if (fail) throw new Error('relation "user_notification_prefs" does not exist');
      return { rows };
    },
  };
  return { pool, calls };
}

/** One saved pref row as Postgres would return it (snake_case). */
function prefRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_sub: 'user-1', topic: 'career-digest', channel: 'email', enabled: true,
    quiet_hours_start: null, quiet_hours_end: null, phone: null, telegram_chat_id: null,
    updated_at: '2026-07-15T12:00:00Z', ...over,
  };
}

/** A controllable sender: availability + result are injectable, calls are captured. */
function fakeSender(channel: Exclude<NotifyChannel, 'none'>, opts: { available?: boolean; delivered?: boolean; throws?: boolean } = {}) {
  const sent: Array<{ userSub: string; subject: string }> = [];
  const sender: UserChannelSender = {
    channel,
    async available() { return opts.available ?? true; },
    async send(userSub, _pref, message) {
      if (opts.throws) throw new Error('sender exploded');
      sent.push({ userSub, subject: message.subject });
      return opts.delivered === false ? { delivered: false, error: 'send-blew-up' } : { delivered: true, id: `${channel}-1` };
    },
  };
  return { sender, sent };
}

function router(pool: PgLike, senders: Partial<Record<Exclude<NotifyChannel, 'none'>, UserChannelSender>>, over: { defaultChannel?: NotifyChannel; now?: () => Date } = {}) {
  return new NotificationRouter({
    pool,
    senders,
    defaultChannel: async () => over.defaultChannel ?? 'email',
    ...(over.now ? { now: over.now } : {}),
  });
}

const MSG = { subject: 'test subject', body: 'test body', shortText: 'short' };

describe('quiet-hours math', () => {
  it('no window (null bounds) is never quiet', () => {
    expect(isQuietHours(null, null, 3)).toBe(false);
    expect(isQuietHours(22, null, 23)).toBe(false);
    expect(isQuietHours(null, 6, 3)).toBe(false);
  });

  it('a simple window is half-open [start, end)', () => {
    expect(isQuietHours(9, 17, 8)).toBe(false);
    expect(isQuietHours(9, 17, 9)).toBe(true);
    expect(isQuietHours(9, 17, 16)).toBe(true);
    expect(isQuietHours(9, 17, 17)).toBe(false);
  });

  it('a 22→6 window wraps midnight', () => {
    expect(isQuietHours(22, 6, 23)).toBe(true);
    expect(isQuietHours(22, 6, 2)).toBe(true);
    expect(isQuietHours(22, 6, 6)).toBe(false);
    expect(isQuietHours(22, 6, 12)).toBe(false);
  });

  it('start === end is an empty window (use enabled=false to mute)', () => {
    expect(isQuietHours(8, 8, 8)).toBe(false);
  });

  it('hourInTimeZone converts to America/Chicago (CDT = UTC-5 in July), not host TZ', () => {
    // 2026-07-15 04:00 UTC = 2026-07-14 23:00 in Chicago
    expect(hourInTimeZone(new Date(Date.UTC(2026, 6, 15, 4, 0)), 'America/Chicago')).toBe(23);
    // 2026-07-15 17:30 UTC = 12:30 in Chicago
    expect(hourInTimeZone(new Date(Date.UTC(2026, 6, 15, 17, 30)), 'America/Chicago')).toBe(12);
  });
});

describe('pref store', () => {
  it('readUserPref maps a row and scopes the query to (user_sub, topic)', async () => {
    const { pool, calls } = fakePool([prefRow({ channel: 'sms', phone: '+15551234567', quiet_hours_start: 22, quiet_hours_end: 6 })]);
    const pref = await readUserPref(pool, 'user-1', 'career-digest');
    expect(pref).toMatchObject({ userSub: 'user-1', topic: 'career-digest', channel: 'sms', phone: '+15551234567', quietHoursStart: 22, quietHoursEnd: 6, enabled: true });
    expect(calls[0].params).toEqual(['user-1', 'career-digest']);
  });

  it('readUserPref FAILS OPEN: a broken prefs table returns null, never throws', async () => {
    const { pool } = fakePool([], true);
    await expect(readUserPref(pool, 'user-1', 'career-digest')).resolves.toBeNull();
  });

  it('an unknown stored channel degrades to none (never a phantom send)', async () => {
    const { pool } = fakePool([prefRow({ channel: 'carrier-pigeon' })]);
    const pref = await readUserPref(pool, 'user-1', 'career-digest');
    expect(pref?.channel).toBe('none');
  });

  it('upsertUserPref writes the full row (full replace, so cleared fields really clear)', async () => {
    const { pool, calls } = fakePool([]);
    const pref: Omit<UserNotificationPref, 'updatedAt'> = {
      userSub: 'user-1', topic: 'alerts', channel: 'telegram', enabled: true,
      quietHoursStart: null, quietHoursEnd: null, phone: null, telegramChatId: '424242',
    };
    await upsertUserPref(pool, pref);
    expect(calls[0].text).toContain('ON CONFLICT (user_sub, topic)');
    expect(calls[0].params).toEqual(['user-1', 'alerts', 'telegram', true, null, null, null, '424242']);
  });
});

describe('NotificationRouter pref resolution', () => {
  it('no saved pref + default email → delivers over the email sender', async () => {
    const { pool } = fakePool([]);
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }, { defaultChannel: 'email' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'email', id: 'email-1' });
    expect(email.sent).toHaveLength(1);
  });

  it('no saved pref + no Gmail connection → default none, skipped', async () => {
    const { pool } = fakePool([]);
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }, { defaultChannel: 'none' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, channel: 'none', skipped: true, reason: 'channel-none' });
    expect(email.sent).toHaveLength(0);
  });

  it('a saved pref overrides the default channel', async () => {
    const { pool } = fakePool([prefRow({ channel: 'sms', phone: '+15551234567' })]);
    const email = fakeSender('email');
    const sms = fakeSender('sms');
    const r = await router(pool, { email: email.sender, sms: sms.sender }, { defaultChannel: 'email' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'sms' });
    expect(sms.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(0);
  });

  it('a disabled pref mutes the topic', async () => {
    const { pool } = fakePool([prefRow({ enabled: false })]);
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'disabled' });
    expect(email.sent).toHaveLength(0);
  });

  it('channel "none" is an explicit do-not-notify', async () => {
    const { pool } = fakePool([prefRow({ channel: 'none' })]);
    const r = await router(pool, { email: fakeSender('email').sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'channel-none' });
  });
});

describe('NotificationRouter DEFAULT_TOPIC fallback (the wizard one-answer opt-in)', () => {
  /** A pool that answers per-topic: params[1] picks which row (if any) comes back. */
  function topicPool(rowsByTopic: Record<string, Record<string, unknown>>) {
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const pool: PgLike = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        const row = rowsByTopic[String(params?.[1])];
        return { rows: row ? [row] : [] };
      },
    };
    return { pool, calls };
  }

  it('NOTIFY_CHANNELS carries voice (migration 099) — a stored voice row routes, never degrades to none', async () => {
    expect(NOTIFY_CHANNELS).toContain('voice');
    const { pool } = topicPool({ 'career-digest': prefRow({ channel: 'voice', phone: '+15551234567' }) });
    const voice = fakeSender('voice');
    const r = await router(pool, { voice: voice.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'voice' });
  });

  it("a saved 'default' row governs a topic with no row of its own", async () => {
    const { pool, calls } = topicPool({ [DEFAULT_TOPIC]: prefRow({ topic: DEFAULT_TOPIC, channel: 'sms', phone: '+15551234567' }) });
    const sms = fakeSender('sms');
    const r = await router(pool, { sms: sms.sender }, { defaultChannel: 'none' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'sms' });
    expect(calls.map((c) => c.params?.[1])).toEqual(['career-digest', DEFAULT_TOPIC]);
  });

  it('a topic-specific row still wins over the default row', async () => {
    const { pool } = topicPool({
      'career-digest': prefRow({ channel: 'email' }),
      [DEFAULT_TOPIC]: prefRow({ topic: DEFAULT_TOPIC, channel: 'sms', phone: '+15551234567' }),
    });
    const email = fakeSender('email');
    const sms = fakeSender('sms');
    const r = await router(pool, { email: email.sender, sms: sms.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'email' });
    expect(sms.sent).toHaveLength(0);
  });

  it("the default row's quiet hours apply when it is the row that resolved", async () => {
    const { pool } = topicPool({ [DEFAULT_TOPIC]: prefRow({ topic: DEFAULT_TOPIC, channel: 'sms', phone: '+15551234567', quiet_hours_start: 22, quiet_hours_end: 6 }) });
    const sms = fakeSender('sms');
    // 23:00 Chicago = 04:00 UTC — inside the window.
    const r = await router(pool, { sms: sms.sender }, { now: () => new Date(Date.UTC(2026, 6, 15, 4, 0)) }).notify('user-1', 'alerts', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'quiet-hours' });
  });

  it("notifying topic 'default' itself reads once — no double-read", async () => {
    const { pool, calls } = topicPool({});
    await router(pool, { email: fakeSender('email').sender }, { defaultChannel: 'none' }).notify('user-1', DEFAULT_TOPIC, MSG);
    expect(calls.map((c) => c.params?.[1])).toEqual([DEFAULT_TOPIC]);
  });

  it('no topic row and no default row falls through to the injected default', async () => {
    const { pool } = topicPool({});
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }, { defaultChannel: 'email' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'email' });
  });
});

describe('NotificationRouter quiet hours (America/Chicago)', () => {
  const quietPref = prefRow({ quiet_hours_start: 22, quiet_hours_end: 6 });

  it('holds a send inside the window (23:00 Chicago = 04:00 UTC)', async () => {
    const { pool } = fakePool([quietPref]);
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }, { now: () => new Date(Date.UTC(2026, 6, 15, 4, 0)) }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'quiet-hours' });
    expect(email.sent).toHaveLength(0);
  });

  it('delivers outside the window (12:30 Chicago = 17:30 UTC)', async () => {
    const { pool } = fakePool([quietPref]);
    const email = fakeSender('email');
    const r = await router(pool, { email: email.sender }, { now: () => new Date(Date.UTC(2026, 6, 15, 17, 30)) }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'email' });
  });
});

describe('NotificationRouter transport skip/failure paths (never throws)', () => {
  it('an unavailable channel is a clean skip', async () => {
    const { pool } = fakePool([prefRow({ channel: 'sms' })]);
    const sms = fakeSender('sms', { available: false });
    const r = await router(pool, { sms: sms.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'channel-unavailable' });
    expect(sms.sent).toHaveLength(0);
  });

  it('an unregistered sender is a clean skip (telegram before its sender exists)', async () => {
    const { pool } = fakePool([prefRow({ channel: 'telegram' })]);
    const r = await router(pool, { email: fakeSender('email').sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, skipped: true, reason: 'no-sender-registered' });
  });

  it('a sender failure result becomes reason send-failed with the sanitized error', async () => {
    const { pool } = fakePool([prefRow()]);
    const email = fakeSender('email', { delivered: false });
    const r = await router(pool, { email: email.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, channel: 'email', reason: 'send-failed', error: 'send-blew-up' });
  });

  it('a sender that THROWS still resolves to an outcome (the producer never sees it)', async () => {
    const { pool } = fakePool([prefRow()]);
    const email = fakeSender('email', { throws: true });
    const r = await router(pool, { email: email.sender }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, reason: 'error', error: 'sender exploded' });
  });

  it('a broken prefs table falls back to default routing instead of throwing', async () => {
    const { pool } = fakePool([], true);
    const email = fakeSender('email');
    // readUserPref fails open to null → defaultChannel('email') → delivered.
    const r = await router(pool, { email: email.sender }, { defaultChannel: 'email' }).notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: true, channel: 'email' });
  });

  it('defaultChannel itself throwing is caught and reported, not thrown', async () => {
    const { pool } = fakePool([]);
    const boom = new NotificationRouter({
      pool,
      senders: {},
      defaultChannel: vi.fn(async () => { throw new Error('connections table down'); }),
    });
    const r = await boom.notify('user-1', 'career-digest', MSG);
    expect(r).toMatchObject({ delivered: false, reason: 'error' });
  });
});
