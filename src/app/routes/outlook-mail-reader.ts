/**
 * Privacy-bounded Outlook message reader for trusted in-process application packages.
 *
 * This is deliberately a fixed operation rather than a Graph proxy. A package supplies the
 * authenticated user plus a bounded set of already-authorized CRM addresses; core selects that
 * user's personal Outlook grant, searches Microsoft Graph, validates the participants again, and
 * returns only display-safe metadata. Tokens, full message bodies/body HTML, mailbox identity,
 * and unrelated recipient lists never cross the AppContext boundary; a bounded bodyPreview does.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add actor-mailbox-only Outlook participant search for installed CRM packages.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add the fixed recent-mail sync read (CR-22 auto email logging): a time-cursor page of the user's mailbox, matched IN CORE against the package's authorized address set, so unmatched mail and unrelated recipients still never cross the AppContext boundary. Returns display-safe metadata plus internetMessageId for cross-mailbox dedup.
 * -----------------------------------------------------------------------------
 *
 * @module outlook-mail-reader
 */

import type { Pool } from 'pg';
import { getValidAccessToken } from './connector-account-operations';
import { accessibleConnections, type ConnectionRow, type ConnectionSelector } from './connector-tenancy';

const GRAPH_MESSAGES_URL = 'https://graph.microsoft.com/v1.0/me/messages';
const MAX_MATCH_ADDRESSES = 8;
const MAX_RESULTS = 50;
const GRAPH_SELECT = [
  'id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'bccRecipients',
  'receivedDateTime', 'sentDateTime', 'bodyPreview', 'isRead', 'isDraft', 'webLink',
].join(',');
const GRAPH_SYNC_SELECT = `${GRAPH_SELECT},internetMessageId`;
/** Sync matching happens locally in core, so the address book can be the whole CRM. */
const MAX_SYNC_ADDRESSES = 20000;
const MAX_SYNC_RESULTS = 50;
/** A sync cursor older than this is clamped — first runs must not walk years of mailbox. */
const MAX_SYNC_LOOKBACK_MS = 30 * 24 * 3600 * 1000;

export type OutlookMailStatus =
  | 'connected'
  | 'not_connected'
  | 'missing_scope'
  | 'reconnect_required'
  | 'unavailable';

export interface OutlookMailAddress {
  name?: string;
  address: string;
}

export interface OutlookMailSummary {
  id: string;
  subject: string;
  sentAt: string;
  direction: 'inbound' | 'outbound';
  preview: string;
  webUrl?: string;
  isRead?: boolean;
  counterpart: OutlookMailAddress;
  matchedAddress: string;
}

export interface OutlookMailSearchInput {
  userSub: string;
  /** Verified login email from the current request, when the identity provider supplies it. */
  loginEmail?: string | null;
  /** Addresses read from a CRM record after that package has enforced record authorization. */
  matchAddresses: string[];
  limit?: number;
}

export interface OutlookMailSearchResult {
  status: OutlookMailStatus;
  emails: OutlookMailSummary[];
}

export type OutlookMailReader = (input: OutlookMailSearchInput) => Promise<OutlookMailSearchResult>;

export interface OutlookMailSyncInput {
  userSub: string;
  /** Verified login email when available; a background call without one may only use a SOLE personal grant. */
  loginEmail?: string | null;
  /** ISO time cursor — only messages received at/after this instant are considered. */
  sinceIso: string;
  /** The package's full authorized address book; matching happens inside core. */
  matchAddresses: string[];
  limit?: number;
}

export interface OutlookMailSyncMessage {
  id: string;
  /** RFC internet message id — stable across every mailbox that holds the message. */
  internetMessageId: string | null;
  subject: string;
  sentAt: string;
  receivedAt: string;
  direction: 'inbound' | 'outbound';
  preview: string;
  counterpart: OutlookMailAddress;
  /** Every CRM address that appears among the participants (the package files per address). */
  matchedAddresses: string[];
  webUrl?: string;
}

export interface OutlookMailSyncResult {
  status: OutlookMailStatus;
  messages: OutlookMailSyncMessage[];
  /** Newest receivedDateTime seen in the fetched page (matched or not) — the next cursor. */
  latestReceivedAt: string | null;
}

