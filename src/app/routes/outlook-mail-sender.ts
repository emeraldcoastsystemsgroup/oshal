/**
 * Fixed one-recipient mail send for trusted in-process application packages.
 *
 * The send sibling of `outlook-mail-reader`: a package names the user whose personal mail grant
 * should send, the address that grant must belong to, and ONE recipient. Core selects the grant
 * the same fail-closed way the reader does (personal only, exact login-email match, never a guess
 * among several mailboxes), requires the delegated send scope, spends the token on the provider's
 * fixed send endpoint and keeps a copy in the sent folder. Tokens, provider error bodies and
 * mailbox identity never cross the AppContext boundary; the package receives a status word.
 *
 * Two providers, one shape: `outlook` (Microsoft Graph `me/sendMail`, the default) and `google`
 * (Gmail `users.messages.send` with a raw RFC 2822 message built here). A test box can therefore
 * run a package's whole mail process on a Google account before production uses Outlook.
 *
 * Reply-To is resolved IN CORE from another user's own personal grant (`replyToUserSub`), so a
 * package can route replies to the person who owns a record without ever reading a connection
 * table itself.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the fixed one-recipient Outlook send for installed packages (sales heads-up emails): personal grant only, exact login-email match, Mail.Send required, Reply-To resolved in core, no token or provider body in any result.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | `provider: 'google'` sends the same message through the Gmail API (gmail.send scope, raw RFC 2822 built here with Reply-To and a text+HTML alternative), so a test box without a Microsoft app registration can run the whole process on a Google account; Reply-To resolution looks at the sender's provider first, then the other.
 * -----------------------------------------------------------------------------
 *
 * @module outlook-mail-sender
 */

import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { getValidAccessToken } from './connector-account-operations';
import { accessibleConnections, type ConnectionRow, type ConnectionSelector } from './connector-tenancy';
import { outlookMailReaderInternals } from './outlook-mail-reader';

const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const MAX_SUBJECT = 255;
const MAX_TEXT = 64 * 1024;
const MAX_HTML = 256 * 1024;
const MAX_NAME = 160;

const { normalizeAddress, selectActorMailbox } = outlookMailReaderInternals;

export type MailSendProvider = 'outlook' | 'google';

export type OutlookMailSendStatus =
  | 'sent'
  | 'not_connected'
  | 'missing_scope'
  | 'reconnect_required'
  | 'throttled'
  | 'rejected'
  | 'unavailable';

