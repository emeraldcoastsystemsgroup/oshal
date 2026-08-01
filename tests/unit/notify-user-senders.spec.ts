/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the welcome-wizard notification channels: the SMS sender falls back to the DEPLOYMENT's env Twilio (destination = the user's saved pref.phone) when the user has no personal Twilio connection — and the personal connection still wins; the new per-user voice channel needs only phone + env creds; neither channel is available without a saved phone; and the fallback send really carries To=pref.phone (asserted against the captured Twilio API request, not a substring).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { envTwilioConfigured, smsSender, voiceSender } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';
import type { UserNotificationPref } from '@/features/notifications';

const ENV_CREDS = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550001111' };

/** Pool double: `hasPersonalTwilio` controls the oshal_connections provider='twilio' probe. */
function fakePool(hasPersonalTwilio: boolean): AppContext['pool'] {
  return {
    query: vi.fn(async (sql: string) => {
      if (/oshal_connections/.test(sql) && /twilio/.test(sql)) return { rows: hasPersonalTwilio ? [{ ok: 1 }] : [] };
      return { rows: [] };
    }),
  } as unknown as AppContext['pool'];
}

function pref(over: Partial<UserNotificationPref> = {}): UserNotificationPref {
  return {
    userSub: 'user-1', topic: 'default', channel: 'sms', enabled: true,
    quietHoursStart: null, quietHoursEnd: null, phone: '+15557654321', telegramChatId: null,
    updatedAt: null, ...over,
  };
}

function stubEnvCreds(present: boolean) {
  for (const [k, v] of Object.entries(ENV_CREDS)) vi.stubEnv(k, present ? v : '');
  vi.stubEnv('TWILIO_TO_NUMBER', '');
  vi.stubEnv('NOTIFY_SMS_TO', '');
  vi.stubEnv('NOTIFY_VOICE_TO', '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('envTwilioConfigured', () => {
  it('requires SID + token + from-number together', () => {
    expect(envTwilioConfigured({ ...ENV_CREDS })).toBe(true);
    expect(envTwilioConfigured({ ...ENV_CREDS, TWILIO_FROM_NUMBER: '' })).toBe(false);
    expect(envTwilioConfigured({ ...ENV_CREDS, TWILIO_ACCOUNT_SID: ' ' })).toBe(false);
    expect(envTwilioConfigured({})).toBe(false);
  });
});

describe('smsSender availability (personal Twilio OR deployment env fallback)', () => {
  it('no saved phone → unavailable, regardless of creds', async () => {
    stubEnvCreds(true);
    expect(await smsSender(fakePool(true)).available('user-1', pref({ phone: null }))).toBe(false);
  });

  it('phone + personal Twilio connection → available even without env creds', async () => {
    stubEnvCreds(false);
    expect(await smsSender(fakePool(true)).available('user-1', pref())).toBe(true);
  });

  it('phone + env creds but NO personal connection → available (the family-user fallback)', async () => {
    stubEnvCreds(true);
    expect(await smsSender(fakePool(false)).available('user-1', pref())).toBe(true);
  });

  it('phone but neither personal connection nor env creds → clean unavailable', async () => {
    stubEnvCreds(false);
    expect(await smsSender(fakePool(false)).available('user-1', pref())).toBe(false);
  });
});

describe('smsSender env-fallback send path', () => {
  it('sends via the Twilio API with To = the USER\'s pref.phone (never an env destination)', async () => {
    stubEnvCreds(true);
    const captured: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body || '') });
      return { ok: true, json: async () => ({ sid: 'SM123' }) } as Response;
    }));
    const r = await smsSender(fakePool(false)).send('user-1', pref({ phone: '+15557654321' }), { subject: 'subj', body: 'body', shortText: 'ping' });
    expect(r).toMatchObject({ delivered: true, id: 'SM123' });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('api.twilio.com');
    const params = new URLSearchParams(captured[0].body);
    expect(params.get('To')).toBe('+15557654321');
    expect(params.get('From')).toBe(ENV_CREDS.TWILIO_FROM_NUMBER);
    expect(params.get('Body')).toBe('ping');
  });
});

describe('voiceSender (per-user voice channel, migration 099)', () => {
  it('unavailable without a saved phone or without env creds', async () => {
    stubEnvCreds(true);
    expect(await voiceSender().available('user-1', pref({ phone: null }))).toBe(false);
    stubEnvCreds(false);
    expect(await voiceSender().available('user-1', pref())).toBe(false);
  });

  it('available with phone + env creds, and the call goes to the USER\'s number', async () => {
    stubEnvCreds(true);
    expect(await voiceSender().available('user-1', pref())).toBe(true);
    const captured: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body || '') });
      return { ok: true, json: async () => ({ sid: 'CA123' }) } as Response;
    }));
    const r = await voiceSender().send('user-1', pref({ phone: '+15557654321' }), { subject: 'subj', body: 'body', shortText: 'your job finished' });
    expect(r).toMatchObject({ delivered: true, id: 'CA123' });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/Calls.json');
    const params = new URLSearchParams(captured[0].body);
    expect(params.get('To')).toBe('+15557654321');
    expect(String(params.get('Twiml'))).toContain('your job finished');
  });
});
