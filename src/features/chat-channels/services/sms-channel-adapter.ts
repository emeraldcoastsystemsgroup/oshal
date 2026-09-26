/**
 * Chat-channels — the SMS channel adapter (inbound Twilio SMS → an OSHAL identity).
 *
 * The Telegram sibling of this slice turns a chat id into a `user_sub` through `channel_links`.
 * SMS needs the same binding and nothing more exotic: the messaging identity is the sender's
 * phone number, so an inbound text resolves to exactly one linked user through the SAME
 * (provider, channel_user_id) primary key — `provider = 'sms'`, `channel_user_id` = the E.164
 * number. An UNLINKED number therefore resolves to nobody and can never reach a swarm, which is
 * the isolation boundary: one shared Twilio number serves many users without a number ever
 * seeing another user's data.
 *
 * This module is the pure, FSD-clean half — normalization and command parsing, no Express, no
 * pool, no env. The number is normalized on BOTH sides of the binding (the code redemption that
 * writes the row and the lookup that reads it) so `+1 555-123-0000` and `+15551230000` cannot
 * become two different identities. Normalization is deliberately country-agnostic: a bare
 * national number is REFUSED rather than guessed into a country code, because guessing would
 * bind one user's identity to another country's subscriber. Twilio always sends E.164 in `From`,
 * so the strict form is what the wire actually carries.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — SMS_CHANNEL_PROVIDER, strict country-agnostic normalizeE164 (separators tolerated, a bare national number refused), parseSmsLinkCommand for the LINK <code> handshake a texter uses instead of Telegram's /start deep link, and boundSmsReply for the Twilio body cap.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit WhatsApp-via-Twilio address parsing so the shared signed webhook cannot bind or reply to a WhatsApp identity as plain SMS.
 *
 * @module features/chat-channels/services/sms-channel-adapter
 */

/**
 * The `channel_links.provider` value for the SMS channel. Distinct from 'telegram' so the two
 * channels' identities can never collide on the shared primary key.
 */
export const SMS_CHANNEL_PROVIDER = 'sms';
export const WHATSAPP_CHANNEL_PROVIDER = 'whatsapp';

export type TwilioChannelProvider = typeof SMS_CHANNEL_PROVIDER | typeof WHATSAPP_CHANNEL_PROVIDER;

/** Normalize Twilio's `From`/`To` channel address without guessing a country. */
export function parseTwilioChannelAddress(raw: string | null | undefined): { provider: TwilioChannelProvider; number: string } | null {
  const value = String(raw || '').trim();
  const isWhatsApp = /^whatsapp:/i.test(value);
  const number = normalizeE164(isWhatsApp ? value.slice('whatsapp:'.length) : value);
  return number ? { provider: isWhatsApp ? WHATSAPP_CHANNEL_PROVIDER : SMS_CHANNEL_PROVIDER, number } : null;
}

/** Twilio's per-message body cap; a longer reply is truncated rather than rejected. */
export const SMS_REPLY_MAX_CHARS = 1_600;

/** Strict E.164: '+', a non-zero country digit, then 6-14 more digits. */
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Separators a human (or a console paste) may put inside a number; they carry no identity. */
const SEPARATORS_RE = /[\s().\-‐-―]/g;

/** The code a texter sends to bind their number, as minted by ChannelLinkService (hex today). */
const LINK_COMMAND_RE = /^\s*(?:\/start|start|link)\s+([0-9a-z]{4,32})\s*$/i;

/**
 * @description Normalize a phone number to canonical E.164 for use as a channel identity.
 * Tolerates spaces, dashes, dots, parentheses and unicode dashes; refuses anything that is not
 * already internationally qualified (no country code is ever assumed — see the module note).
 * @param raw - The number as it arrived (Twilio `From`/`To`, or a value typed in the cockpit).
 * @returns The canonical `+<digits>` form, or null when the input is not a valid E.164 number.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = String(raw).replace(SEPARATORS_RE, '');
  return E164_RE.test(compact) ? compact : null;
}

/**
 * @description Parse the SMS linking handshake out of a message body. SMS has no deep link, so
 * the texter sends `LINK <code>` (or `START <code>`, matching the Telegram wording) with the
 * one-time code minted in the cockpit. The code is lower-cased because that is the form
 * `ChannelLinkService.mintLinkCode` stores, and the redemption compares it exactly.
 * @param body - The raw inbound message body.
 * @returns The link code, or null when the body is an ordinary message.
 */
export function parseSmsLinkCommand(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = LINK_COMMAND_RE.exec(String(body));
  return match ? match[1].toLowerCase() : null;
}

/**
 * @description Bound a reply to what one Twilio message body may carry, so a long swarm answer
 * degrades to a truncated text instead of a rejected send.
 * @param text - The reply text.
 * @param max - Optional cap override (default {@link SMS_REPLY_MAX_CHARS}).
 * @returns The trimmed, capped body (empty string when there is nothing to say).
 */
export function boundSmsReply(text: string | null | undefined, max: number = SMS_REPLY_MAX_CHARS): string {
  return String(text ?? '').trim().slice(0, Math.max(0, max));
}
