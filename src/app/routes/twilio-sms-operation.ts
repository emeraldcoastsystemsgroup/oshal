/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: add one schema-bounded, in-process per-user Twilio SMS operation so connector credentials never enter a child environment, workspace, argv, or model-visible tool context.
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
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
  if (!userSub.trim()) return { delivered: false, error: 'twilio_user_required' };
  if (!E164_RE.test(to)) return { delivered: false, error: 'twilio_destination_invalid' };
  const boundedBody = body.trim().slice(0, MAX_SMS_CHARS);
  if (!boundedBody) return { delivered: false, error: 'twilio_message_required' };

  const combinedSecret = await getValidAccessToken(pool, userSub, 'twilio');
  const credential = parseTwilioCredential(combinedSecret);
  if (!credential) return { delivered: false, error: 'twilio_connection_unavailable' };

  const authorization = 'Basic ' + Buffer.from(
    credential.sid + ':' + credential.authToken,
  ).toString('base64');
  try {
    const numbersResponse = await fetch(
      TWILIO_API_BASE + '/Accounts/' + encodeURIComponent(credential.sid)
        + '/IncomingPhoneNumbers.json?PageSize=1',
      {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!numbersResponse.ok) {
      logger.warn({ userSub, status: numbersResponse.status }, 'Twilio sender-number lookup failed');
      return { delivered: false, error: 'twilio_numbers_http_' + numbersResponse.status };
    }
    const numbers = await numbersResponse.json() as {
      incoming_phone_numbers?: Array<{ phone_number?: unknown }>;
    };
    const from = String(numbers.incoming_phone_numbers?.[0]?.phone_number || '');
    if (!E164_RE.test(from)) return { delivered: false, error: 'twilio_sender_unavailable' };

    const form = new URLSearchParams({ From: from, To: to, Body: boundedBody });
    const sendResponse = await fetch(
      TWILIO_API_BASE + '/Accounts/' + encodeURIComponent(credential.sid) + '/Messages.json',
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
      logger.warn({ userSub, status: sendResponse.status }, 'Twilio SMS operation failed');
      return { delivered: false, error: 'twilio_sms_http_' + sendResponse.status };
    }
    return { delivered: true, id: result.sid };
  } catch (error) {
    logger.warn(
      { userSub, errorType: error instanceof Error ? error.name : 'unknown' },
      'Twilio SMS operation network failure',
    );
    return { delivered: false, error: 'twilio_sms_network_failed' };
  }
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
