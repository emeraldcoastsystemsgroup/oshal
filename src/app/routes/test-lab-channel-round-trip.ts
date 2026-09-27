/**
 * AI Test Lab — executable inbound round trip for each chat channel (Telegram, Discord, SMS, WhatsApp).
 *
 * Each step runs as the initiating user through the SAME production pieces an inbound message
 * uses: the real ChannelLinkService over the app pool (owner RLS applies), the provider's real
 * inbound processor, and the real refusal ledger. Only the two things a Lab run must never do for
 * real are doubled: the accountable bot turn (it would spend on the user's model) and the provider
 * send (it would message a real account). The step:
 *   1. mints a link code as the caller,
 *   2. redeems it from a synthetic, lab-prefixed channel identity,
 *   3. sends one message from that identity twice with the same occurrence id,
 *   4. sends one message from a second, never-linked synthetic identity,
 *   5. checks exactly one bot turn ran, for the caller, under the caller's non-operator identity,
 *      the duplicate was refused, and the stranger was refused with a COMMITTED ledger row,
 *   6. unlinks the lab identity. The occurrence claims and the refusal row are permanent receipts
 *      by design (migration 166 grants the runtime role SELECT/INSERT only on the claims), so they
 *      stay; they carry only a random occurrence id, the caller's sub and a hashed actor.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — one deterministic, self-unlinking inbound round-trip step per chat provider (link, owner-bound single dispatch, duplicate refused, stranger refused and audited) over the real identity store, processors and refusal ledger, with only the bot turn and provider send doubled.
 *
 * @module routes/test-lab-channel-round-trip
 */

import { randomInt, randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  ChannelLinkService,
  recordChannelRefusal,
  type ChannelRefusalInput,
} from '@/features/chat-channels';
import type { ScenarioRunContext, StepResult } from './test-lab-scenarios';
import { processDiscordInbound, processTelegramInbound } from './chat-channel-routes';
import { createSmsInboundSink } from './sms-inbound-dispatch';

const logger = createChildLogger({ module: 'test-lab-channel-round-trip' });
const APP = 'channels';

/** The providers a round-trip step exists for. */
export type LabChannelProvider = 'telegram' | 'discord' | 'sms' | 'whatsapp';

/** What one round trip observed through its doubles. */
interface RoundTripProbe {
  turns: Array<{ ownerSub: string; ambientSub: string | null | undefined; ambientOperator: boolean | undefined }>;
  replies: string[];
  refusals: Array<{ reason: ChannelRefusalInput['reason']; committed: boolean }>;
}

/** A synthetic identity that can never be a real account: lab-prefixed ids, fictional 555-01xx numbers. */
function labIdentity(provider: LabChannelProvider): string {
  if (provider === 'sms' || provider === 'whatsapp') return `+1202555${String(100 + randomInt(0, 100)).padStart(4, '0')}`;
  return `testlab-${randomUUID()}`;
}

/** Deliver one message from `identity` through the provider's real inbound processor. */
async function deliver(
  provider: LabChannelProvider, links: ChannelLinkService, probe: RoundTripProbe,
  identity: string, text: string, eventId: string,
): Promise<void> {
  const audit = async (input: ChannelRefusalInput): Promise<boolean> => {
    const committed = await recordChannelRefusal(input);
    probe.refusals.push({ reason: input.reason, committed });
    return committed;
  };
  const turn = async (ownerSub: string): Promise<string> => {
    const ambient = getRequestIdentity();
    probe.turns.push({ ownerSub, ambientSub: ambient?.sub, ambientOperator: ambient?.isOperator });
    return 'lab answer';
  };
  const send = async (_chat: string, reply: string): Promise<void> => { probe.replies.push(reply); };
  if (provider === 'telegram') {
    await processTelegramInbound(links, { provider, eventId, channelUserId: identity, chatId: identity, text, displayName: 'Test Lab' },
      turn, send, { audit });
    return;
  }
  if (provider === 'discord') {
    await processDiscordInbound(links, { provider, eventId, channelUserId: identity, channelId: identity, text, displayName: 'Test Lab' },
      turn, send, { audit });
    return;
  }
  const deferred: Promise<void>[] = [];
  const sink = createSmsInboundSink({ links, dispatch: turn, reply: async (_s, to, body) => { await send(to, body); return { delivered: true }; },
    audit, defer: (work) => { deferred.push(work); } });
  const prefix = provider === 'whatsapp' ? 'whatsapp:' : '';
  const twiml = await sink({ messageSid: eventId, accountSid: null, from: `${prefix}${identity}`, to: `${prefix}+12025550100`,
    body: text, numMedia: 0, mediaUrls: [], receivedAt: new Date().toISOString() });
  if (twiml) probe.replies.push(twiml);
  await Promise.all(deferred);
}

