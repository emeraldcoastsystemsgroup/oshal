/**
 * Chat-channel denial audit — the single place an inbound channel refusal becomes a durable record.
 *
 * Every provider (Telegram webhook, Discord Gateway, Twilio SMS and WhatsApp webhook) refuses the
 * same three things before any bot turn: an identity nobody linked, a link code that is unknown,
 * expired, consumed or minted for another provider, and an identity already bound to a different
 * user. Before this module those refusals were at most a log line (the Telegram unlinked path did
 * not even log), so a probe against the shared bot left nothing an operator could review.
 *
 * The refusal is written through the platform chokepoint (`recordRefusal`), never a second ledger.
 * The refusing actor is a pseudonymous channel key — `channel:<provider>:<truncated SHA-256>` — so
 * the raw phone number, Telegram id or Discord id is never persisted, and because that key matches
 * no user's sub the owner-or-operator RLS on the ledger leaves the row visible to operators only.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — audit unlinked identities, refused link codes and cross-user rebind attempts on every inbound chat channel through the refusal ledger, under a hashed channel actor so no raw channel identity is stored; redeemChannelCode gives every provider one audited link handshake.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | New reason `link_issuer_missing`: a legacy link that predates issuer capture cannot run a user-bound bot turn (delegation needs the verified issuer), so it is refused before any dispatch and the sender is told to re-link. It reuses the existing `channel_link_required` ledger code — the user action is the same, a fresh link — and the reason stays distinct in the row's metadata.
 *
 * @module chat-channels/channel-refusal-audit
 */

import { createHash } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { recordRefusal, type RefusalTargetKind } from '@/shared/refusal-events';
import type { ChannelLinkRedemption } from './channel-link-service';

const logger = createChildLogger({ module: 'channel-refusal-audit' });

/** Why an inbound channel message was refused before any bot turn. */
export type ChannelRefusalReason =
  | 'unlinked_identity' | 'invalid_link_code' | 'identity_bound_to_another_user' | 'link_issuer_missing';

/** The stable refusal-ledger code for each channel refusal reason. */
export const CHANNEL_REFUSAL_CODES: Readonly<Record<ChannelRefusalReason, string>> = Object.freeze({
  unlinked_identity: 'channel_link_required',
  invalid_link_code: 'channel_link_code_refused',
  identity_bound_to_another_user: 'channel_identity_rebind_denied',
  link_issuer_missing: 'channel_link_required',
});

/** The package every channel refusal is attributed to in the ledger. */
export const CHANNEL_REFUSAL_PACKAGE = 'chat-channels';

/** Where each provider's inbound traffic enters, so the ledger names the surface that refused. */
const CHANNEL_INBOUND_TARGETS: Readonly<Record<string, { kind: RefusalTargetKind; target: string }>> = Object.freeze({
  telegram: { kind: 'route', target: '/api/channels/telegram/webhook' },
  discord: { kind: 'other', target: 'discord-gateway:MESSAGE_CREATE' },
  sms: { kind: 'route', target: '/api/sms/inbound' },
  whatsapp: { kind: 'route', target: '/api/sms/inbound' },
});

/** One refused inbound channel message. The raw identity is hashed here and never persisted. */
export interface ChannelRefusalInput {
  provider: string;
  channelUserId: string;
  reason: ChannelRefusalReason;
  /** The provider occurrence id (update_id, Discord message id, MessageSid) when one exists. */
  eventId?: string;
  /** For a refused rebind: the user whose code was presented. */
  codeOwnerSub?: string | null;
  /** For a refused rebind: the user the identity is already bound to. */
  boundOwnerSub?: string | null;
}

/** The recorder port the inbound processors call; injectable so a Test Lab step can observe it. */
export type ChannelRefusalRecorder = (input: ChannelRefusalInput) => Promise<boolean>;

/**
 * @description Derive the pseudonymous refusal actor for a channel identity. Stable per identity so
 * repeated probes from one sender correlate, and never the raw id.
 * @param provider - The channel provider ('telegram' | 'discord' | 'sms' | 'whatsapp').
 * @param channelUserId - The provider identity (chat user id, Discord user id, E.164 number).
 * @returns `channel:<provider>:<24 hex chars of SHA-256(provider:identity)>`.
 */
export function channelRefusalActor(provider: string, channelUserId: string): string {
  const digest = createHash('sha256').update(`${provider}:${channelUserId}`).digest('hex').slice(0, 24);
  return `channel:${provider}:${digest}`;
}

/**
 * @description Log and durably record one inbound channel refusal through the platform refusal
 * chokepoint. Persistence is observational: the caller has already refused, and a ledger failure
 * never turns the refusal into an error for the sender.
 * @param input - The provider, raw identity (hashed here), reason and optional occurrence/owners.
 * @returns True only after the refusal ledger committed the row.
 */
export async function recordChannelRefusal(input: ChannelRefusalInput): Promise<boolean> {
  const actorSub = channelRefusalActor(input.provider, input.channelUserId);
  const code = CHANNEL_REFUSAL_CODES[input.reason];
  const surface = CHANNEL_INBOUND_TARGETS[input.provider] ?? { kind: 'other' as const, target: `channel:${input.provider}` };
  logger.warn({ provider: input.provider, reason: input.reason, code, actorSub, eventId: input.eventId },
    'inbound channel message refused before any bot turn');
  return recordRefusal({
    code,
    actorSub,
    owningPackage: CHANNEL_REFUSAL_PACKAGE,
    targetKind: surface.kind,
    target: surface.target,
    metadata: {
      provider: input.provider,
      reason: input.reason,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.codeOwnerSub ? { codeOwnerSub: input.codeOwnerSub } : {}),
      ...(input.boundOwnerSub ? { boundOwnerSub: input.boundOwnerSub } : {}),
    },
  });
}

/** The link-store surface a code redemption needs (ChannelLinkService satisfies it). */
export interface ChannelLinkRedeemer {
  redeemLinkCode(
    provider: string, code: string, channelUserId: string, chatId: string, displayName: string | null,
  ): Promise<ChannelLinkRedemption>;
}

/** One `LINK <code>` / `/start <code>` attempt as a provider delivered it. */
export interface ChannelLinkAttempt {
  provider: string;
  code: string;
  channelUserId: string;
  chatId: string;
  displayName: string | null;
  eventId?: string;
}

/**
 * @description Redeem a presented link code and audit the two refusals it can produce — an
 * invalid/expired/consumed/other-provider code, and an identity already bound to another user — so
 * every provider handles the handshake identically.
 * @param links - The channel identity store.
 * @param attempt - The provider, code, sender identity, reply chat and occurrence id.
 * @param audit - The refusal recorder (the platform ledger by default).
 * @returns The redemption outcome; the caller only chooses the reply text.
 */
export async function redeemChannelCode(
  links: ChannelLinkRedeemer,
  attempt: ChannelLinkAttempt,
  audit: ChannelRefusalRecorder = recordChannelRefusal,
): Promise<ChannelLinkRedemption> {
  const outcome = await links.redeemLinkCode(
    attempt.provider, attempt.code, attempt.channelUserId, attempt.chatId, attempt.displayName);
  const base = { provider: attempt.provider, channelUserId: attempt.channelUserId, eventId: attempt.eventId };
  if (outcome.status === 'invalid_code') await audit({ ...base, reason: 'invalid_link_code' });
  if (outcome.status === 'bound_to_another_user') {
    await audit({ ...base, reason: 'identity_bound_to_another_user',
      codeOwnerSub: outcome.codeOwnerSub, boundOwnerSub: outcome.boundOwnerSub });
  }
  return outcome;
}
