/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the messaging channels card (BACKLOG "Twilio policy, fallback, and inbound messaging"). The live step reads GET /api/channels with the initiating user's cookie and checks the surface can say, for that user, whether each inbound channel is wired on this deployment and which identities are bound to THEM. Read-only: it links nothing, unlinks nothing and sends nothing.
 *
 * @module routes/test-lab-channel-scenarios
 */

import type { Scenario, StepResult } from './test-lab-scenarios';

const APP = 'channels';
const LABEL = 'Inbound channel bindings';

/** The GET /api/channels payload, as far as this step needs to read it. */
interface ChannelsPayload {
  telegram?: { configured?: unknown };
  sms?: { configured?: unknown };
  links?: unknown;
}

/**
 * @description Live step: read the caller's own inbound-channel bindings and check the surface
 * reports a wired/not-wired state for both channels plus the caller's own linked identities.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; a missing session degrades, a missing channel block fails.
 */
async function bindingsStep(cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/channels`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) });
  if (response.status === 401) return result('degraded', 'Sign in to read your own channel bindings.', 401);
  if (response.status !== 200) return result('fail', `Channels returned HTTP ${response.status}.`, response.status);

  const payload = (await response.json()) as ChannelsPayload;
  const missing = (['telegram', 'sms'] as const).filter((channel) => typeof payload[channel]?.configured !== 'boolean');
  if (missing.length) return result('fail', `No wired/not-wired state reported for: ${missing.join(', ')}.`);
  if (!Array.isArray(payload.links)) return result('fail', 'The channels surface reports no linked-identity list.');

  const wired = (['telegram', 'sms'] as const).filter((channel) => payload[channel]?.configured === true);
  return result('pass', `Wired on this deployment: ${wired.length ? wired.join(' · ') : 'none'}. Identities linked to you: ${payload.links.length}. Read-only; nothing was linked or sent.`);
}

/** The messaging-channels Test Lab card: one read-only binding readback. */
export const CHANNEL_SCENARIOS: Scenario[] = [{
  id: 'channel-inbound-bindings', title: 'Messaging channels — what can reach your swarm', group: 'tool',
  description: 'Reads your own inbound channel bindings and checks the surface can say which channels this deployment has wired and which Telegram chats or phone numbers are bound to you. An identity nobody linked reaches no swarm. Read-only.',
  regressionTests: [
    { level: 'integration', path: 'tests/unit/sms-inbound-dispatch.spec.ts' },
    { level: 'unit', path: 'tests/unit/inbound-sms-webhook.spec.ts' },
    { level: 'unit', path: 'tests/unit/chat-channels-telegram.spec.ts' },
    { level: 'unit', path: 'tests/unit/notification-policy.spec.ts' },
    { level: 'unit', path: 'tests/unit/notification-prefs-router.spec.ts' },
    { level: 'unit', path: 'tests/unit/test-lab-channel-registration.spec.ts' },
  ],
  steps: [{ id: 'bindings', app: APP, label: LABEL, run: bindingsStep }],
}];
