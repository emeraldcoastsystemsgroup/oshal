/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the messaging channels card (BACKLOG "Twilio policy, fallback, and inbound messaging"). The live step reads GET /api/channels with the initiating user's cookie and checks the surface can say, for that user, whether each inbound channel is wired on this deployment and which identities are bound to THEM. Read-only: it links nothing, unlinks nothing and sends nothing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Chat-channel adapter core": the bindings step also requires the discord and whatsapp wired state, and a second card runs one executable inbound round trip per provider (Telegram, Discord, SMS, WhatsApp) through the real identity store, processors and refusal ledger with only the bot turn and provider send doubled. The Discord, WhatsApp, denial-audit and real-Postgres inbound suites are registered.
 *
 * @module routes/test-lab-channel-scenarios
 */

import type { Scenario, StepResult } from './test-lab-scenarios';
import { runChannelRoundTrip, type LabChannelProvider } from './test-lab-channel-round-trip';

const APP = 'channels';
const LABEL = 'Inbound channel bindings';

/** The GET /api/channels payload, as far as this step needs to read it. */
interface ChannelsPayload {
  telegram?: { configured?: unknown };
  sms?: { configured?: unknown };
  whatsapp?: { configured?: unknown };
  discord?: { configured?: unknown };
  links?: unknown;
}

/** Every channel the surface must report a wired/not-wired state for. */
const CHANNELS = ['telegram', 'sms', 'whatsapp', 'discord'] as const;

/**
 * @description Live step: read the caller's own inbound-channel bindings and check the surface
 * reports a wired/not-wired state for every channel plus the caller's own linked identities.
 * @param cookie - The initiating user's session cookie.
 * @returns The step result; a missing session degrades, a missing channel block fails.
 */
async function bindingsStep(cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, status?: number): StepResult => ({ app: APP, label: LABEL, state, detail, ...(status ? { status } : {}) });
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '5000'}/api/channels`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30_000) });
  if (response.status === 401) return result('degraded', 'Sign in to read your own channel bindings.', 401);
  if (response.status !== 200) return result('fail', `Channels returned HTTP ${response.status}.`, response.status);

  const payload = (await response.json()) as ChannelsPayload;
  const missing = CHANNELS.filter((channel) => typeof payload[channel]?.configured !== 'boolean');
  if (missing.length) return result('fail', `No wired/not-wired state reported for: ${missing.join(', ')}.`);
  if (!Array.isArray(payload.links)) return result('fail', 'The channels surface reports no linked-identity list.');

  const wired = CHANNELS.filter((channel) => payload[channel]?.configured === true);
  return result('pass', `Wired on this deployment: ${wired.length ? wired.join(' · ') : 'none'}. Identities linked to you: ${payload.links.length}. Read-only; nothing was linked or sent.`);
}

/** The suites that guard the inbound channels, shared by both cards. */
const CHANNEL_REGRESSION_TESTS: NonNullable<Scenario['regressionTests']> = [
  { level: 'integration', path: 'tests/unit/sms-inbound-dispatch.spec.ts' },
  { level: 'integration', path: 'tests/unit/chat-channel-inbound-postgres.spec.ts' },
  { level: 'integration', path: 'tests/unit/chat-channel-denial-audit.spec.ts' },
  { level: 'unit', path: 'tests/unit/inbound-sms-webhook.spec.ts' },
  { level: 'unit', path: 'tests/unit/chat-channels-telegram.spec.ts' },
  { level: 'unit', path: 'tests/unit/chat-channels-discord.spec.ts' },
  { level: 'unit', path: 'tests/unit/chat-channels-whatsapp.spec.ts' },
  { level: 'unit', path: 'tests/unit/twilio-sms-operation-security.spec.ts' },
  { level: 'unit', path: 'tests/unit/notification-policy.spec.ts' },
  { level: 'unit', path: 'tests/unit/notification-prefs-router.spec.ts' },
  { level: 'unit', path: 'tests/unit/test-lab-channel-registration.spec.ts' },
];

/** One round-trip step per provider, each run as the initiating user. */
const ROUND_TRIP_PROVIDERS: LabChannelProvider[] = ['telegram', 'discord', 'sms', 'whatsapp'];

/** The messaging-channels Test Lab cards: the read-only binding readback and the per-provider round trip. */
export const CHANNEL_SCENARIOS: Scenario[] = [{
  id: 'channel-inbound-bindings', title: 'Messaging channels — what can reach your swarm', group: 'tool',
  description: 'Reads your own inbound channel bindings and checks the surface can say which channels this deployment has wired (Telegram, SMS, WhatsApp, Discord) and which chats, numbers or accounts are bound to you. An identity nobody linked reaches no swarm. Read-only.',
  regressionTests: CHANNEL_REGRESSION_TESTS,
  steps: [{ id: 'bindings', app: APP, label: LABEL, run: bindingsStep }],
}, {
  id: 'channel-inbound-round-trip', title: 'Messaging channels — one message in, one answer out, strangers refused', group: 'tool',
  description: 'For Telegram, Discord, SMS and WhatsApp: links a lab identity to you with a fresh code, sends one message twice, and sends one from an identity nobody linked. Passes when exactly one bot turn ran as you, its answer came back, the duplicate was refused, and the stranger was refused with a committed refusal-ledger row. The bot turn and the provider send are doubled, so nothing is spent and no real account is messaged; the lab link is removed afterwards.',
  regressionTests: CHANNEL_REGRESSION_TESTS,
  steps: ROUND_TRIP_PROVIDERS.map((provider) => ({
    id: `round-trip-${provider}`, app: APP, label: `${provider} inbound round trip`,
    run: (_cookie: string, _prior: Record<string, unknown>, runtime?: Parameters<typeof runChannelRoundTrip>[1]) => runChannelRoundTrip(provider, runtime),
  })),
}];
