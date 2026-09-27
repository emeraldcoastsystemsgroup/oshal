/**
 * Inbound SMS dispatch — the caller-scoped sink behind POST /api/sms/inbound.
 *
 * The webhook route owns authenticity (Twilio signature) and normalization; this module owns the
 * one thing that makes an inbound text useful: resolving WHOSE it is and running it on THAT user's
 * accountable bot. It is the SMS counterpart of chat-channel-routes' Telegram handler and reuses
 * the same identity store (`channel_links`, provider 'sms'), so the isolation property is the same
 * one already proven for Telegram — an unlinked number resolves to nobody, gets linking guidance,
 * and never reaches a swarm.
 *
 * IDENTITY: the webhook request is unauthenticated, so the ambient AsyncLocalStorage identity is
 * anonymous. The link lookup runs as trusted-system inside ChannelLinkService (it is what tells us
 * the owner), and everything after it — the swarm turn and the reply send — runs inside
 * `runWithRequestIdentity({ sub, principalIssuer, isOperator: false })` for the resolved owner, with
 * the verified issuer recorded on the link, never operator. A legacy link with no recorded issuer
 * is refused with a re-link instruction instead of dispatching.
 *
 * TIMING: a swarm turn can outlast Twilio's ~15 s webhook budget, and a timed-out webhook is
 * RETRIED — which would dispatch the same message twice. So a real dispatch is deferred: the route
 * answers immediately with empty TwiML and the answer comes back out of band through the per-user
 * Twilio operation. The fast paths (link handshake, unlinked guidance) need no credential and no
 * bot, so they answer synchronously in the TwiML response instead.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — createSmsInboundSink: normalize the sender, redeem a LINK <code> handshake, refuse+guide an unlinked number, and dispatch a linked number's message to the accountable Jarvis bot under the OWNER's identity with the reply returned out of band. Injected link store / dispatch / reply / defer so the whole path is testable against a real Postgres without a bot node or Twilio.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Denial audit + WhatsApp reply sender. An unlinked sender, a refused link code and a refused cross-user rebind are now recorded in the refusal ledger (injectable `audit`, default recordChannelRefusal) for SMS and WhatsApp alike, and a rebind attempt gets its own reply instead of 'invalid code'. The reply leg now carries the address the user messaged (the inbound To), so a WhatsApp answer can leave from the WhatsApp sender the user wrote to instead of the owner's first SMS number.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The owner turn carries the link's verified principal issuer: runOwnerTurn entered { sub, isOperator: false } only, so user-bound delegation refused every linked SMS/WhatsApp turn whenever delegation signing was on ("User-bound delegation requires a verified principal issuer") and the texter got the generic failure. It now enters { sub, principalIssuer } from the link. A legacy link with no recorded issuer is refused synchronously before any occurrence claim or dispatch, audited as link_issuer_missing, and answered with SMS_RELINK_REPLY.
 *
 * @module sms-inbound-dispatch
 */

import { createChildLogger } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  boundSmsReply,
  parseTwilioChannelAddress,
  parseSmsLinkCommand,
  recordChannelRefusal,
  redeemChannelCode,
  type ChannelLinkRedeemer,
  type ChannelRefusalRecorder,
  type TwilioChannelProvider,
} from '@/features/chat-channels';
import type { InboundSms } from '@/features/notifications';

const logger = createChildLogger({ module: 'sms-inbound-dispatch' });

/** What the texter sees when their number is not bound to an account yet. */
export const SMS_UNLINKED_REPLY =
  'This number is not connected to an oshal account. Open your cockpit, go to Channels, connect SMS, and text back LINK followed by the code you are given.';

/** What the texter sees after a successful binding. */
export const SMS_LINKED_REPLY =
  'Connected. You can now text your swarm from this number — ask it anything your apps can do.';

/** What the texter sees when the code is unknown, expired, or already used. */
export const SMS_LINK_FAILED_REPLY =
  'That link code is invalid or expired. Generate a fresh one in your cockpit under Channels.';

/** What the texter sees when the number was linked before its sign-in issuer was recorded. */
export const SMS_RELINK_REPLY =
  'This number was connected before oshal recorded which sign-in it belongs to, so it cannot reach your swarm. Re-link it: open your cockpit, go to Channels, connect again, and text back LINK followed by the new code.';

/** What the texter sees when the number is already bound to a different account. */
export const SMS_REBIND_REFUSED_REPLY =
  'This number is already connected to a different oshal account. Unlink it from that account first, then text a fresh code.';

/** The subset of ChannelLinkService this sink uses; injected so a spec can supply the real one. */
export interface SmsChannelLinkPort extends ChannelLinkRedeemer {
  resolveLink(provider: string, channelUserId: string): Promise<{ userSub: string; userIssuer: string | null } | null>;
  claimInboundMessage(userSub: string, provider: string, eventId: string): Promise<boolean>;
}

/** Everything the sink needs from the app layer, injected so none of it is imported here. */
export interface SmsInboundSinkDeps {
  /** The channel identity store (ChannelLinkService satisfies this structurally). */
  links: SmsChannelLinkPort;
  /** Runs one message on the owner's accountable bot. Called INSIDE the owner's identity. */
  dispatch(userSub: string, threadKey: string, text: string): Promise<string>;
  /**
   * Sends the out-of-band answer back to the texter. Called INSIDE the owner's identity. `sender`
   * is the E.164 address the user messaged (the inbound To), when Twilio supplied a usable one.
   */
  reply(
    userSub: string, to: string, body: string, provider?: TwilioChannelProvider, sender?: string,
  ): Promise<{ delivered: boolean; error?: string }>;
  /** Records a refused inbound message (the platform refusal ledger by default). */
  audit?: ChannelRefusalRecorder;
  /**
   * How deferred work is scheduled. Production fires and forgets so the webhook answers inside
   * Twilio's budget; a spec collects the promise and awaits it instead of racing a timer.
   */
  defer?(work: Promise<void>): void;
}

