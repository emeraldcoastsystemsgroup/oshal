/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-14 guard: the Notifications surface's sentence about whose credentials send a message is held to the senders production actually wires. With no personal connection and the deployment's notification service configured, the channels that still deliver are the service tier, and the page must name each of them as using the deployment's service instead of promising "never a shared deployment credential".
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/twilio-sms-operation', () => ({ sendUserTwilioSms: vi.fn() }));

import { buildNotificationRouter } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';
import type { UserChannelSender, UserNotificationPref } from '@/features/notifications';

const PAGE = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'cockpit', 'tools', 'notify.html'), 'utf8');

/** The page's lead paragraph as plain text — the sentence a user reads before choosing a channel. */
const LEAD = (/<p class="sub">([\s\S]*?)<\/p>/.exec(PAGE)?.[1] ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** How the page names each channel. */
const CHANNEL_WORDS: Record<string, RegExp> = {
  email: /\bemail\b/i,
  sms: /\bSMS\b|\btext messages?\b/i,
  voice: /\bvoice\b/i,
  telegram: /\bTelegram\b/,
};

/** A user with a saved phone and Telegram chat and NO personal connection of any kind. */
const PREF: UserNotificationPref = {
  userSub: 'user-1', topic: 'default', channel: 'sms', enabled: true,
  quietHoursStart: null, quietHoursEnd: null, phone: '+15557654321', telegramChatId: '424242',
  updatedAt: null,
};

/** Pool double that answers every connection lookup with "none connected". */
const NO_CONNECTIONS = { query: vi.fn(async () => ({ rows: [] })) } as unknown as AppContext['pool'];

/**
 * @description The channels production can still deliver on when the user has connected nothing:
 * the service tier. Read off the router `buildNotificationRouter` assembles, so a new fallback on
 * any channel changes this set and the page has to follow.
 * @returns Channel names, sorted.
 */
async function serviceTierChannels(): Promise<string[]> {
  const router = buildNotificationRouter({ pool: NO_CONNECTIONS } as AppContext);
  const senders = (router as unknown as { deps: { senders: Record<string, UserChannelSender> } }).deps.senders;
  const reachable: string[] = [];
  for (const [channel, sender] of Object.entries(senders)) {
    if (await sender.available(PREF.userSub, PREF)) reachable.push(channel);
  }
  return reachable.sort();
}

beforeEach(() => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+15550001111');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token-fixture');
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('Notifications page states the credential tier the senders actually use (BUG-14)', () => {
  it('the deployment tier is real: with nothing connected, SMS, voice and Telegram still deliver', async () => {
    expect(LEAD.length).toBeGreaterThan(40);
    expect(await serviceTierChannels()).toEqual(['sms', 'telegram', 'voice']);
  });

  it('the page does not promise that no deployment credential is ever used', () => {
    expect(LEAD).not.toMatch(/never (?:a|any) shared deployment credential/i);
  });

  it('the page names every service-tier channel alongside the deployment service', async () => {
    const sentences = LEAD.split(/(?<=[.;])\s+/);
    const unnamed = (await serviceTierChannels()).filter((channel) =>
      !sentences.some((s) => CHANNEL_WORDS[channel].test(s) && /deployment/i.test(s)));
    expect(unnamed).toEqual([]);
  });

  it('the page says the destination stays the user\'s own', () => {
    expect(LEAD).toMatch(/destination is always your own/i);
  });
});
