/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pluggable notification transport: proves the Telegram adapter no-ops when unconfigured (skipped, not error), POSTs sendMessage/sendVideo correctly, falls back to a text+link when video exceeds the 50MB inline cap, never surfaces the bot token in a result/error, resolves (never throws) on an API error, and the registry selects by kind/NOTIFY_TRANSPORT with a no-op fallback.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TelegramTransport,
  TwilioSmsTransport,
  TwilioVoiceTransport,
  xmlEscape,
  TELEGRAM_MAX_INLINE_BYTES,
  notifyOperator,
  resolveTransport,
  defaultTransportKind,
} from '../../src/features/notifications';

const TOKEN = 'BOTFAKE:xyz'; // short, obviously-fake — never a real bot token
const CHAT = '123456';

/** A fake fetch capturing the last call + returning a canned Telegram response. */
function fakeFetch(response: unknown = { ok: true, result: { message_id: 42 } }, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CONFIGURED = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT } as NodeJS.ProcessEnv;

describe('TelegramTransport', () => {
  it('is a no-op (skipped, not error) when unconfigured', async () => {
    const t = new TelegramTransport({ env: {} as NodeJS.ProcessEnv, fetch: fakeFetch().impl });
    expect(t.configured()).toBe(false);
    const r = await t.send({ text: 'hi' });
    expect(r).toMatchObject({ delivered: false, skipped: true, transport: 'telegram' });
  });

  it('POSTs a text message to sendMessage with the chat id', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ env: CONFIGURED, fetch: f.impl });
    const r = await t.send({ text: 'trade filled' });
    expect(r).toMatchObject({ delivered: true, transport: 'telegram', id: '42' });
    expect(f.calls[0].url).toContain('/sendMessage');
    expect(f.calls[0].body).toMatchObject({ chat_id: CHAT, text: 'trade filled' });
  });

  it('sends a small video inline via sendVideo', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ env: CONFIGURED, fetch: f.impl });
    const r = await t.send({ text: 'your episode', media: { url: 'https://x/v.mp4', kind: 'video', sizeBytes: 10 * 1024 * 1024 } });
    expect(r).toMatchObject({ delivered: true });
    expect(f.calls[0].url).toContain('/sendVideo');
    expect(f.calls[0].body).toMatchObject({ chat_id: CHAT, video: 'https://x/v.mp4' });
  });

  it('falls back to a text+link when the video exceeds the 50MB inline cap', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ env: CONFIGURED, fetch: f.impl });
    const r = await t.send({ text: 'your episode', media: { url: 'https://x/big.mp4', kind: 'video', sizeBytes: TELEGRAM_MAX_INLINE_BYTES + 1 } });
    expect(r).toMatchObject({ delivered: true, fellBackToLink: true });
    expect(f.calls[0].url).toContain('/sendMessage');
    expect(String((f.calls[0].body as { text: string }).text)).toContain('https://x/big.mp4');
  });

  it('falls back to a link when the media size is unknown', async () => {
    const f = fakeFetch();
    const t = new TelegramTransport({ env: CONFIGURED, fetch: f.impl });
    await t.send({ text: 'clip', media: { url: 'https://x/u.mp4', kind: 'video' } });
    expect(f.calls[0].url).toContain('/sendMessage');
  });

  it('NEVER surfaces the bot token in the result or error', async () => {
    const f = fakeFetch({ ok: false, description: 'chat not found' }, 400);
    const t = new TelegramTransport({ env: CONFIGURED, fetch: f.impl });
    const r = await t.send({ text: 'hi' });
    expect(r.delivered).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.error).toContain('telegram_sendMessage_http_400');
  });

  it('resolves (never throws) when fetch itself rejects', async () => {
    const impl = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const t = new TelegramTransport({ env: CONFIGURED, fetch: impl });
    const r = await t.send({ text: 'hi' });
    expect(r).toMatchObject({ delivered: false, transport: 'telegram', error: 'network down' });
  });
});

describe('notification registry', () => {
  it('defaults to telegram, honors NOTIFY_TRANSPORT, and falls back on unknown', () => {
    expect(defaultTransportKind({} as NodeJS.ProcessEnv)).toBe('telegram');
    expect(defaultTransportKind({ NOTIFY_TRANSPORT: 'noop' } as NodeJS.ProcessEnv)).toBe('noop');
    expect(defaultTransportKind({ NOTIFY_TRANSPORT: 'pigeon' } as NodeJS.ProcessEnv)).toBe('telegram');
  });

  it('resolveTransport returns the requested real kind (telegram + twilio sms/voice)', () => {
    expect(resolveTransport('telegram').kind).toBe('telegram');
    expect(resolveTransport('twilio-sms').kind).toBe('twilio-sms');
    expect(resolveTransport('twilio-voice').kind).toBe('twilio-voice');
    expect(resolveTransport('noop').kind).toBe('noop');
  });

  it('notifyOperator skips cleanly when nothing is configured', async () => {
    const r = await notifyOperator({ text: 'alert' }, { kind: 'telegram', deps: { env: {} as NodeJS.ProcessEnv, fetch: fakeFetch().impl } });
    expect(r).toMatchObject({ delivered: false, skipped: true });
  });

  it('notifyOperator delivers over a configured transport', async () => {
    const f = fakeFetch();
    const r = await notifyOperator({ text: 'watchdog: gap down' }, { kind: 'telegram', deps: { env: CONFIGURED, fetch: f.impl } });
    expect(r).toMatchObject({ delivered: true, transport: 'telegram' });
    expect(f.calls[0].body).toMatchObject({ text: 'watchdog: gap down' });
  });
});

