/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: add one schema-bounded, in-process per-user Twilio SMS operation so connector credentials never enter a child environment, workspace, argv, or model-visible tool context.
 * 2   | maintainer@emeraldcoastsystemsgroup.com     | A WhatsApp reply leaves from the WhatsApp sender the user messaged: sendUserTwilioMessage accepts that E.164 sender for provider 'whatsapp' and skips the IncomingPhoneNumbers lookup, which returned the owner's first SMS number - a sender Twilio refuses for WhatsApp unless it happens to be WhatsApp-enabled. SMS keeps the owner-number lookup; an invalid override is refused before any credential is read.
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { SMS_CHANNEL_PROVIDER, type TwilioChannelProvider, WHATSAPP_CHANNEL_PROVIDER } from '@/features/chat-channels';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'twilio-sms-operation' });
const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;
const AUTH_TOKEN_RE = /^[0-9a-f]{32}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const MAX_SMS_CHARS = 1_600;

/** @description Sanitized result from the fixed Twilio SMS server operation. */
export interface TwilioSmsOperationResult {
  delivered: boolean;
  id?: string;
  error?: string;
}

/**
 * @description Sends one SMS through the authenticated user's connected Twilio account. The
 * combined SID/token is decrypted inside this function, used only for two fixed Twilio endpoints,
 * and never returned, logged, placed in process.env, or passed to a child process.
 * @param pool - Controller database pool used by the connector credential resolver
 * @param userSub - Exact authenticated owner of the Twilio connection
 * @param to - E.164 destination already selected by an authorized notification preference
 * @param body - Plain-text SMS body
 * @returns Sanitized delivery result
 */
export async function sendUserTwilioSms(
  pool: AppContext['pool'],
  userSub: string,
  to: string,
  body: string,
): Promise<TwilioSmsOperationResult> {
  return sendUserTwilioMessage(pool, userSub, to, body, SMS_CHANNEL_PROVIDER);
}

/**
 * @description Send one owner-scoped Twilio message as SMS or WhatsApp.
 * @param pool - Controller database pool used by the connector credential resolver
 * @param userSub - Exact authenticated owner of the Twilio connection
 * @param to - E.164 destination
 * @param body - Plain-text message body
 * @param provider - 'sms' or 'whatsapp'
 * @param whatsAppSender - For WhatsApp only: the E.164 sender the user messaged; when given, the
 * reply leaves from it instead of the owner's first IncomingPhoneNumber
 * @returns Sanitized delivery result
 */
export async function sendUserTwilioMessage(
  pool: AppContext['pool'],
  userSub: string,
  to: string,
  body: string,
  provider: TwilioChannelProvider = SMS_CHANNEL_PROVIDER,
  whatsAppSender?: string,
): Promise<TwilioSmsOperationResult> {
  if (!userSub.trim()) return { delivered: false, error: 'twilio_user_required' };
  if (provider !== SMS_CHANNEL_PROVIDER && provider !== WHATSAPP_CHANNEL_PROVIDER) return { delivered: false, error: 'twilio_provider_invalid' };
  if (!E164_RE.test(to)) return { delivered: false, error: 'twilio_destination_invalid' };
  const senderOverride = provider === WHATSAPP_CHANNEL_PROVIDER ? whatsAppSender : undefined;
  if (senderOverride !== undefined && !E164_RE.test(senderOverride)) return { delivered: false, error: 'twilio_sender_invalid' };
  const boundedBody = body.trim().slice(0, MAX_SMS_CHARS);
  if (!boundedBody) return { delivered: false, error: 'twilio_message_required' };

  const combinedSecret = await getValidAccessToken(pool, userSub, 'twilio');
  const credential = parseTwilioCredential(combinedSecret);
  if (!credential) return { delivered: false, error: 'twilio_connection_unavailable' };

  const authorization = 'Basic ' + Buffer.from(
    credential.sid + ':' + credential.authToken,
  ).toString('base64');
  try {
    const sender = senderOverride !== undefined
      ? { from: senderOverride }
      : await lookupOwnerSender(credential.sid, authorization, userSub);
    if ('error' in sender) return { delivered: false, error: sender.error };

    const prefix = provider === WHATSAPP_CHANNEL_PROVIDER ? 'whatsapp:' : '';
    const form = new URLSearchParams({ From: `${prefix}${sender.from}`, To: `${prefix}${to}`, Body: boundedBody });
    return await postTwilioMessage(credential.sid, authorization, form, userSub, provider);
  } catch (error) {
    logger.warn(
      { userSub, errorType: error instanceof Error ? error.name : 'unknown' },
      'Twilio message operation network failure',
    );
    return { delivered: false, error: 'twilio_sms_network_failed' };
  }
}

/** The one Messages request: exact endpoint and form, sanitized result. Network errors propagate to the caller's catch. */
async function postTwilioMessage(
  sid: string, authorization: string, form: URLSearchParams, userSub: string, provider: TwilioChannelProvider,
): Promise<TwilioSmsOperationResult> {
  const sendResponse = await fetch(
    TWILIO_API_BASE + '/Accounts/' + encodeURIComponent(sid) + '/Messages.json',
    {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const result = await sendResponse.json().catch(() => ({})) as { sid?: unknown };
  if (!sendResponse.ok || typeof result.sid !== 'string' || !result.sid.trim()) {
    logger.warn({ userSub, provider, status: sendResponse.status }, 'Twilio message operation failed');
    return { delivered: false, error: 'twilio_message_http_' + sendResponse.status };
  }
  return { delivered: true, id: result.sid };
}

/** The owner's first IncomingPhoneNumber - the SMS sender, and the WhatsApp fallback. */
async function lookupOwnerSender(
  sid: string, authorization: string, userSub: string,
): Promise<{ from: string } | { error: string }> {
  const numbersResponse = await fetch(
    TWILIO_API_BASE + '/Accounts/' + encodeURIComponent(sid) + '/IncomingPhoneNumbers.json?PageSize=1',
    { headers: { Authorization: authorization }, signal: AbortSignal.timeout(15_000) },
  );
  if (!numbersResponse.ok) {
    logger.warn({ userSub, status: numbersResponse.status }, 'Twilio sender-number lookup failed');
    return { error: 'twilio_numbers_http_' + numbersResponse.status };
  }
  const numbers = await numbersResponse.json() as { incoming_phone_numbers?: Array<{ phone_number?: unknown }> };
  const from = String(numbers.incoming_phone_numbers?.[0]?.phone_number || '');
  return E164_RE.test(from) ? { from } : { error: 'twilio_sender_unavailable' };
}

/** Parse the exact connector format without accepting ambiguous or partial credential shapes. */
function parseTwilioCredential(raw: string | null): { sid: string; authToken: string } | null {
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator !== raw.lastIndexOf(':')) return null;
  const sid = raw.slice(0, separator).trim();
  const authToken = raw.slice(separator + 1).trim();
  return ACCOUNT_SID_RE.test(sid) && AUTH_TOKEN_RE.test(authToken)
    ? { sid, authToken }
    : null;
}