export type OutlookMailSyncReader = (input: OutlookMailSyncInput) => Promise<OutlookMailSyncResult>;

type AccessTokenResolver = (
  pool: Pool, userSub: string, provider: string, opts?: ConnectionSelector,
) => Promise<string | null>;

interface OutlookMailReaderDependencies {
  listConnections?: (pool: Pool, userSub: string, provider: string) => Promise<ConnectionRow[]>;
  getAccessToken?: AccessTokenResolver;
  fetchImpl?: typeof fetch;
}

interface GraphEmailAddress {
  emailAddress?: { name?: unknown; address?: unknown };
}

interface GraphMessage {
  id?: unknown;
  subject?: unknown;
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  bccRecipients?: GraphEmailAddress[];
  receivedDateTime?: unknown;
  sentDateTime?: unknown;
  bodyPreview?: unknown;
  isRead?: unknown;
  isDraft?: unknown;
  webLink?: unknown;
  internetMessageId?: unknown;
}

class GraphRequestError extends Error {
  constructor(readonly status: number) {
    super(`Microsoft Graph request failed (${status})`);
  }
}

/** Normalize and validate an SMTP address before it can enter a Graph search expression. */
function normalizeAddress(value: unknown): string | null {
  const address = String(value ?? '').trim().toLowerCase();
  if (address.length < 3 || address.length > 254) return null;
  if (!/^[^\s@"'<>(),;:\\]+@[^\s@"'<>(),;:\\]+\.[^\s@"'<>(),;:\\]+$/.test(address)) return null;
  return address;
}

/** A delegated Mail.Read grant is required; login-only openid/profile scopes are insufficient. */
function hasMailReadScope(scopes: string | null): boolean {
  return String(scopes ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .some((scope) => scope === 'mail.read' || scope.endsWith('/mail.read'));
}

/** Select only a personal grant belonging to this user; shared tenant connectors are excluded. */
function selectActorMailbox(rows: ConnectionRow[], loginEmail?: string | null): ConnectionRow | null {
  const personal = rows.filter((row) => row.tenant_id == null);
  const assertedEmail = String(loginEmail ?? '').trim();
  const verifiedEmail = normalizeAddress(loginEmail);
  if (assertedEmail && !verifiedEmail) return null;
  if (verifiedEmail) {
    const exact = personal.filter((row) => normalizeAddress(row.account_email) === verifiedEmail);
    return exact.length === 1 ? exact[0] : null;
  }
  // A service call without a verified email may use the sole personal grant, but must never guess
  // among multiple mailboxes. This keeps background/internal calls fail-closed.
  return personal.length === 1 ? personal[0] : null;
}

function boundedText(value: unknown, max: number, fallback = ''): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return text || fallback;
}

function graphAddress(value: GraphEmailAddress | undefined): OutlookMailAddress | null {
  const address = normalizeAddress(value?.emailAddress?.address);
  if (!address) return null;
  const name = boundedText(value?.emailAddress?.name, 160);
  return name ? { name, address } : { address };
}

function participants(message: GraphMessage): OutlookMailAddress[] {
  const candidates = [
    message.from,
    ...(Array.isArray(message.toRecipients) ? message.toRecipients : []),
    ...(Array.isArray(message.ccRecipients) ? message.ccRecipients : []),
    ...(Array.isArray(message.bccRecipients) ? message.bccRecipients : []),
  ];
  return candidates.map(graphAddress).filter((item): item is OutlookMailAddress => item !== null);
}