/** The sink shape the inbound route accepts: a returned string becomes a TwiML reply. */
export type SmsInboundSink = (sms: InboundSms) => Promise<string | void>;

/** Fire-and-forget: the webhook has already answered, so a failure is logged, never surfaced. */
function defaultDefer(work: Promise<void>): void {
  void work.catch((err) => logger.error({ err, stack: (err as Error).stack }, 'deferred inbound SMS work failed'));
}

/**
 * @description Build the caller-scoped inbound-SMS sink for POST /api/sms/inbound. Resolves the
 * sender's number to its linked owner and runs the message on that owner's accountable bot;
 * handles the `LINK <code>` binding handshake; refuses (and explains itself to) an unlinked
 * number without dispatching anything.
 * @param deps - The link store, the bot dispatch, the reply send, and the defer strategy.
 * @returns A sink for `createSmsInboundRoutes({ onInboundSms })`; a returned string is TwiML-replied.
 */
export function createSmsInboundSink(deps: SmsInboundSinkDeps): SmsInboundSink {
  const defer = deps.defer ?? defaultDefer;

  return async function onInboundSms(sms: InboundSms): Promise<string | void> {
    const address = parseTwilioChannelAddress(sms.from);
    const from = address?.number;
    if (!address || !from) {
      logger.warn({ messageSid: sms.messageSid }, 'inbound SMS refused: sender is not a usable E.164 identity');
      return undefined;
    }

    const code = parseSmsLinkCommand(sms.body);
    if (code) return handleLink(deps, sms, from, address.provider);

    const link = await deps.links.resolveLink(address.provider, from);
    if (!link?.userSub) {
      logger.warn({ messageSid: sms.messageSid, provider: address.provider },
        'inbound Twilio channel message from an unlinked number — refused, no swarm dispatch');
      await (deps.audit ?? recordChannelRefusal)({
        provider: address.provider, channelUserId: from, reason: 'unlinked_identity', eventId: sms.messageSid });
      return SMS_UNLINKED_REPLY;
    }

    const userSub = link.userSub;
    if (!link.userIssuer) {
      logger.warn({ messageSid: sms.messageSid, provider: address.provider },
        'linked Twilio channel number has no verified issuer - refused, re-link required');
      await (deps.audit ?? recordChannelRefusal)({
        provider: address.provider, channelUserId: from, reason: 'link_issuer_missing', eventId: sms.messageSid });
      return SMS_RELINK_REPLY;
    }
    if (!await deps.links.claimInboundMessage(userSub, address.provider, sms.messageSid)) return undefined;
    logger.info({ messageSid: sms.messageSid, userSub }, 'inbound SMS resolved to a linked owner — dispatching');
    defer(runOwnerTurn(deps, { userSub, userIssuer: link.userIssuer }, from, address.provider, sms));
    return undefined;
  };
}

/** The `LINK <code>` handshake: bind this number to the code's owner, answer in the TwiML body. */
async function handleLink(deps: SmsInboundSinkDeps, sms: InboundSms, from: string, provider: TwilioChannelProvider): Promise<string> {
  const code = parseSmsLinkCommand(sms.body) as string;
  const outcome = await redeemChannelCode(deps.links, {
    provider, code, channelUserId: from, chatId: from, displayName: null, eventId: sms.messageSid,
  }, deps.audit ?? recordChannelRefusal);
  if (outcome.status === 'bound_to_another_user') return SMS_REBIND_REFUSED_REPLY;
  if (outcome.status !== 'linked') {
    logger.warn({ messageSid: sms.messageSid }, 'inbound SMS link code invalid/expired/consumed');
    return SMS_LINK_FAILED_REPLY;
  }
  logger.info({ messageSid: sms.messageSid, userSub: outcome.userSub, provider }, 'Twilio channel number linked to an owner');
  return SMS_LINKED_REPLY;
}

/**
 * The deferred half: the swarm turn and the answer, both inside the OWNER's identity — their sub
 * and the verified issuer recorded on the link, which user-bound delegation requires. The thread
 * key is stable per number so follow-up texts land in the same conversation, exactly as the
 * Telegram channel threads per chat.
 */
async function runOwnerTurn(
  deps: SmsInboundSinkDeps, owner: { userSub: string; userIssuer: string },
  from: string, provider: TwilioChannelProvider, sms: InboundSms,
): Promise<void> {
  const startedAt = Date.now();
  const userSub = owner.userSub;
  await runWithRequestIdentity({ sub: userSub, principalIssuer: owner.userIssuer, isOperator: false }, async () => {
    const threadKey = `${provider}-${userSub}-${from}`;
    let answer: string;
    try {
      answer = boundSmsReply(await deps.dispatch(userSub, threadKey, sms.body));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, userSub, messageSid: sms.messageSid }, 'inbound SMS swarm dispatch failed');
      answer = 'Something went wrong reaching your swarm. Please try again in a moment.';
    }
    if (!answer) answer = '(no reply)';
    const sender = parseTwilioChannelAddress(sms.to);
    const sent = await deps.reply(userSub, from, answer, provider, sender?.provider === provider ? sender.number : undefined);
    logger.info(
      { userSub, messageSid: sms.messageSid, delivered: sent.delivered, error: sent.error, durationMs: Date.now() - startedAt },
      'inbound SMS answered',
    );
  });
}
