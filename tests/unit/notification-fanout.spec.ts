/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | notifyAll fan-out + configuredTransportKinds tests: fans across the configured set, honors an explicit kind list (skipping unconfigured), dedupes, never throws, and reports a skipped noop when nothing is configured.
 */

import { describe, expect, it } from 'vitest';
import { notifyAll, configuredTransportKinds } from '../../src/features/notifications';

/** A fetch that always succeeds with a canned id, so any configured transport "delivers". */
const okFetch = (async () => ({ ok: true, status: 200, json: async () => ({ sid: 'X1', ok: true, result: { message_id: 1 } }) })) as unknown as typeof fetch;

/** Env with Telegram + Twilio SMS + WhatsApp all configured (voice needs no extra keys beyond Twilio). */
const MULTI_ENV = {
  TELEGRAM_BOT_TOKEN: 'BOTFAKE:z',
  TELEGRAM_CHAT_ID: '999',
  TWILIO_ACCOUNT_SID: 'ACfake',
  TWILIO_AUTH_TOKEN: 'authfake',
  TWILIO_FROM_NUMBER: '+15550000000',
  TWILIO_TO_NUMBER: '+15551111111',
  TWILIO_WHATSAPP_FROM: '+14155238886',
  TWILIO_WHATSAPP_TO: '+15552222222',
} as NodeJS.ProcessEnv;

describe('configuredTransportKinds', () => {
  it('returns nothing when no channel is configured', () => {
    expect(configuredTransportKinds({ env: {} as NodeJS.ProcessEnv })).toEqual([]);
  });

  it('lists every configured non-noop transport', () => {
    const kinds = configuredTransportKinds({ env: MULTI_ENV, fetch: okFetch });
    expect(kinds).toEqual(expect.arrayContaining(['telegram', 'twilio-sms', 'twilio-voice', 'twilio-whatsapp']));
    expect(kinds).not.toContain('noop');
  });
});

describe('notifyAll', () => {
  it('fans across all configured transports and reports one result each', async () => {
    const results = await notifyAll({ text: 'ALERT' }, { deps: { env: MULTI_ENV, fetch: okFetch } });
    const transports = results.map((r) => r.transport).sort();
    expect(transports).toEqual(['telegram', 'twilio-sms', 'twilio-voice', 'twilio-whatsapp']);
    expect(results.every((r) => r.delivered)).toBe(true);
  });

  it('honors an explicit kind list and de-duplicates it', async () => {
    const results = await notifyAll({ text: 'x' }, { kinds: ['twilio-sms', 'twilio-sms', 'twilio-whatsapp'], deps: { env: MULTI_ENV, fetch: okFetch } });
    expect(results.map((r) => r.transport).sort()).toEqual(['twilio-sms', 'twilio-whatsapp']);
  });

  it('returns a skipped (not error) result for an explicitly requested but unconfigured transport', async () => {
    const results = await notifyAll({ text: 'x' }, { kinds: ['twilio-voice'], deps: { env: {} as NodeJS.ProcessEnv } });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ delivered: false, skipped: true, transport: 'twilio-voice' });
  });

  it('returns a single skipped noop result when nothing is configured', async () => {
    const results = await notifyAll({ text: 'x' }, { deps: { env: {} as NodeJS.ProcessEnv } });
    expect(results).toEqual([{ delivered: false, skipped: true, transport: 'noop', error: 'no_transport_configured' }]);
  });

  it('never throws even if a transport errors (one bad channel does not sink the fan-out)', async () => {
    const badFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const results = await notifyAll({ text: 'x' }, { kinds: ['twilio-sms', 'twilio-whatsapp'], deps: { env: MULTI_ENV, fetch: badFetch } });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.delivered === false)).toBe(true);
  });
});