describe('TwilioSmsTransport (the ≥2nd real implementation)', () => {
  const SID = 'ACfake';       // short, obviously-fake
  const AUTH = 'authfake';    // short, obviously-fake
  const TWILIO = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: AUTH, TWILIO_FROM_NUMBER: '+15550001111', TWILIO_TO_NUMBER: '+15550002222' } as NodeJS.ProcessEnv;

  /** Fake fetch that captures the form-encoded body + auth header. */
  function twilioFetch(response: unknown = { sid: 'SMxyz' }, status = 201) {
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const impl = vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      calls.push({ url, body: init?.body ?? '', auth: init?.headers?.Authorization });
      return { ok: status >= 200 && status < 300, status, json: async () => response } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('is a no-op (skipped) when any credential is missing', async () => {
    const t = new TwilioSmsTransport({ env: { TWILIO_ACCOUNT_SID: SID } as NodeJS.ProcessEnv, fetch: twilioFetch().impl });
    expect(t.configured()).toBe(false);
    expect(await t.send({ text: 'hi' })).toMatchObject({ delivered: false, skipped: true, transport: 'twilio-sms' });
  });

  it('POSTs a form-encoded SMS to the Messages API with Basic auth', async () => {
    const f = twilioFetch();
    const t = new TwilioSmsTransport({ env: TWILIO, fetch: f.impl });
    const r = await t.send({ text: 'gap-down alert' });
    expect(r).toMatchObject({ delivered: true, transport: 'twilio-sms', id: 'SMxyz' });
    expect(f.calls[0].url).toContain(`/Accounts/${SID}/Messages.json`);
    expect(f.calls[0].body).toContain('Body=gap-down+alert');
    expect(f.calls[0].body).toContain('To=%2B15550002222');
    expect(f.calls[0].auth).toMatch(/^Basic /);
  });

  it('appends a media URL to the SMS body (no inline media)', async () => {
    const f = twilioFetch();
    const t = new TwilioSmsTransport({ env: TWILIO, fetch: f.impl });
    const r = await t.send({ text: 'episode ready', media: { url: 'https://x/v.mp4', kind: 'video' } });
    expect(r).toMatchObject({ delivered: true, fellBackToLink: true });
    expect(decodeURIComponent(f.calls[0].body)).toContain('https://x/v.mp4');
  });

  it('NEVER surfaces the auth token in the result/error', async () => {
    const f = twilioFetch({ message: 'not authorized', code: 20003 }, 401);
    const t = new TwilioSmsTransport({ env: TWILIO, fetch: f.impl });
    const r = await t.send({ text: 'hi' });
    expect(r.delivered).toBe(false);
    expect(JSON.stringify(r)).not.toContain(AUTH);
    expect(r.error).toContain('twilio_sms_http_401');
  });

  it('resolves (never throws) when fetch rejects', async () => {
    const impl = vi.fn(async () => { throw new Error('dns fail'); }) as unknown as typeof fetch;
    const t = new TwilioSmsTransport({ env: TWILIO, fetch: impl });
    expect(await t.send({ text: 'hi' })).toMatchObject({ delivered: false, error: 'dns fail' });
  });
});

describe('TwilioVoiceTransport (the "call me" leg)', () => {
  const VOICE = { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'authfake', TWILIO_FROM_NUMBER: '+15550001111', TWILIO_TO_NUMBER: '+15550002222' } as NodeJS.ProcessEnv;
  function voiceFetch(response: unknown = { sid: 'CAxyz' }, status = 201) {
    const calls: Array<{ url: string; body: string }> = [];
    const impl = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? '' });
      return { ok: status >= 200 && status < 300, status, json: async () => response } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('no-ops when unconfigured', async () => {
    const t = new TwilioVoiceTransport({ env: {} as NodeJS.ProcessEnv, fetch: voiceFetch().impl });
    expect(await t.send({ text: 'hi' })).toMatchObject({ delivered: false, skipped: true, transport: 'twilio-voice' });
  });

  it('places a call with inline TwiML that speaks the text', async () => {
    const f = voiceFetch();
    const t = new TwilioVoiceTransport({ env: VOICE, fetch: f.impl });
    const r = await t.send({ text: 'gap down alert' });
    expect(r).toMatchObject({ delivered: true, transport: 'twilio-voice', id: 'CAxyz' });
    expect(f.calls[0].url).toContain('/Calls.json');
    // Parse the form body so '+'→space + %xx decoding are handled correctly.
    const twiml = new URLSearchParams(f.calls[0].body).get('Twiml') ?? '';
    expect(twiml).toBe('<Response><Say>gap down alert</Say></Response>');
  });

  it('XML-escapes the spoken text so it cannot break/inject the TwiML', async () => {
    const f = voiceFetch();
    const t = new TwilioVoiceTransport({ env: VOICE, fetch: f.impl });
    await t.send({ text: 'A & B <Hangup/> "risk"' });
    const twiml = new URLSearchParams(f.calls[0].body).get('Twiml') ?? '';
    expect(twiml).toBe('<Response><Say>A &amp; B &lt;Hangup/&gt; &quot;risk&quot;</Say></Response>');
    // The injected verb is escaped text, never a live TwiML element.
    expect(twiml).not.toContain('<Hangup/>');
  });

  it('xmlEscape is exported and handles all five entities', () => {
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});
