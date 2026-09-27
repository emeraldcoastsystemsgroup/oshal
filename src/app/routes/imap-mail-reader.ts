/**
 * Fixed, read-only Yahoo Mail inbox reader for trusted application packages (ADR-037).
 *
 * This is deliberately a fixed operation, not an IMAP proxy. A package supplies only the
 * authenticated user; core selects that user's PERSONAL `yahoo` connection, decrypts its
 * "address:app-password" secret, logs in to the FIXED host imap.mail.yahoo.com:993 over TLS,
 * opens INBOX with EXAMINE (read-only), fetches the envelopes and flags of at most the newest 50
 * messages, and logs out. The host is never caller-supplied (no server-side request forgery
 * surface), no command can write to the mailbox, and the credential never crosses the AppContext
 * boundary — packages receive only display metadata in the kernel MailSummary shape.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: closed "address:app-password" secret schema, fixed-host LOGIN probe for the connect-time validation, and the caller-scoped EXAMINE + bounded envelope FETCH reader exposed on AppContext as `imapMail`.
 * -----------------------------------------------------------------------------
 *
 * @module imap-mail-reader
 */

import type { Pool } from 'pg';
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from 'imapflow';
import { createChildLogger } from '@/shared/logger';
import { getValidAccessToken } from './connector-account-operations';
import type { ConnectionSelector } from './connector-tenancy';
import type { summarizeGmailMetadata } from './email-routes';

const logger = createChildLogger({ module: 'imap-mail-reader' });

/** Where an IMAP session connects. Production uses YAHOO_IMAP_ENDPOINT only. */
export interface ImapEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

/** The one Yahoo Mail IMAP endpoint core ever connects to: implicit TLS on 993. */
export const YAHOO_IMAP_ENDPOINT: Readonly<ImapEndpoint> = Object.freeze({
  host: 'imap.mail.yahoo.com',
  port: 993,
  secure: true,
});

/** Newest messages a single read may return, whatever the caller asks for. */
export const IMAP_MAX_MESSAGES = 50;
const DEFAULT_MESSAGES = 25;
const ADDRESS_MAX = 254;
const TEXT_MAX = 500;

/** The privacy-bounded per-message metadata shape shared with the Gmail and Outlook legs. */
export type ImapMailSummary = ReturnType<typeof summarizeGmailMetadata>;

/** Outcome of a read, named so packages can explain it without seeing the credential. */
export type ImapMailStatus = 'connected' | 'not_connected' | 'reconnect_required' | 'unavailable';

/** What a package may ask for: whose inbox (the authenticated caller) and how many rows. */
export interface ImapMailListInput {
  userSub: string;
  limit?: number;
}

/** The read result: status plus display metadata, never a token or password. */
export interface ImapMailListResult {
  status: ImapMailStatus;
  messages: ImapMailSummary[];
}

/** The AppContext seam: a fixed read of the caller's own Yahoo inbox. */
export type ImapMailReader = (input: ImapMailListInput) => Promise<ImapMailListResult>;

/** A validated Yahoo credential pair. */
export interface YahooCredentials {
  address: string;
  appPassword: string;
}

/** Test seams; production passes none, so the endpoint and broker are fixed. */
export interface ImapMailReaderDependencies {
  getAccessToken?: (pool: Pool, userSub: string, provider: string, selector?: ConnectionSelector) => Promise<string | null>;
  endpoint?: ImapEndpoint;
}

/** Raised when the provider refuses the LOGIN (bad or revoked app password). */
export class ImapAuthenticationError extends Error {
  /**
   * @description A LOGIN the server answered NO to.
   * @returns An ImapAuthenticationError.
   */
  constructor() {
    super('imap authentication failed');
    this.name = 'ImapAuthenticationError';
  }
}

const ADDRESS_SHAPE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const APP_PASSWORD_SHAPE = /^[A-Za-z0-9]{16}$/;

/**
 * @description Parse the stored secret against its closed schema: exactly "address:app-password",
 * split on the FIRST colon. The address must be a plain mailbox address; the app password is the
 * 16-character value Yahoo generates (spaces in a pasted grouped form are removed). Anything else
 * — a host, a port, JSON, control characters, a second field — is refused, so nothing but these
 * two values can ever reach the IMAP session.
 * @param secret - The decrypted connector secret.
 * @returns The credential pair, or null when it does not match the schema.
 */
