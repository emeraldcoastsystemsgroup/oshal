/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the severity → transport policy: the default map routes each level to the intended transports, NOTIFY_POLICY_<LEVEL> overrides + drops unknown kinds, transportsForSeverity intersects the policy with the CONFIGURED transports (an unconfigured leg is dropped, not attempted), and notifyBySeverity fans across the configured set (email included when its rail is injected) and degrades to a single skipped noop when the level maps to nothing configured.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEVERITY_POLICY,
  notifyBySeverity,
  severityPolicyFromEnv,
  transportsForSeverity,
  type EmailTransportRail,
} from '../../src/features/notifications';

/** A fetch that always succeeds so any configured env transport "delivers". */
const okFetch = (async () => ({ ok: true, status: 200, json: async () => ({ sid: 'X1', ok: true, result: { message_id: 1 } }) })) as unknown as typeof fetch;

/** Telegram + Twilio SMS/voice configured via env (no email — email needs an injected rail). */
const MULTI_ENV = {
  TELEGRAM_BOT_TOKEN: 'BOTFAKE:z',
  TELEGRAM_CHAT_ID: '999',
  TWILIO_ACCOUNT_SID: 'ACfake',
  TWILIO_AUTH_TOKEN: 'authfake',
  TWILIO_FROM_NUMBER: '+15550000000',
  TWILIO_TO_NUMBER: '+15551111111',
} as NodeJS.ProcessEnv;

/** Only Telegram configured. */
const TELEGRAM_ONLY = { TELEGRAM_BOT_TOKEN: 'BOTFAKE:z', TELEGRAM_CHAT_ID: '999' } as NodeJS.ProcessEnv;

/** A mock email rail that always resolves a token + a message id (records the handoff). */
function fakeEmailRail(): EmailTransportRail & { sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  return {
    to: 'ops@example.test',
    sent,
    async getAccessToken() { return 'tok-fake'; },
    async sendEmail(_token, m) { sent.push(m); return { id: 'EM-1' }; },
  };
}

describe('severity policy — mapping (config-independent)', () => {
  it('routes each level to the intended default transports (low → high escalation)', () => {
    const raw = (sev: Parameters<typeof transportsForSeverity>[0]) => transportsForSeverity(sev, { onlyConfigured: false });
    expect(raw('info')).toEqual(['telegram']);
    expect(raw('warn')).toEqual(['telegram', 'email']);
    expect(raw('error')).toEqual(['telegram', 'email', 'twilio-sms']);
    expect(raw('critical')).toEqual(['telegram', 'email', 'twilio-sms', 'twilio-voice']);
  });

  it('DEFAULT_SEVERITY_POLICY escalates monotonically (each level a superset of the last)', () => {
    const p = DEFAULT_SEVERITY_POLICY;
    expect(new Set(p.info).size).toBeLessThanOrEqual(new Set(p.warn).size);
    expect(p.critical).toEqual(expect.arrayContaining(p.error));
    expect(p.error).toEqual(expect.arrayContaining(p.warn));
  });

  it('NOTIFY_POLICY_<LEVEL> overrides a level and drops unknown transport kinds', () => {
    const env = { NOTIFY_POLICY_INFO: 'email, twilio-sms, pigeon', NOTIFY_POLICY_WARN: '' } as NodeJS.ProcessEnv;
    const policy = severityPolicyFromEnv(env);
    expect(policy.info).toEqual(['email', 'twilio-sms']); // 'pigeon' dropped
    expect(policy.warn).toEqual([]);                       // explicit mute
    expect(policy.error).toEqual(DEFAULT_SEVERITY_POLICY.error); // untouched
  });
});

describe('transportsForSeverity — policy ∩ configured', () => {
  it('drops legs whose transport is not configured', () => {
    // critical wants telegram+email+twilio-sms+twilio-voice; only telegram env is set + no email rail.
    expect(transportsForSeverity('critical', { deps: { env: TELEGRAM_ONLY, fetch: okFetch } })).toEqual(['telegram']);
  });

  it('includes email only when its rail is injected', () => {
    const withEmail = transportsForSeverity('error', { deps: { env: TELEGRAM_ONLY, fetch: okFetch, email: fakeEmailRail() } });
    expect(withEmail).toEqual(['telegram', 'email']); // twilio-sms env absent → dropped
  });

  it('keeps every configured leg for critical when the env has them', () => {
    const kinds = transportsForSeverity('critical', { deps: { env: MULTI_ENV, fetch: okFetch } });
    expect(kinds).toEqual(['telegram', 'twilio-sms', 'twilio-voice']); // email absent (no rail)
  });
});

describe('notifyBySeverity — resolve → fan-out', () => {
  it('fans across the configured transports for the level and reports one result each', async () => {
    const results = await notifyBySeverity('critical', { text: 'DB down' }, { deps: { env: MULTI_ENV, fetch: okFetch } });
    expect(results.map((r) => r.transport).sort()).toEqual(['telegram', 'twilio-sms', 'twilio-voice']);
    expect(results.every((r) => r.delivered)).toBe(true);
  });

  it('delivers email over the injected rail when the level includes it', async () => {
    const rail = fakeEmailRail();
    const results = await notifyBySeverity('error', { text: 'quota exceeded' }, { deps: { env: TELEGRAM_ONLY, fetch: okFetch, email: rail } });
    const email = results.find((r) => r.transport === 'email');
    expect(email).toMatchObject({ delivered: true, id: 'EM-1' });
    expect(rail.sent).toHaveLength(1);
    expect(rail.sent[0]).toMatchObject({ to: 'ops@example.test', subject: 'quota exceeded' });
  });

  it('degrades to a single skipped noop when the level maps to nothing configured', async () => {
    const results = await notifyBySeverity('info', { text: 'x' }, { deps: { env: {} as NodeJS.ProcessEnv } });
    expect(results).toEqual([{ delivered: false, skipped: true, transport: 'noop', error: 'no_transport_for_severity' }]);
  });

  it('never throws even when a configured transport errors mid-fan-out', async () => {
    const badFetch = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const results = await notifyBySeverity('error', { text: 'x' }, { deps: { env: MULTI_ENV, fetch: badFetch } });
    expect(results.every((r) => r.delivered === false)).toBe(true);
  });
});
