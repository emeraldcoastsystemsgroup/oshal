/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the inbound SMS webhook: parseTwilioInboundSms normalizes a real Twilio form payload (and returns null on a malformed one), verifyTwilioSignature accepts a correctly-signed request and rejects a forged/missing/tampered one, and the POST /api/sms/inbound route 503s when the auth token is unset, 403s a bad signature, 400s a signed-but-malformed payload, and 200s (empty TwiML) + dispatches to the sink on a valid signed message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  flattenFormParams,
  parseTwilioInboundSms,
  twilioSignatureBase,
  verifyTwilioSignature,
  type InboundSms,
} from '../../src/features/notifications';
import { createSmsInboundRoutes } from '@/app/routes/sms-inbound-routes';

const AUTH = 'twilio-auth-token-fake'; // obviously-fake
const PUBLIC_URL = 'https://oshal.example.test/api/sms/inbound';
const realFetch = globalThis.fetch;

/** A representative Twilio inbound-SMS form payload. */
const SAMPLE = {
  MessageSid: 'SM0123456789abcdef',
  AccountSid: 'AC0123456789abcdef',
  From: '+15551230000',
  To: '+15559990000',
  Body: 'STOP please',
  NumMedia: '0',
} as Record<string, string>;

/** Compute the base64 HMAC-SHA1 signature Twilio would send for (url, params). */
function sign(url: string, params: Record<string, string>, token = AUTH): string {
  return createHmac('sha1', token).update(Buffer.from(twilioSignatureBase(url, params), 'utf-8')).digest('base64');
}

describe('parseTwilioInboundSms', () => {
  it('normalizes a real Twilio payload into the internal shape', () => {
    const now = () => new Date('2026-07-25T07:55:00.000Z');
    const sms = parseTwilioInboundSms(SAMPLE, { now });
    expect(sms).toEqual<InboundSms>({
      messageSid: 'SM0123456789abcdef',
      accountSid: 'AC0123456789abcdef',
      from: '+15551230000',
      to: '+15559990000',
      body: 'STOP please',
      numMedia: 0,
      mediaUrls: [],
      receivedAt: '2026-07-25T07:55:00.000Z',
    });
  });

  it('collects media URLs for an MMS', () => {
    const sms = parseTwilioInboundSms({
      ...SAMPLE, NumMedia: '2', MediaUrl0: 'https://api.twilio.com/m0.jpg', MediaUrl1: 'https://api.twilio.com/m1.jpg',
    });
    expect(sms?.numMedia).toBe(2);
    expect(sms?.mediaUrls).toEqual(['https://api.twilio.com/m0.jpg', 'https://api.twilio.com/m1.jpg']);
  });

  it('returns null on a malformed payload (missing MessageSid/From/To)', () => {
    expect(parseTwilioInboundSms({ From: '+15551230000', To: '+15559990000' })).toBeNull(); // no MessageSid
    expect(parseTwilioInboundSms({ MessageSid: 'SM1', To: '+15559990000' })).toBeNull();     // no From
    expect(parseTwilioInboundSms({ MessageSid: 'SM1', From: '+15551230000' })).toBeNull();    // no To
  });

  it('flattenFormParams takes the first value of an array-valued field', () => {
    expect(flattenFormParams({ From: ['+1', '+2'] as unknown as string, Body: 'hi' })).toMatchObject({ From: '+1', Body: 'hi' });
  });
});

describe('verifyTwilioSignature', () => {
  it('accepts a correctly-signed request', () => {
    const signature = sign(PUBLIC_URL, SAMPLE);
    expect(verifyTwilioSignature({ authToken: AUTH, signature, url: PUBLIC_URL, params: SAMPLE })).toBe(true);
  });

  it('rejects a forged signature', () => {
    expect(verifyTwilioSignature({ authToken: AUTH, signature: 'not-a-real-sig', url: PUBLIC_URL, params: SAMPLE })).toBe(false);
  });

  it('rejects a missing signature and a missing auth token', () => {
    expect(verifyTwilioSignature({ authToken: AUTH, signature: undefined, url: PUBLIC_URL, params: SAMPLE })).toBe(false);
    expect(verifyTwilioSignature({ authToken: '', signature: sign(PUBLIC_URL, SAMPLE), url: PUBLIC_URL, params: SAMPLE })).toBe(false);
  });

  it('rejects when a param was tampered with after signing', () => {
    const signature = sign(PUBLIC_URL, SAMPLE);
    const tampered = { ...SAMPLE, Body: 'YES send me everything' };
    expect(verifyTwilioSignature({ authToken: AUTH, signature, url: PUBLIC_URL, params: tampered })).toBe(false);
  });
});

describe('POST /api/sms/inbound (route)', () => {
  beforeEach(() => {
    process.env.TWILIO_INBOUND_PUBLIC_URL = PUBLIC_URL;
  });
  afterEach(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_INBOUND_PUBLIC_URL;
  });

  async function post(app: express.Express, body: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; text: string }> {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await realFetch(`http://127.0.0.1:${port}/api/sms/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body).toString(),
      });
      return { status: res.status, text: await res.text() };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function appWith(sink?: (sms: InboundSms) => void): express.Express {
    const app = express();
    app.use('/api/sms', createSmsInboundRoutes(sink ? { onInboundSms: sink } : {}));
    return app;
  }

  it('503s (disabled, not a 500) when TWILIO_AUTH_TOKEN is unset', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await post(appWith(), SAMPLE, { 'X-Twilio-Signature': sign(PUBLIC_URL, SAMPLE) });
    expect(res.status).toBe(503);
  });

  it('403s a bad/missing signature (unauthenticated)', async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    const bad = await post(appWith(), SAMPLE, { 'X-Twilio-Signature': 'wrong' });
    expect(bad.status).toBe(403);
    const missing = await post(appWith(), SAMPLE, {});
    expect(missing.status).toBe(403);
  });

  it('400s a correctly-signed but malformed payload', async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    const malformed = { MessageSid: 'SM1', To: '+15559990000' } as Record<string, string>; // no From
    const res = await post(appWith(), malformed, { 'X-Twilio-Signature': sign(PUBLIC_URL, malformed) });
    expect(res.status).toBe(400);
  });

  it('200s (empty TwiML) and dispatches to the sink on a valid signed message', async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH;
    const sink = vi.fn();
    const res = await post(appWith(sink), SAMPLE, { 'X-Twilio-Signature': sign(PUBLIC_URL, SAMPLE) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response></Response>');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatchObject({ messageSid: 'SM0123456789abcdef', from: '+15551230000', body: 'STOP please' });
  });
});