/** Judge what the doubles saw against the round-trip contract; null means it held. */
function verdict(probe: RoundTripProbe, ownerSub: string): string | null {
  if (probe.turns.length !== 1) return `expected exactly one bot turn (the duplicate refused), saw ${probe.turns.length}.`;
  const [turn] = probe.turns;
  if (turn.ownerSub !== ownerSub || turn.ambientSub !== ownerSub || turn.ambientOperator !== false) {
    return 'the bot turn did not run for you under your own non-operator identity.';
  }
  if (!probe.replies.includes('lab answer')) return 'the answer never came back on the channel.';
  const refused = probe.refusals.filter((r) => r.reason === 'unlinked_identity');
  if (probe.refusals.length !== 1 || refused.length !== 1) return `expected one refusal (the stranger), saw ${probe.refusals.length}.`;
  if (!refused[0].committed) return 'the stranger was refused but the refusal ledger did not commit a row.';
  return null;
}

/**
 * @description One executable inbound round trip for a chat provider, as the initiating user.
 * @param provider - The channel to exercise.
 * @param runtime - Server-derived Lab context (app pool + the caller's sub); absent means degraded.
 * @returns pass when link, single owner-bound turn, duplicate refusal and audited stranger refusal all held.
 */
export async function runChannelRoundTrip(provider: LabChannelProvider, runtime?: ScenarioRunContext): Promise<StepResult> {
  const label = `${provider} inbound round trip (bot turn and provider send doubled)`;
  const result = (state: StepResult['state'], detail: string): StepResult => ({ app: APP, label, state, detail });
  if (!runtime?.ownerSub || !runtime.ctx?.pool) return result('degraded', 'A signed-in caller and the app database are required; nothing was linked.');
  const owner = runtime.ownerSub;
  const links = new ChannelLinkService(runtime.ctx.pool as never);
  const probe: RoundTripProbe = { turns: [], replies: [], refusals: [] };
  const linked = labIdentity(provider);
  let stranger = labIdentity(provider);
  while (stranger === linked) stranger = labIdentity(provider);
  const run = randomUUID().replace(/-/g, '');
  try {
    const code = await runWithRequestIdentity({ sub: owner, isOperator: false }, () => links.mintLinkCode(owner, provider));
    await deliver(provider, links, probe, linked, provider === 'telegram' ? `/start ${code}` : `LINK ${code}`, `testlab-${run}-link`);
    await deliver(provider, links, probe, linked, 'Test Lab round trip', `testlab-${run}-ask`);
    await deliver(provider, links, probe, linked, 'Test Lab round trip', `testlab-${run}-ask`);
    await deliver(provider, links, probe, stranger, 'Test Lab round trip', `testlab-${run}-stranger`);
    const problem = verdict(probe, owner);
    return problem ? result('fail', `${provider}: ${problem}`)
      : result('pass', `${provider}: a lab identity linked to you, one bot turn ran as you and its answer came back, the duplicate was refused, and a never-linked identity was refused with a committed refusal-ledger row. The lab link was removed.`);
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, provider }, 'channel round-trip Lab step failed');
    return result('fail', `${provider}: step threw: ${(err as Error).message}`);
  } finally {
    await runWithRequestIdentity({ sub: owner, isOperator: false }, () => links.unlink(owner, provider, linked))
      .catch((err) => logger.error({ err, stack: (err as Error).stack, provider }, 'channel round-trip Lab cleanup failed'));
  }
}