export interface OutlookMailSendInput {
  /** The user whose personal mail grant sends. */
  userSub: string;
  /** The address that grant must belong to (exact match, fail-closed). */
  loginEmail: string;
  /** Exactly one recipient. */
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative; Outlook sends it as the body, Gmail as a multipart/alternative beside `text`. */
  html?: string;
  /** Optional: route replies to this user's own connected mailbox address, resolved in core. */
  replyToUserSub?: string;
  /** Which connector the sender grant lives in; `outlook` when omitted. */
  provider?: MailSendProvider;
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

interface MessageParts { to: string; subject: string; text: string; html: string; replyTo: string | null }
type Outcome = { status: OutlookMailSendStatus; retryAfterSeconds?: number };

/** A delegated Mail.Send grant is required; Mail.Read alone can only read. */
function hasMailSendScope(scopes: string | null): boolean {
  return String(scopes ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .some((scope) => scope === 'mail.send' || scope.endsWith('/mail.send'));
}

/** The Google grant must carry gmail.send; gmail.readonly alone can only read. */
function hasGmailSendScope(scopes: string | null): boolean {
  return String(scopes ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .some((scope) => scope === 'gmail.send' || scope.endsWith('/gmail.send'));
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Subjects are a single header line: no CR/LF may survive into the provider payload. */
function boundedSubject(value: unknown): string {
  return boundedText(value, MAX_SUBJECT).replace(/\s*[\r\n]+\s*/g, ' ');
}

/** RFC 2047 encoded word for a header value that is not plain ASCII. */
function headerWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Base64 body lines at 76 columns, as RFC 2045 asks. */
function base64Lines(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/** The raw RFC 2822 message Gmail sends verbatim: text, or a text+HTML alternative, Reply-To optional. */
function buildRawMessage(parts: MessageParts): string {
  const headers = [`To: ${parts.to}`];
  if (parts.replyTo) headers.push(`Reply-To: ${parts.replyTo}`);
  headers.push(`Subject: ${headerWord(parts.subject)}`, 'MIME-Version: 1.0');
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(parts.text || '')];
  if (!parts.html) return [...headers, ...textPart].join('\r\n');
  const boundary = `oshal_${randomBytes(8).toString('hex')}`;
  return [
    ...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, ...textPart, `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(parts.html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

function retryAfter(response: Response): number | undefined {
  const raw = Number(response.headers.get('retry-after'));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) : undefined;
}

/** Translate a provider answer into a status word; the body is the provider's and stays here. */
function outcomeOf(response: Response): Outcome {
  if (response.status === 202 || response.ok) return { status: 'sent' };
  if (response.status === 401 || response.status === 403) return { status: 'reconnect_required' };
  if (response.status === 429 || response.status === 503) return { status: 'throttled', retryAfterSeconds: retryAfter(response) };
  // A 4xx the provider refused (bad recipient, mailbox full).
  return { status: response.status >= 500 ? 'unavailable' : 'rejected' };
}

/** Post one message to the provider's fixed send endpoint. */
async function post(fetchImpl: typeof fetch, url: string, token: string, body: unknown): Promise<Outcome> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return outcomeOf(response);
  } catch {
    return { status: 'unavailable' };
  }
}

/** The provider payloads: Graph takes JSON with saveToSentItems; Gmail takes the raw message and files it itself. */
function deliver(fetchImpl: typeof fetch, provider: MailSendProvider, token: string, parts: MessageParts): Promise<Outcome> {
  if (provider === 'google') {
    return post(fetchImpl, GMAIL_SEND_URL, token, { raw: Buffer.from(buildRawMessage(parts), 'utf8').toString('base64url') });
  }
  const message: Record<string, unknown> = {
    subject: parts.subject,
    body: parts.html ? { contentType: 'HTML', content: parts.html } : { contentType: 'Text', content: parts.text },
    toRecipients: [{ emailAddress: { address: parts.to } }],
  };
  if (parts.replyTo) message.replyTo = [{ emailAddress: { address: parts.replyTo } }];
  return post(fetchImpl, GRAPH_SEND_URL, token, { message, saveToSentItems: true });
}

/**
 * Build the fixed mail send operation exposed to trusted application packages.
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

  /** The reply address is another user's own personal grant, the sender's provider first; a missing one is "unavailable", never a guess. */
  const resolveReplyTo = async (replyToUserSub: unknown, provider: MailSendProvider): Promise<string | null> => {
    const sub = boundedText(replyToUserSub, 512);
    if (!sub) return null;
    for (const candidate of provider === 'google' ? ['google', 'outlook'] : ['outlook', 'google']) {
      const connection = selectActorMailbox(await listConnections(pool, sub, candidate), null);
      const address = connection ? normalizeAddress(connection.account_email) : null;
      if (address) return address;
    }
    return null;
  };

  return async (input: OutlookMailSendInput): Promise<OutlookMailSendResult> => {
    const provider: MailSendProvider = input?.provider === 'google' ? 'google' : 'outlook';
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

    const connection = selectActorMailbox(await listConnections(pool, userSub, provider), loginEmail);
    if (!connection) return result('not_connected');
    if (!(provider === 'google' ? hasGmailSendScope : hasMailSendScope)(connection.scopes)) return result('missing_scope');

    const replyToAddress = input?.replyToUserSub === undefined ? null : await resolveReplyTo(input.replyToUserSub, provider);
    const replyTo: OutlookMailSendResult['replyTo'] = input?.replyToUserSub === undefined
      ? 'none' : (replyToAddress ? 'set' : 'unavailable');

    let token: string | null;
    try {
      token = await getAccessToken(pool, userSub, provider, { tenantId: 'personal', connectionId: connection.connection_id });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return result(/^refresh\s+(400|401|403)\b/i.test(message) ? 'reconnect_required' : 'unavailable', replyTo);
    }
    if (!token) return result('reconnect_required', replyTo);

    const outcome = await deliver(fetchImpl, provider, token, { to, subject, text, html, replyTo: replyToAddress });
    return result(outcome.status, replyTo, outcome.retryAfterSeconds);
  };
}

// Pure helpers exported for focused boundary tests.
export const outlookMailSenderInternals = { hasMailSendScope, hasGmailSendScope, boundedSubject, buildRawMessage, headerWord, MAX_NAME };
