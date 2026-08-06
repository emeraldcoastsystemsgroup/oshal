/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 regression guard for the caller-owned, schema-bounded Twilio SMS operation: exact endpoints and form, credential confinement to HTTP Basic auth, input short-circuiting, sanitized output, and fail-closed connector credential parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition/app-context';

const tokenBroker = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
}));

vi.mock('@/app/routes/connectors-routes', () => ({
  getValidAccessToken: tokenBroker.getValidAccessToken,
}));

import { sendUserTwilioSms } from '@/app/routes/twilio-sms-operation';

const OWNER_SUB = 'oidc|twilio-owner';
const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const AUTH_TOKEN = 'b'.repeat(32);
const CONNECTOR_SECRET = `${ACCOUNT_SID}:${AUTH_TOKEN}`;
const FROM_NUMBER = '+15550001111';
const TO_NUMBER = '+15557654321';
const MESSAGE_SID = `SM${'c'.repeat(32)}`;
const API_BASE = 'https://api.twilio.com/2010-04-01';
const pool = { query: vi.fn() } as unknown as AppContext['pool'];

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/** Build a real fetch-compatible JSON response without allowing a network request. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  tokenBroker.getValidAccessToken.mockReset();
  tokenBroker.getValidAccessToken.mockResolvedValue(CONNECTOR_SECRET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fixed per-user Twilio SMS operation', () => {
  it('uses only the owner connector secret for two exact Twilio requests and returns sanitized data', async () => {
    const captured: CapturedRequest[] = [];
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init: RequestInit = {},
    ): Promise<Response> => {
      captured.push({ url: String(input), init });
      return captured.length === 1
        ? jsonResponse({ incoming_phone_numbers: [{ phone_number: FROM_NUMBER }] })
        : jsonResponse({ sid: MESSAGE_SID });
    });
    vi.stubGlobal('fetch', fetchMock);
    const environmentBefore = { ...process.env };

    const result = await sendUserTwilioSms(
      pool,
      OWNER_SUB,
      TO_NUMBER,
      '  security boundary hello  ',
    );

    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledOnce();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(pool, OWNER_SUB, 'twilio');
    expect(captured).toHaveLength(2);
    expect(captured.map(({ url }) => url)).toEqual([
      `${API_BASE}/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=1`,
      `${API_BASE}/Accounts/${ACCOUNT_SID}/Messages.json`,
    ]);

    const expectedAuthorization = `Basic ${Buffer.from(CONNECTOR_SECRET).toString('base64')}`;
    expect(captured[0].init.method).toBeUndefined();
    expect(Object.fromEntries(new Headers(captured[0].init.headers).entries())).toEqual({
      authorization: expectedAuthorization,
    });
    expect(captured[1].init.method).toBe('POST');
    expect(Object.fromEntries(new Headers(captured[1].init.headers).entries())).toEqual({
      authorization: expectedAuthorization,
      'content-type': 'application/x-www-form-urlencoded',
    });

    const form = new URLSearchParams(String(captured[1].init.body));
    expect(Object.fromEntries(form.entries())).toEqual({
      From: FROM_NUMBER,
      To: TO_NUMBER,
      Body: 'security boundary hello',
    });
    expect([...form.keys()].sort()).toEqual(['Body', 'From', 'To']);

    // The auth token may exist only in the Basic header; not in URLs, form data, result, or env.
    const nonAuthorizationRequestData = JSON.stringify({
      urls: captured.map(({ url }) => url),
      body: captured[1].init.body,
      contentType: new Headers(captured[1].init.headers).get('content-type'),
    });
    expect(nonAuthorizationRequestData).not.toContain(AUTH_TOKEN);
    expect(nonAuthorizationRequestData).not.toContain(CONNECTOR_SECRET);
    expect(result).toEqual({ delivered: true, id: MESSAGE_SID });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_SID);
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
    expect({ ...process.env }).toEqual(environmentBefore);
  });

  it('rejects an invalid destination before resolving a credential or calling Twilio', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendUserTwilioSms(
      pool,
      OWNER_SUB,
      '15557654321',
      'must not send',
    )).resolves.toEqual({ delivered: false, error: 'twilio_destination_invalid' });

    expect(tokenBroker.getValidAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['missing separator', `${ACCOUNT_SID}${AUTH_TOKEN}`],
    ['extra separator', `${ACCOUNT_SID}:${AUTH_TOKEN}:extra`],
    ['invalid account SID', `SK${'a'.repeat(32)}:${AUTH_TOKEN}`],
    ['short account SID', `AC${'a'.repeat(31)}:${AUTH_TOKEN}`],
    ['missing auth token', `${ACCOUNT_SID}:`],
    ['non-hex auth token', `${ACCOUNT_SID}:${'z'.repeat(32)}`],
    ['short auth token', `${ACCOUNT_SID}:${'b'.repeat(31)}`],
  ])('fails closed for a %s connector credential', async (_label, connectorSecret) => {
    tokenBroker.getValidAccessToken.mockResolvedValue(connectorSecret);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendUserTwilioSms(
      pool,
      OWNER_SUB,
      TO_NUMBER,
      'must not send',
    )).resolves.toEqual({ delivered: false, error: 'twilio_connection_unavailable' });

    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledOnce();
    expect(tokenBroker.getValidAccessToken).toHaveBeenCalledWith(pool, OWNER_SUB, 'twilio');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