export function parseYahooSecret(secret: unknown): YahooCredentials | null {
  if (typeof secret !== 'string') return null;
  const i = secret.indexOf(':');
  if (i < 1) return null;
  const address = secret.slice(0, i).trim().toLowerCase();
  const appPassword = secret.slice(i + 1).replace(/ /g, '');
  if (address.length > ADDRESS_MAX || !ADDRESS_SHAPE.test(address)) return null;
  if (!APP_PASSWORD_SHAPE.test(appPassword)) return null;
  return { address, appPassword };
}

/** Clamp a requested row count into 1..IMAP_MAX_MESSAGES (default 25). */
function clampLimit(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : DEFAULT_MESSAGES, 1), IMAP_MAX_MESSAGES);
}

/** One display-safe text fragment: no CR/LF, no quote or angle bracket, bounded. */
function clean(value: unknown, max = TEXT_MAX): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim().slice(0, max);
}

/** An envelope address as the `Name <address>` form the Gmail From header uses. */
function formatAddress(value: MessageAddressObject | undefined): string {
  const name = clean(value?.name, 200);
  const address = clean(value?.address, ADDRESS_MAX);
  if (name && address && name.toLowerCase() !== address.toLowerCase()) return `${name} <${address}>`;
  return address || name;
}

/** A Date or date string as ISO, or ''. */
function isoOf(value: unknown): string {
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/**
 * @description Map one fetched IMAP message onto MailSummary. `unread` is the absence of \Seen,
 * `starred` is \Flagged, `important` is the $Important keyword; the id is the message UID.
 * No body is fetched, so the snippet is empty.
 * @param message - The imapflow fetch result (uid, flags, envelope, internalDate).
 * @returns The bounded metadata summary.
 */
export function normalizeImapMessage(message: FetchMessageObject): ImapMailSummary {
  const flags = message.flags instanceof Set ? message.flags : new Set<string>();
  const receivedAt = isoOf(message.internalDate) || isoOf(message.envelope?.date);
  const unread = !flags.has('\\Seen');
  const important = flags.has('$Important');
  const starred = flags.has('\\Flagged');
  return {
    id: String(message.uid ?? message.seq ?? ''),
    from: formatAddress(message.envelope?.from?.[0]),
    subject: clean(message.envelope?.subject) || '(no subject)',
    date: receivedAt,
    internalDate: receivedAt ? String(Date.parse(receivedAt)) : '',
    receivedAt,
    snippet: '',
    unread,
    important,
    starred,
    providerFlags: { unread, important, starred },
  };
}

/** A client for one session: fixed options, no compression/ENABLE/IDLE, bounded timeouts, no log sink. */
function openClient(credentials: YahooCredentials, endpoint: ImapEndpoint): ImapFlow {
  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: { user: credentials.address, pass: credentials.appPassword },
    logger: false,
    disableCompression: true,
    disableAutoEnable: true,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
  // imapflow emits socket failures as 'error' events; an unhandled one would crash the process.
  client.on('error', (err: Error) => logger.error({ err: { name: err.name, message: err.message } }, 'IMAP session error'));
  return client;
}

/** Log in, run `work`, always log out; a refused LOGIN becomes ImapAuthenticationError. */
async function withSession<T>(credentials: YahooCredentials, endpoint: ImapEndpoint, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = openClient(credentials, endpoint);
  try {
    await client.connect();
  } catch (err) {
    if ((err as { authenticationFailed?: boolean }).authenticationFailed) throw new ImapAuthenticationError();
    throw err;
  }
  try {
    return await work(client);
  } finally {
    await client.logout().catch((err: Error) => logger.error({ err: { name: err.name, message: err.message } }, 'IMAP logout failed'));
  }
}

/**
 * @description Read the newest messages of INBOX, read-only: EXAMINE, then one FETCH of UID,
 * FLAGS, ENVELOPE and INTERNALDATE over exactly the last `limit` sequence numbers. No body part,
 * no STORE, no EXPUNGE.
 * @param credentials - The caller's validated Yahoo credential pair.
 * @param limit - Rows wanted (clamped to 1..IMAP_MAX_MESSAGES).
 * @param endpoint - Session endpoint (YAHOO_IMAP_ENDPOINT outside tests).
 * @returns Normalized summaries, newest first.
 */
export async function readImapInbox(
  credentials: YahooCredentials, limit: unknown, endpoint: ImapEndpoint = YAHOO_IMAP_ENDPOINT,
): Promise<ImapMailSummary[]> {
  const max = clampLimit(limit);
  return withSession(credentials, endpoint, async (client) => {
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    const exists = Number(box.exists) || 0;
    if (exists < 1) return [];
    const range = `${Math.max(1, exists - max + 1)}:${exists}`;
    const rows: ImapMailSummary[] = [];
    for await (const message of client.fetch(range, { uid: true, flags: true, envelope: true, internalDate: true })) {
      rows.push(normalizeImapMessage(message));
    }
    return rows.sort((a, b) => (Number(b.internalDate) || 0) - (Number(a.internalDate) || 0)).slice(0, max);
  });
}

/**
 * @description Connect-time validation for the `yahoo` token connector: parse the pasted secret
 * against the closed schema and prove it with a real LOGIN on the fixed endpoint (then LOGOUT).
 * A malformed secret opens no socket.
 * @param secret - The pasted "address:app-password" secret.
 * @param endpoint - Session endpoint (YAHOO_IMAP_ENDPOINT outside tests).
 * @returns The account address when the LOGIN succeeded, else null.
 */
export async function probeYahooLogin(secret: string, endpoint: ImapEndpoint = YAHOO_IMAP_ENDPOINT): Promise<string | null> {
  const credentials = parseYahooSecret(secret);
  if (!credentials) return null;
  try {
    await withSession(credentials, endpoint, async () => undefined);
    return credentials.address;
  } catch (err) {
    logger.error({ err: { name: (err as Error).name, message: (err as Error).message } }, 'Yahoo IMAP login probe failed');
    return null;
  }
}

/** Resolve the caller's personal secret, or the status explaining why there is none. */
async function resolveCredentials(
  pool: Pool, userSub: string, getAccessToken: NonNullable<ImapMailReaderDependencies['getAccessToken']>,
): Promise<YahooCredentials | ImapMailStatus> {
  let secret: string | null;
  try {
    secret = await getAccessToken(pool, userSub, 'yahoo', { tenantId: 'personal' });
  } catch (err) {
    logger.error({ err }, 'Yahoo connection could not be decrypted');
    return 'unavailable';
  }
  if (!secret) return 'not_connected';
  return parseYahooSecret(secret) ?? 'reconnect_required';
}

/**
 * @description Build the fixed Yahoo inbox read exposed to trusted packages as AppContext
 * `imapMail`. It reads only the authenticated caller's PERSONAL `yahoo` grant (a household-shared
 * row is never selected), and results are live and never persisted.
 * @param pool - Postgres pool for connector selection and secret decryption.
 * @param dependencies - Test seams (broker double, loopback endpoint); production passes none.
 * @returns The reader.
 */
export function createImapMailReader(pool: Pool, dependencies: ImapMailReaderDependencies = {}): ImapMailReader {
  const getAccessToken = dependencies.getAccessToken ?? getValidAccessToken;
  const endpoint = dependencies.endpoint ?? YAHOO_IMAP_ENDPOINT;
  return async (input: ImapMailListInput): Promise<ImapMailListResult> => {
    const started = Date.now();
    const userSub = String(input?.userSub ?? '').trim().slice(0, 512);
    if (!userSub) return { status: 'not_connected', messages: [] };
    const credentials = await resolveCredentials(pool, userSub, getAccessToken);
    if (typeof credentials === 'string') return { status: credentials, messages: [] };
    try {
      const messages = await readImapInbox(credentials, input.limit, endpoint);
      logger.info({ rows: messages.length, durationMs: Date.now() - started }, 'Yahoo inbox read');
      return { status: 'connected', messages };
    } catch (err) {
      if (err instanceof ImapAuthenticationError) return { status: 'reconnect_required', messages: [] };
      logger.error({ err: { name: (err as Error).name, message: (err as Error).message } }, 'Yahoo inbox read failed');
      return { status: 'unavailable', messages: [] };
    }
  };
}
