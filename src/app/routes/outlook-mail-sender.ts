/**
 * Fixed Outlook send operation for trusted in-process application packages.
 *
 * The send sibling of `outlook-mail-reader`: a package names the user whose personal Outlook
 * grant should send, the address that grant must belong to, and ONE recipient. Core selects the
 * grant the same fail-closed way the reader does (personal only, exact login-email match, never a
 * guess among several mailboxes), requires the delegated Mail.Send scope, spends the token on the
 * fixed Graph `me/sendMail` endpoint and keeps a copy in Sent Items. Tokens, Graph error bodies and
 * mailbox identity never cross the AppContext boundary; the package receives a status word.
 *
 * Reply-To is resolved IN CORE from another user's own personal Outlook grant (`replyToUserSub`),
 * so a package can route replies to the person who owns a record without ever reading a
 * connection table itself.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the fixed one-recipient Outlook send for installed packages (sales heads-up emails): personal grant only, exact login-email match, Mail.Send required, Reply-To resolved in core, no token or provider body in any result.
 * -----------------------------------------------------------------------------
 *
 * @module outlook-mail-sender
 */

import type { Pool } from 'pg';
import { getValidAccessToken } from './connector-account-operations';
import { accessibleConnections, type ConnectionRow, type ConnectionSelector } from './connector-tenancy';
import { outlookMailReaderInternals } from './outlook-mail-reader';

const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';
const MAX_SUBJECT = 255;
const MAX_TEXT = 64 * 1024;
const MAX_HTML = 256 * 1024;
const MAX_NAME = 160;

const { normalizeAddress, selectActorMailbox } = outlookMailReaderInternals;

export type OutlookMailSendStatus =
  | 'sent'
  | 'not_connected'
  | 'missing_scope'
  | 'reconnect_required'
  | 'throttled'
  | 'rejected'
  | 'unavailable';

export interface OutlookMailSendInput {
  /** The user whose personal Outlook grant sends. */
  userSub: string;
  /** The address that grant must belong to (exact match, fail-closed). */
  loginEmail: string;
  /** Exactly one recipient. */
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; when present it is the body and `text` is kept for the package's own record. */
  html?: string;
  /** Optional: route replies to this user's own connected Outlook address, resolved in core. */
  replyToUserSub?: string;
}

export interface OutlookMailSendResult {
  status: OutlookMailSendStatus;
  /** Whether a Reply-To header was set from `replyToUserSub`. */
  replyTo: 'set' | 'unavailable' | 'none';
  /** Seconds the provider asked us to wait when `throttled`. */
  retryAfterSeconds?: number;
}

export type OutlookMailSender = (input: OutlookMailSendInput) => Promise<OutlookMailSendResult>;

type AccessTokenResolver = (
  pool: Pool, userSub: string, provider: string, opts?: ConnectionSelector,
) => Promise<string | null>;

interface OutlookMailSenderDependencies {
  listConnections?: (pool: Pool, userSub: string, provider: string) => Promise<ConnectionRow[]>;
  getAccessToken?: AccessTokenResolver;
  fetchImpl?: typeof fetch;
}

