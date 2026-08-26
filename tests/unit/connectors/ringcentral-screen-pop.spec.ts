/**
 * RingCentral screen-pop runtime guards (docs/connectors/ringcentral-screen-pop-spec.md).
 *
 * Pins the two halves that would fail silently if regressed: the OAuth registry entry
 * (PKCE + Basic + deliberately empty scopes + exact creds env), and the pure presence
 * parser (inbound Ringing ONLY — an outbound call or a held call reaching the browser is
 * a privacy defect, not a cosmetic one). No network, no credentials.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Registry-entry shape, credential env resolution, redirect override, parser inbound-Ringing filter + malformed-frame safety + minimal-field payload, and subscription-ack recognition.
 *
 * @module tests/unit/connectors/ringcentral-screen-pop
 */
import { describe, it, expect } from 'vitest';
import { PROVIDERS, providerCreds } from '@/app/routes/connector-provider-registry';
import { redirectUri } from '@/app/routes/connector-oauth-ceremony';
import { parsePresenceFrames, isSubscriptionAck } from '@/app/routes/ringcentral-screen-pop';

describe('ringcentral OAuth registry entry', () => {
  const def = PROVIDERS.ringcentral;

  it('exists with the RingCentral production endpoints', () => {
    expect(def).toBeTruthy();
    expect(def.authUrl).toBe('https://platform.ringcentral.com/restapi/oauth/authorize');
    expect(def.tokenUrl).toBe('https://platform.ringcentral.com/restapi/oauth/token');
    expect(def.revokeUrl).toBe('https://platform.ringcentral.com/restapi/oauth/revoke');
  });

  it('uses PKCE with Basic token auth and NO scope param (app registration governs)', () => {
    expect(def.pkce).toBe(true);
    expect(def.tokenAuth).toBe('basic');
    // Empty scopes → the start route omits scope= entirely; RingCentral rejects
    // scope values the app registration does not declare.
    expect(def.scopes).toEqual([]);
    expect(def.auth ?? 'oauth').toBe('oauth');
  });

  it('resolves credentials from RINGCENTRAL_CLIENT_ID/SECRET and honors the redirect override', () => {
    const prev = { ...process.env };
    try {
      process.env.RINGCENTRAL_CLIENT_ID = 'cid-test';
      process.env.RINGCENTRAL_CLIENT_SECRET = 'sec-test';
      process.env.RINGCENTRAL_REDIRECT_URI = 'https://gsquared.oshal.ai/api/connect/ringcentral/callback';
      expect(providerCreds('ringcentral')).toEqual({ clientId: 'cid-test', clientSecret: 'sec-test' });
      expect(redirectUri('ringcentral')).toBe('https://gsquared.oshal.ai/api/connect/ringcentral/callback');
      delete process.env.RINGCENTRAL_REDIRECT_URI;
      expect(redirectUri('ringcentral')).toMatch(/\/api\/connect\/ringcentral\/callback$/);
    } finally {
      process.env.RINGCENTRAL_CLIENT_ID = prev.RINGCENTRAL_CLIENT_ID;
      process.env.RINGCENTRAL_CLIENT_SECRET = prev.RINGCENTRAL_CLIENT_SECRET;
      process.env.RINGCENTRAL_REDIRECT_URI = prev.RINGCENTRAL_REDIRECT_URI;
    }
  });
});

const ringingFrame = (calls: unknown[]) => JSON.stringify([
  { type: 'ServerNotification', messageId: 'n1' },
  { event: '/restapi/v1.0/account/1/extension/22/presence?detailedTelephonyState=true', body: { extensionId: 22, sequence: 7, activeCalls: calls } },
]);

describe('parsePresenceFrames', () => {
  it('emits only inbound Ringing calls with the minimal screen-pop fields', () => {
    const raw = ringingFrame([
      { direction: 'Inbound', telephonyStatus: 'Ringing', telephonySessionId: 's-1', from: '+15552001000', fromName: 'Mike', queueCall: false, startTime: '2026-08-25T20:15:30.000Z', to: '+15550009999', secretField: 'x' },
      { direction: 'Outbound', telephonyStatus: 'Ringing', telephonySessionId: 's-2', from: '+15550001111' },
      { direction: 'Inbound', telephonyStatus: 'CallConnected', telephonySessionId: 's-3', from: '+15550002222' },
    ]);
    const events = parsePresenceFrames(raw);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.telephonySessionId).toBe('s-1');
    expect(evt.from).toBe('+15552001000');
    expect(evt.fromName).toBe('Mike');
    expect(evt.extensionId).toBe('22');
    expect(evt.queueCall).toBe(false);
    expect(evt.startedAt).toBe('2026-08-25T20:15:30.000Z');
    // Only the contracted fields leave the parser — nothing else from the provider frame.
    expect(Object.keys(evt).sort()).toEqual(
      ['extensionId', 'from', 'fromName', 'queueCall', 'receivedAt', 'startedAt', 'telephonySessionId', 'type'],
    );
  });

  it('is fail-quiet on malformed, non-notification, and callerless frames', () => {
    expect(parsePresenceFrames('not json')).toEqual([]);
    expect(parsePresenceFrames('{"type":"Heartbeat"}')).toEqual([]);
    expect(parsePresenceFrames(JSON.stringify([{ type: 'ConnectionDetails' }, { recoveryState: 'Successful' }]))).toEqual([]);
    expect(parsePresenceFrames(ringingFrame([
      { direction: 'Inbound', telephonyStatus: 'Ringing', telephonySessionId: 's-4', from: '   ' },
      { direction: 'Inbound', telephonyStatus: 'Ringing', from: '+15550003333' },
    ]))).toEqual([]);
  });

  it('supports queue calls offered to the extension', () => {
    const events = parsePresenceFrames(ringingFrame([
      { direction: 'Inbound', telephonyStatus: 'Ringing', telephonySessionId: 's-5', from: '+15550004444', queueCall: true },
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].queueCall).toBe(true);
  });
});

describe('isSubscriptionAck', () => {
  it('acknowledges only a 2xx reply to OUR messageId', () => {
    const ok = JSON.stringify([{ type: 'ClientRequest', messageId: 'sub-abc', status: 200 }, { id: 'x' }]);
    const wrongId = JSON.stringify([{ type: 'ClientRequest', messageId: 'sub-zzz', status: 200 }, {}]);
    const failed = JSON.stringify([{ type: 'ClientRequest', messageId: 'sub-abc', status: 403 }, {}]);
    expect(isSubscriptionAck(ok, 'sub-abc')).toBe(true);
    expect(isSubscriptionAck(wrongId, 'sub-abc')).toBe(false);
    expect(isSubscriptionAck(failed, 'sub-abc')).toBe(false);
    expect(isSubscriptionAck('garbage', 'sub-abc')).toBe(false);
  });
});