/** Graph webLink is optional and remains clickable only on Microsoft's Outlook HTTPS hosts. */
function safeOutlookWebLink(value: unknown): string | undefined {
  try {
    const url = new URL(String(value ?? ''));
    const host = url.hostname.toLowerCase();
    const allowed = host === 'outlook.office.com' || host.endsWith('.outlook.office.com')
      || host === 'outlook.office365.com' || host.endsWith('.outlook.office365.com')
      || host === 'outlook.live.com' || host.endsWith('.outlook.live.com');
    return url.protocol === 'https:' && allowed ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function summarizeMessage(
  message: GraphMessage,
  mailboxAddress: string,
  matchSet: Set<string>,
): OutlookMailSummary | null {
  // /me/messages spans every folder, including Drafts. Unsent drafts are not customer
  // correspondence and must never appear as outbound activity.
  if (message.isDraft === true) return null;
  const id = boundedText(message.id, 512);
  if (!id) return null;
  const from = graphAddress(message.from);
  const matchedParticipants = participants(message).filter((item) => matchSet.has(item.address));
  // `$search` is a provider-side optimization, never the authorization/filter boundary. Graph can
  // tokenize or broaden search expressions; an exact participant match is mandatory here.
  if (matchedParticipants.length === 0) return null;
  const direction = from?.address === mailboxAddress ? 'outbound' : 'inbound';
  // For inbound group mail, the partner may be TO/CC while an unrelated person is the actual
  // sender. Keep display semantics truthful: counterpart is who sent/received; matchedAddress is
  // independently the CRM address that caused inclusion.
  const counterpart = direction === 'inbound' ? (from || matchedParticipants[0]) : matchedParticipants[0];
  const sentAt = boundedText(message.sentDateTime || message.receivedDateTime, 64);
  const row: OutlookMailSummary = {
    id,
    subject: boundedText(message.subject, 300, '(no subject)'),
    sentAt,
    direction,
    preview: boundedText(message.bodyPreview, 500),
    counterpart,
    matchedAddress: matchedParticipants[0].address,
  };
  if (typeof message.isRead === 'boolean') row.isRead = message.isRead;
  const webUrl = safeOutlookWebLink(message.webLink);
  if (webUrl) row.webUrl = webUrl;
  return row;
}

function graphSearchUrl(addresses: string[], top: number): string {
  const query = new URLSearchParams();
  // Microsoft Graph message search supports the participants property across from/to/cc/bcc.
  // Address validation above makes each term a literal SMTP value, not caller-controlled KQL.
  // One OR query avoids an eight-request rate spike and gives one coherent newest-first window.
  query.set('$search', addresses.map((address) => `"participants:${address}"`).join(' OR '));
  query.set('$top', String(top));
  query.set('$select', GRAPH_SELECT);
  return `${GRAPH_MESSAGES_URL}?${query.toString()}`;
}

async function searchAddresses(
  token: string,
  addresses: string[],
  top: number,
  fetchImpl: typeof fetch,
): Promise<GraphMessage[]> {
  const response = await fetchImpl(graphSearchUrl(addresses, top), {
    headers: {
      Authorization: `Bearer ${token}`,
      ConsistencyLevel: 'eventual',
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new GraphRequestError(response.status);
  const payload = await response.json() as { value?: unknown };
  return Array.isArray(payload.value) ? payload.value as GraphMessage[] : [];
}

function empty(status: OutlookMailStatus): OutlookMailSearchResult {
  return { status, emails: [] };
}

/**
 * Build the fixed Outlook read operation exposed to trusted application packages.
 *
 * Results are live and deliberately not persisted: silently copying mailbox content into CRM
 * storage would create retention, deletion, and cross-owner obligations beyond a display filter.
 */
export function createOutlookMailReader(
  pool: Pool,
  dependencies: OutlookMailReaderDependencies = {},
): OutlookMailReader {
  const listConnections = dependencies.listConnections ?? accessibleConnections;
  const getAccessToken = dependencies.getAccessToken ?? getValidAccessToken;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return async (input: OutlookMailSearchInput): Promise<OutlookMailSearchResult> => {
    const userSub = boundedText(input?.userSub, 512);
    if (!userSub) return empty('not_connected');
    const rows = await listConnections(pool, userSub, 'outlook');
    const connection = selectActorMailbox(rows, input.loginEmail);
    if (!connection) return empty('not_connected');
    if (!hasMailReadScope(connection.scopes)) return empty('missing_scope');

    const mailboxAddress = normalizeAddress(connection.account_email) || normalizeAddress(input.loginEmail) || '';
    const addresses = [...new Set((Array.isArray(input.matchAddresses) ? input.matchAddresses : [])
      .map(normalizeAddress)
      // A poisoned/mistyped CRM row containing the rep's own address must not become an
      // accidental "match my whole mailbox" query.
      .filter((address): address is string => address !== null && address !== mailboxAddress))]
      .slice(0, MAX_MATCH_ADDRESSES);
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), MAX_RESULTS);

    let token: string | null;
    try {
      token = await getAccessToken(pool, userSub, 'outlook', {
        tenantId: 'personal', connectionId: connection.connection_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return empty(/^refresh\s+(400|401|403)\b/i.test(message) ? 'reconnect_required' : 'unavailable');
    }
    if (!token) return empty('reconnect_required');
    if (addresses.length === 0) return empty('connected');

    let graphRows: GraphMessage[];
    try {
      // One bounded, read-only OR search; no arbitrary URL or query leaves this module.
      graphRows = await searchAddresses(token, addresses, limit, fetchImpl);
    } catch (error) {
      if (error instanceof GraphRequestError && (error.status === 401 || error.status === 403)) {
        return empty('reconnect_required');
      }
      return empty('unavailable');
    }

    const matchSet = new Set(addresses);
    const deduped = new Map<string, OutlookMailSummary>();
    for (const message of graphRows) {
      const summary = summarizeMessage(message, mailboxAddress, matchSet);
      if (summary && !deduped.has(summary.id)) deduped.set(summary.id, summary);
    }
    const emails = [...deduped.values()]
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
      .slice(0, limit);
    return { status: 'connected', emails };
  };
}

/** Validate + clamp the sync cursor: parseable, never older than the max lookback, never future. */
function normalizeSinceIso(value: unknown): string | null {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return null;
  const floor = Date.now() - MAX_SYNC_LOOKBACK_MS;
  return new Date(Math.min(Math.max(parsed, floor), Date.now())).toISOString();
}

function graphRecentUrl(sinceIso: string, top: number): string {
  const query = new URLSearchParams();
  // normalizeSinceIso produced a literal ISO instant — nothing caller-controlled enters OData.
  query.set('$filter', `receivedDateTime ge ${sinceIso}`);
  query.set('$orderby', 'receivedDateTime desc');
  query.set('$top', String(top));
  query.set('$select', GRAPH_SYNC_SELECT);
  return `${GRAPH_MESSAGES_URL}?${query.toString()}`;
}

/** A recent message becomes a sync row ONLY when a CRM address participates; drafts never do. */
function summarizeSyncMessage(
  message: GraphMessage,
  mailboxAddress: string,
  matchSet: Set<string>,
): OutlookMailSyncMessage | null {
  if (message.isDraft === true) return null;
  const id = boundedText(message.id, 512);
  if (!id) return null;
  const from = graphAddress(message.from);
  const matched = [...new Set(
    participants(message).filter((item) => matchSet.has(item.address)).map((item) => item.address),
  )];
  if (matched.length === 0) return null;
  const direction = from?.address === mailboxAddress ? 'outbound' : 'inbound';
  const firstMatch = participants(message).find((item) => matchSet.has(item.address)) as OutlookMailAddress;
  const counterpart = direction === 'inbound' ? (from || firstMatch) : firstMatch;
  const internetMessageId = boundedText(message.internetMessageId, 512) || null;
  const row: OutlookMailSyncMessage = {
    id,
    internetMessageId,
    subject: boundedText(message.subject, 300, '(no subject)'),
    sentAt: boundedText(message.sentDateTime || message.receivedDateTime, 64),
    receivedAt: boundedText(message.receivedDateTime || message.sentDateTime, 64),
    direction,
    preview: boundedText(message.bodyPreview, 500),
    counterpart,
    matchedAddresses: matched,
  };
  const webUrl = safeOutlookWebLink(message.webLink);
  if (webUrl) row.webUrl = webUrl;
  return row;
}

async function fetchRecent(
  token: string,
  sinceIso: string,
  top: number,
  fetchImpl: typeof fetch,
): Promise<GraphMessage[]> {
  const response = await fetchImpl(graphRecentUrl(sinceIso, top), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new GraphRequestError(response.status);
  const payload = await response.json() as { value?: unknown };
  return Array.isArray(payload.value) ? payload.value as GraphMessage[] : [];
}

function emptySync(status: OutlookMailStatus): OutlookMailSyncResult {
  return { status, messages: [], latestReceivedAt: null };
}

/**
 * @description Build the fixed recent-mail sync read (CR-22 auto email logging). One bounded
 * time-cursor page of the actor's mailbox; matching against the package-authorized address set
 * happens HERE, so unmatched mail and unrelated recipient lists never leave core. The result is
 * the same display-safe DTO discipline as the participant search, plus internetMessageId so the
 * package can dedupe one message seen from several reps' mailboxes.
 * @param pool - Postgres pool for connector selection/token resolution.
 * @param dependencies - Injectable seams for tests.
 * @returns The sync reader exposed on AppContext.
 */
export function createOutlookMailSyncReader(
  pool: Pool,
  dependencies: OutlookMailReaderDependencies = {},
): OutlookMailSyncReader {
  const listConnections = dependencies.listConnections ?? accessibleConnections;
  const getAccessToken = dependencies.getAccessToken ?? getValidAccessToken;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  return async (input: OutlookMailSyncInput): Promise<OutlookMailSyncResult> => {
    const userSub = boundedText(input?.userSub, 512);
    if (!userSub) return emptySync('not_connected');
    const sinceIso = normalizeSinceIso(input?.sinceIso);
    if (!sinceIso) return emptySync('unavailable');
    const rows = await listConnections(pool, userSub, 'outlook');
    const connection = selectActorMailbox(rows, input.loginEmail);
    if (!connection) return emptySync('not_connected');
    if (!hasMailReadScope(connection.scopes)) return emptySync('missing_scope');

    const mailboxAddress = normalizeAddress(connection.account_email) || normalizeAddress(input.loginEmail) || '';
    const matchSet = new Set((Array.isArray(input.matchAddresses) ? input.matchAddresses : [])
      .slice(0, MAX_SYNC_ADDRESSES)
      .map(normalizeAddress)
      .filter((address): address is string => address !== null && address !== mailboxAddress));
    if (matchSet.size === 0) return emptySync('connected');
    const limit = Math.min(Math.max(Number(input.limit) || MAX_SYNC_RESULTS, 1), MAX_SYNC_RESULTS);

    let token: string | null;
    try {
      token = await getAccessToken(pool, userSub, 'outlook', {
        tenantId: 'personal', connectionId: connection.connection_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return emptySync(/^refresh\s+(400|401|403)\b/i.test(message) ? 'reconnect_required' : 'unavailable');
    }
    if (!token) return emptySync('reconnect_required');

    let graphRows: GraphMessage[];
    try {
      graphRows = await fetchRecent(token, sinceIso, limit, fetchImpl);
    } catch (error) {
      if (error instanceof GraphRequestError && (error.status === 401 || error.status === 403)) {
        return emptySync('reconnect_required');
      }
      return emptySync('unavailable');
    }

    let latestReceivedAt: string | null = null;
    for (const message of graphRows) {
      const receivedAt = boundedText(message.receivedDateTime, 64);
      if (receivedAt && (!latestReceivedAt || Date.parse(receivedAt) > Date.parse(latestReceivedAt))) {
        latestReceivedAt = receivedAt;
      }
    }
    const deduped = new Map<string, OutlookMailSyncMessage>();
    for (const message of graphRows) {
      const summary = summarizeSyncMessage(message, mailboxAddress, matchSet);
      if (summary && !deduped.has(summary.id)) deduped.set(summary.id, summary);
    }
    return { status: 'connected', messages: [...deduped.values()], latestReceivedAt };
  };
}

// Pure helpers exported for focused boundary tests.
export const outlookMailReaderInternals = {
  normalizeAddress,
  hasMailReadScope,
  selectActorMailbox,
  graphSearchUrl,
  summarizeMessage,
  safeOutlookWebLink,
  normalizeSinceIso,
  graphRecentUrl,
  summarizeSyncMessage,
};
