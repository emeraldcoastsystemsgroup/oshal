/**
 * Notifications — inbound SMS parsing + Twilio request-signature verification.
 *
 * The counterpart to the outbound Twilio SMS transport: when a user replies to a notification, Twilio
 * POSTs the message to a webhook as `application/x-www-form-urlencoded`. This module owns the two pure,
 * unit-testable pieces the webhook route needs — normalizing Twilio's flat form fields into a typed
 * `InboundSms`, and verifying the `X-Twilio-Signature` so a forged POST is rejected. Both are pure
 * functions (no Express, no env) so the slice stays FSD-clean; the app-layer route wires them to a
 * request and a dispatch sink.
 *
 * Signature scheme (Twilio's documented algorithm): HMAC-SHA1 over the full request URL with every
 * POST parameter appended in key-sorted order (key immediately followed by value, no separators),
 * keyed by the account auth token, base64-encoded, compared in constant time. The auth token is
 * never logged or returned.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — InboundSms shape, parseTwilioInboundSms (null on malformed), twilioSignatureBase + verifyTwilioSignature (constant-time, never throws), and flattenFormParams for array-valued form fields.
 *
 * @module features/notifications/services/inbound-sms
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A normalized inbound SMS, decoupled from Twilio's flat wire form. */
export interface InboundSms {
  /** Twilio's unique message id (MessageSid / SmsSid). */
  messageSid: string;
  /** The Twilio account the message arrived on (may be absent on a minimal test payload). */
  accountSid: string | null;
  /** Sender number (E.164). */
  from: string;
  /** The number the message was sent TO (our Twilio number, E.164). */
  to: string;
  /** Message text (may be empty for a media-only MMS). */
  body: string;
  /** Count of media attachments. */
  numMedia: number;
  /** Media URLs (length matches numMedia when Twilio supplied them). */
  mediaUrls: string[];
  /** When we ingested it (ISO 8601). */
  receivedAt: string;
}

/** A raw form field can arrive as a string, a repeated array, or be absent. */
export type RawFormValue = string | string[] | undefined;

/**
 * @description Flatten an Express-parsed form body (values may be arrays for repeated keys) into a
 * plain string→string map, taking the first value of any array. This is the exact shape the Twilio
 * signature is computed over, so both the verifier and the parser consume it.
 * @param body - The parsed form body.
 * @returns A string→string map (missing/empty values become '').
 */
export function flattenFormParams(body: Record<string, RawFormValue> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) return out;
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? String(v[0] ?? '') : String(v);
  }
  return out;
}

/**
 * @description Parse Twilio's inbound-SMS form params into a typed InboundSms. Returns null when the
 * payload is malformed (missing the message id, sender, or recipient) so the route can 400 a junk POST.
 * @param params - Flattened form params (see flattenFormParams).
 * @param opts - Optional clock override for deterministic tests.
 * @returns The normalized message, or null when required fields are absent.
 */
export function parseTwilioInboundSms(
  params: Record<string, string>,
  opts: { now?: () => Date } = {},
): InboundSms | null {
  const messageSid = (params.MessageSid || params.SmsSid || params.SmsMessageSid || '').trim();
  const from = (params.From || '').trim();
  const to = (params.To || '').trim();
  if (!messageSid || !from || !to) return null;

  const numMediaRaw = Number(params.NumMedia);
  const numMedia = Number.isFinite(numMediaRaw) && numMediaRaw > 0 ? Math.min(Math.floor(numMediaRaw), 10) : 0;
  const mediaUrls: string[] = [];
  for (let i = 0; i < numMedia; i += 1) {
    const url = (params[`MediaUrl${i}`] || '').trim();
    if (url) mediaUrls.push(url);
  }

  return {
    messageSid,
    accountSid: (params.AccountSid || '').trim() || null,
    from,
    to,
    body: params.Body ?? '',
    numMedia,
    mediaUrls,
    receivedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/**
 * @description Build the string Twilio signs: the full request URL followed by each POST param in
 * key-sorted order (key immediately concatenated with value). Exported for the guard test.
 * @param url - The full public request URL Twilio POSTed to.
 * @param params - The flattened POST params.
 * @returns The signature base string.
 */
export function twilioSignatureBase(url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return data;
}

/**
 * @description Verify an `X-Twilio-Signature` in constant time. Returns true only on an exact match
 * of the base64 HMAC-SHA1 over the signature base string keyed by the auth token. Never throws; a
 * missing token or signature is a plain false (the route rejects). The auth token is never surfaced.
 * @param opts - The account auth token, the received signature, the request URL, and the POST params.
 * @returns True when the signature is valid.
 */
export function verifyTwilioSignature(opts: {
  authToken: string;
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  const { authToken, signature, url, params } = opts;
  if (!authToken || !signature) return false;
  const expected = createHmac('sha1', authToken).update(Buffer.from(twilioSignatureBase(url, params), 'utf-8')).digest('base64');
  const received = Buffer.from(signature, 'utf-8');
  const expectedBuf = Buffer.from(expected, 'utf-8');
  if (received.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(received, expectedBuf);
  } catch {
    return false;
  }
}