/** A delegated Mail.Send grant is required; Mail.Read alone can only read. */
function hasMailSendScope(scopes: string | null): boolean {
  return String(scopes ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .some((scope) => scope === 'mail.send' || scope.endsWith('/mail.send'));
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Subjects are a single header line: no CR/LF may survive into the Graph payload. */
function boundedSubject(value: unknown): string {
  return boundedText(value, MAX_SUBJECT).replace(/\s*[\r\n]+\s*/g, ' ');
}

function retryAfter(response: Response): number | undefined {
  const raw = Number(response.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) : undefined;
}

/** Post one message to the fixed Graph endpoint and translate the outcome into a status word. */
async function postGraph(
  fetchImpl: typeof fetch, token: string, message: Record<string, unknown>,
): Promise<{ status: OutlookMailSendStatus; retryAfterSeconds?: number }> {
  let response: Response;
  try {
    response = await fetchImpl(GRAPH_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.status === 202 || response.ok) return { status: 'sent' };
  if (response.status === 401 || response.status === 403) return { status: 'reconnect_required' };
  if (response.status === 429 || response.status === 503) return { status: 'throttled', retryAfterSeconds: retryAfter(response) };
  // A 4xx the provider refused (bad recipient, mailbox full); the body is Microsoft's and stays here.
  return { status: response.status >= 500 ? 'unavailable' : 'rejected' };
}

/**
 * Build the fixed Outlook send operation exposed to trusted application packages.
 *
 * One recipient per call on purpose: a package that mails a list loops, and every iteration is a
 * separately authorized, separately logged send with its own status.
 */
export function createOutlookMailSender(
  pool: Pool,
  dependencies: OutlookMailSenderDependencies = {},
): OutlookMailSender {
  const listConnections = dependencies.listConnections ?? accessibleConnections;
  const getAccessToken = dependencies.getAccessToken ?? getValidAccessToken;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  const result = (status: OutlookMailSendStatus, replyTo: OutlookMailSendResult['replyTo'] = 'none',
    retryAfterSeconds?: number): OutlookMailSendResult => (
    retryAfterSeconds === undefined ? { status, replyTo } : { status, replyTo, retryAfterSeconds }
  );

  /** The reply address is another user's own personal Outlook grant; a missing one is "unavailable", never a guess. */
  const resolveReplyTo = async (replyToUserSub: unknown): Promise<string | null> => {
    const sub = boundedText(replyToUserSub, 512);
    if (!sub) return null;
    const rows = await listConnections(pool, sub, 'outlook');
    const connection = selectActorMailbox(rows, null);
    return connection ? normalizeAddress(connection.account_email) : null;
  };

  return async (input: OutlookMailSendInput): Promise<OutlookMailSendResult> => {
    const userSub = boundedText(input?.userSub, 512);
    const loginEmail = normalizeAddress(input?.loginEmail);
    // The sender address is REQUIRED here (unlike the reader): a background job must never send
    // from whichever mailbox a user happens to have connected.
    if (!userSub || !loginEmail) return result('not_connected');
    const to = normalizeAddress(input?.to);
    const subject = boundedSubject(input?.subject);
    const text = boundedText(input?.text, MAX_TEXT);
    const html = input?.html === undefined ? '' : boundedText(input.html, MAX_HTML);
    if (!to || !subject || (!text && !html)) return result('rejected');

    const rows = await listConnections(pool, userSub, 'outlook');
    const connection = selectActorMailbox(rows, loginEmail);
    if (!connection) return result('not_connected');
    if (!hasMailSendScope(connection.scopes)) return result('missing_scope');

    const replyToAddress = input?.replyToUserSub === undefined ? null : await resolveReplyTo(input.replyToUserSub);
    const replyTo: OutlookMailSendResult['replyTo'] = input?.replyToUserSub === undefined
      ? 'none' : (replyToAddress ? 'set' : 'unavailable');

    let token: string | null;
    try {
      token = await getAccessToken(pool, userSub, 'outlook', {
        tenantId: 'personal', connectionId: connection.connection_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return result(/^refresh\s+(400|401|403)\b/i.test(message) ? 'reconnect_required' : 'unavailable', replyTo);
    }
    if (!token) return result('reconnect_required', replyTo);

    const message: Record<string, unknown> = {
      subject,
      body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    if (replyToAddress) message.replyTo = [{ emailAddress: { address: replyToAddress } }];
    const outcome = await postGraph(fetchImpl, token, message);
    return result(outcome.status, replyTo, outcome.retryAfterSeconds);
  };
}

// Pure helpers exported for focused boundary tests.
export const outlookMailSenderInternals = { hasMailSendScope, boundedSubject, MAX_NAME };
