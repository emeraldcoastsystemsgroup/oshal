/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WhatsApp-via-Twilio transport tests: no-op when unconfigured, whatsapp: address prefix on From/To, native MediaUrl (no link fallback), caption folded into body, NOTIFY_WHATSAPP_TO fallback, token never surfaced, resolves on API error, registry selects the kind.
 */

import { describe, expect, it } from 'vitest';
import {
  TwilioWhatsAppTransport,
  whatsAppAddr,
  resolveTransport,
  notifyOperator,
} from '../../src/features/notifications';

const AUTH = 'authfake123'; // short, obviously-fake — never a real Twilio auth token

/** A fake fetch that records the last request and returns a canned Twilio Messages response. */
function fakeFetch(response: unknown = { sid: 'WA123' }, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => response } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const FULL_ENV = {
  TWILIO_ACCOUNT_SID: 'ACfake',
  TWILIO_AUTH_TOKEN: AUTH,
  TWILIO_WHATSAPP_FROM: '+14155238886',
  TWILIO_WHATSAPP_TO: '+13055550100',
} as NodeJS.ProcessEnv;

function body(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

describe('whatsAppAddr', () => {
  it('prefixes a bare number', () => expect(whatsAppAddr('+14155238886')).toBe('whatsapp:+14155238886'));
  it('is idempotent when already prefixed', () => expect(whatsAppAddr('whatsapp:+1415')).toBe('whatsapp:+1415'));
  it('trims surrounding whitespace', () => expect(whatsAppAddr('  +1415 ')).toBe('whatsapp:+1415'));
});

describe('TwilioWhatsAppTransport', () => {
  it('no-ops (skipped, not error) when unconfigured', async () => {
    const t = new TwilioWhatsAppTransport({ env: {} as NodeJS.ProcessEnv });
    expect(t.configured()).toBe(false);
    const r = await t.send({ text: 'hi' });
    expect(r).toMatchObject({ delivered: false, skipped: true, transport: 'twilio-whatsapp' });
  });

  it('POSTs to the Messages API with whatsapp: prefixes on From and To', async () => {
    const fetchMock = fakeFetch();
    const t = new TwilioWhatsAppTransport({ env: FULL_ENV, fetch: fetchMock.impl });
    const r = await t.send({ text: 'build finished' });
    expect(r).toMatchObject({ delivered: true, transport: 'twilio-whatsapp', id: 'WA123' });
    expect(fetchMock.calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages.json');
    const form = body(fetchMock.calls[0].init);
    expect(form.get('From')).toBe('whatsapp:+14155238886');
    expect(form.get('To')).toBe('whatsapp:+13055550100');
    expect(form.get('Body')).toBe('build finished');
  });

  it('sends media natively as MediaUrl (no link fallback) with the caption folded into the body', async () => {
    const fetchMock = fakeFetch();
    const t = new TwilioWhatsAppTransport({ env: FULL_ENV, fetch: fetchMock.impl });
    const r = await t.send({ text: 'recap', media: { url: 'https://cdn.test/v.mp4', kind: 'video', caption: 'day 1' } });
    const form = body(fetchMock.calls[0].init);
    expect(form.get('MediaUrl')).toBe('https://cdn.test/v.mp4');
    expect(form.get('Body')).toBe('recap\nday 1');
    expect(r.fellBackToLink).toBeUndefined(); // WhatsApp carries media inline
  });

  it('falls back to NOTIFY_WHATSAPP_TO for the destination', () => {
    const env = { ...FULL_ENV, TWILIO_WHATSAPP_TO: '', NOTIFY_WHATSAPP_TO: '+1305' } as NodeJS.ProcessEnv;
    expect(new TwilioWhatsAppTransport({ env }).configured()).toBe(true);
  });

  it('never surfaces the auth token in a result or error', async () => {
    const fetchMock = fakeFetch({ message: 'bad', code: 63007 }, 400);
    const t = new TwilioWhatsAppTransport({ env: FULL_ENV, fetch: fetchMock.impl });
    const r = await t.send({ text: 'x' });
    expect(r.delivered).toBe(false);
    expect(JSON.stringify(r)).not.toContain(AUTH);
  });

  it('resolves (never throws) when fetch rejects', async () => {
    const impl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const t = new TwilioWhatsAppTransport({ env: FULL_ENV, fetch: impl });
    const r = await t.send({ text: 'x' });
    expect(r).toMatchObject({ delivered: false, transport: 'twilio-whatsapp' });
  });
});

describe('registry integration', () => {
  it('resolveTransport selects the twilio-whatsapp kind', () => {
    expect(resolveTransport('twilio-whatsapp', { env: FULL_ENV }).kind).toBe('twilio-whatsapp');
  });

  it('notifyOperator routes through the WhatsApp transport when asked', async () => {
    const fetchMock = fakeFetch();
    const r = await notifyOperator({ text: 'hello' }, { kind: 'twilio-whatsapp', deps: { env: FULL_ENV, fetch: fetchMock.impl } });
    expect(r).toMatchObject({ delivered: true, transport: 'twilio-whatsapp', id: 'WA123' });
  });
});
