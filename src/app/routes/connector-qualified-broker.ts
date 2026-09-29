/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add an inactive exact-personal-row broker using request identity, qualified crypto, refresh CAS and post-await revalidation. No legacy/provider implementation or readiness activation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Declare the terminating refusal function explicitly so TypeScript narrows validated row fields and optional refresh inputs without casts or weaker guards.
 */
import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity, isSystemIdentity } from '@/shared/services/database/request-identity';
import { withQualifiedConnectorSession, QualifiedConnectorSessionError,
  type QualifiedConnectorSessionClient, type QualifiedConnectorSessionPool } from './connector-qualified-session';
import {
  decryptQualifiedConnectorToken, encryptQualifiedConnectorToken,
  QUALIFIED_CONNECTOR_TOKEN_PREFIX,
  type QualifiedConnectorPrincipal, type QualifiedConnectorQueryable,
} from './connector-qualified-token-crypto';

const log = createChildLogger({ module: 'connector-qualified-broker' });
const MAX_REVISION = 9_223_372_036_854_775_807n;
const FIELDS = 'connection_id, principal_issuer, owner_sub, provider, account_key, status, revision, access_token, refresh_token, expiry, created_at';
const SCOPE = 'principal_issuer=$1 AND owner_sub=$2 AND connection_id=$3 AND provider=$4 AND revision=$5 AND status=\'connected\'';

/** Already request-bound GUC client; the broker never stamps or manufactures database identity. */
export type QualifiedConnectorBrokerClient = QualifiedConnectorSessionClient;
/** Existing GUC pool contract: each query is fresh, and connect supplies a dedicated bound client. */
export interface QualifiedConnectorBrokerDatabase extends QualifiedConnectorQueryable, QualifiedConnectorSessionPool {}
/** Selection comes from a trusted server operation; a revision is never inferred from an arbitrary default. */
export interface QualifiedPersonalSelection {
  readonly connectionId: string;
  readonly provider: string;
  readonly expectedRevision: string;
}
/** Only a fixed controller operation may consume this plaintext; never serialize it to a browser/model. */
export interface QualifiedPersonalCredential {
  readonly accessToken: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly revision: string;
  readonly expiresAt: string | null;
}
/** Trusted provider adapter input. No request-supplied URL, client secret or environment credential. */
export interface QualifiedConnectorRefreshInput {
  readonly principal: QualifiedConnectorPrincipal;
  readonly connectionId: string;
  readonly provider: string;
  readonly revision: string;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
}
/** Omitted refresh token preserves only this exact qualified row's existing refresh token. */
export interface QualifiedConnectorRefreshResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: string;
}
export type QualifiedConnectorRefreshPort = (input: QualifiedConnectorRefreshInput) => Promise<QualifiedConnectorRefreshResult>;
export interface QualifiedConnectorBrokerOptions {
  readonly refresh?: QualifiedConnectorRefreshPort;
  readonly signal?: AbortSignal;
}
export type QualifiedCredentialRefusal = 'invalid_input' | 'not_authorized' | 'not_found_or_stale'
  | 'refresh_unavailable' | 'refresh_failed' | 'storage_failure' | 'aborted';

/** Fixed-code refusal with no SQL, provider message, owner identity, token or ciphertext attached. */
export class QualifiedCredentialUnavailableError extends Error {
  constructor(readonly code: QualifiedCredentialRefusal) {
    super('Qualified personal credential unavailable: ' + code);
    this.name = 'QualifiedCredentialUnavailableError';
  }
}

interface Context {
  readonly principal: QualifiedConnectorPrincipal;
  readonly selection: QualifiedPersonalSelection;
  readonly signal?: AbortSignal;
  readonly refresh?: QualifiedConnectorRefreshPort;
}
interface Snapshot {
  readonly revision: string;
  readonly accountKey: string;
  readonly access: string;
  readonly refresh: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

function refuse(code: QualifiedCredentialRefusal): never { throw new QualifiedCredentialUnavailableError(code); }

/** Reject ambiguity; do not turn a padded/canonicalized identity into a different principal. */
function exactText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, 'utf8') <= max
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

/** BIGINT revisions remain exact strings even beyond JavaScript's safe integer range. */
function validRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= MAX_REVISION;
}

/** Copy every caller-controlled input before the first await, retaining exact issuer spelling. */
function context(principal: QualifiedConnectorPrincipal, selection: QualifiedPersonalSelection, options: QualifiedConnectorBrokerOptions): Context {
  if (!exactText(principal?.sub, 1024) || !exactText(principal?.principalIssuer, 2048)
    || typeof selection?.connectionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(selection.connectionId)
    || typeof selection?.provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/u.test(selection.provider)
    || !validRevision(selection?.expectedRevision) || (options.refresh !== undefined && typeof options.refresh !== 'function')) refuse('invalid_input');
  return { principal: Object.freeze({ sub: principal.sub, principalIssuer: principal.principalIssuer }),
    selection: Object.freeze({ ...selection }), signal: options.signal, refresh: options.refresh };
}

/** Existing authenticated request context is mandatory, including after each external await. */
function active(ctx: Context): void {
  if (ctx.signal?.aborted) refuse('aborted');
  const identity = getRequestIdentity();
  if (!identity || isSystemIdentity(identity) || identity.isOperator !== false || identity.sub !== ctx.principal.sub
    || identity.principalIssuer !== ctx.principal.principalIssuer) refuse('not_authorized');
}

const params = (ctx: Context, revision: string): unknown[] =>
  [ctx.principal.principalIssuer, ctx.principal.sub, ctx.selection.connectionId, ctx.selection.provider, revision];

/** Timestamp strings from ports must be canonical UTC ISO; PostgreSQL timestamps normally arrive as Dates. */
function timestamp(value: unknown): string {
  const millis = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) refuse('not_found_or_stale');
  const iso = new Date(millis).toISOString();
  if (typeof value === 'string' && value !== iso) refuse('not_found_or_stale');
  return iso;
}

/** Validate returned identity as well as SQL scope, so a broken adapter cannot retarget a ciphertext. */
function snapshot(ctx: Context, row: Record<string, unknown>, revision: string): Snapshot {
  if (row.connection_id !== ctx.selection.connectionId || row.principal_issuer !== ctx.principal.principalIssuer
    || row.owner_sub !== ctx.principal.sub || row.provider !== ctx.selection.provider || row.revision !== revision
    || row.status !== 'connected' || !exactText(row.account_key, 2048)
    || typeof row.access_token !== 'string' || !row.access_token.startsWith(QUALIFIED_CONNECTOR_TOKEN_PREFIX)
    || (row.refresh_token !== null && (typeof row.refresh_token !== 'string'
      || !row.refresh_token.startsWith(QUALIFIED_CONNECTOR_TOKEN_PREFIX)))) refuse('not_found_or_stale');
  return { revision, accountKey: row.account_key, access: row.access_token, refresh: row.refresh_token,
    expiresAt: row.expiry === null ? null : timestamp(row.expiry), createdAt: timestamp(row.created_at) };
}

/** A locking read is fresh-or-error even if a caller mistakenly supplied a repeatable-read client. */
async function read(db: QualifiedConnectorQueryable, ctx: Context, revision: string, lock: 'SHARE' | 'UPDATE' = 'SHARE'): Promise<Snapshot> {
  active(ctx);
  const result = await db.query('SELECT ' + FIELDS + ' FROM oshal_qualified_connections WHERE ' + SCOPE + ' FOR ' + lock, params(ctx, revision));
  active(ctx);
  if (result.rows.length !== 1) refuse('not_found_or_stale');
  return snapshot(ctx, result.rows[0], revision);
}

/** Full snapshot comparison also refuses delete/reinsert/replacement with an accidentally reused revision. */
function unchanged(before: Snapshot, after: Snapshot): void {
  if (before.revision !== after.revision || before.accountKey !== after.accountKey || before.access !== after.access
    || before.refresh !== after.refresh || before.expiresAt !== after.expiresAt || before.createdAt !== after.createdAt) refuse('not_found_or_stale');
}
const unexpired = (row: Snapshot): boolean => row.expiresAt === null || Date.parse(row.expiresAt) > Date.now();

/** Abort promptly during a hung refresh, consume late settlement, and never continue to persistence after abort. */
async function invokeRefresh(ctx: Context, row: Snapshot, refreshToken: string): Promise<QualifiedConnectorRefreshResult> {
  if (!ctx.refresh) refuse('refresh_unavailable');
  const refresh = ctx.refresh;
  active(ctx);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new QualifiedCredentialUnavailableError('aborted')); };
    const cleanup = () => ctx.signal?.removeEventListener('abort', abort);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) { abort(); return; }
    Promise.resolve().then(() => {
      active(ctx);
      return refresh(Object.freeze({ principal: ctx.principal, connectionId: ctx.selection.connectionId,
        provider: ctx.selection.provider, revision: row.revision, refreshToken, signal: ctx.signal }));
    }).then(result => { cleanup(); resolve(result); }, () => {
      cleanup(); reject(new QualifiedCredentialUnavailableError('refresh_failed'));
    });
  });
}

/** Validate and snapshot provider output; no caller-supplied expiry or empty/legacy replacement token is persisted. */
function refreshed(result: QualifiedConnectorRefreshResult): QualifiedConnectorRefreshResult {
  const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 65_536 && Buffer.from(value, 'utf8').toString('utf8') === value;
  if (!result || !validToken(result.accessToken) || (result.refreshToken !== undefined && !validToken(result.refreshToken))
    || typeof result.expiresAt !== 'string') refuse('refresh_failed');
  let expiry: string;
  try { expiry = timestamp(result.expiresAt); }
  catch { log.error({ err: new Error('Invalid qualified refresh expiry') }, 'qualified refresh refused'); return refuse('refresh_failed'); }
  if (Date.parse(expiry) <= Date.now()) refuse('refresh_failed');
  return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: expiry };
}

/** Encrypt and CAS only while the short transaction holds the exact selected row; never re-create a connection. */
async function writeRefresh(client: QualifiedConnectorBrokerClient, ctx: Context, before: Snapshot, result: QualifiedConnectorRefreshResult): Promise<Snapshot> {
  unchanged(before, await read(client, ctx, before.revision, 'UPDATE'));
  const access = await encryptQualifiedConnectorToken(client, ctx.principal, result.accessToken);
  unchanged(before, await read(client, ctx, before.revision, 'UPDATE'));
  const refresh = result.refreshToken === undefined ? before.refresh
    : await encryptQualifiedConnectorToken(client, ctx.principal, result.refreshToken);
  unchanged(before, await read(client, ctx, before.revision, 'UPDATE'));
  if (Date.parse(result.expiresAt) <= Date.now()) refuse('refresh_failed');
  const values = [...params(ctx, before.revision), access, refresh, result.expiresAt,
    before.access, before.refresh, before.expiresAt, before.accountKey, before.createdAt];
  const updated = await client.query('UPDATE oshal_qualified_connections SET access_token=$6, refresh_token=$7, expiry=$8 WHERE ' + SCOPE
    + ' AND access_token=$9 AND refresh_token IS NOT DISTINCT FROM $10 AND expiry IS NOT DISTINCT FROM $11'
    + ' AND account_key=$12 AND created_at=$13 RETURNING ' + FIELDS, values);
  active(ctx);
  if (updated.rows.length !== 1) refuse('not_found_or_stale');
  const after = snapshot(ctx, updated.rows[0], String(BigInt(before.revision) + 1n));
  if (after.access !== access || after.refresh !== refresh || after.expiresAt !== result.expiresAt
    || after.accountKey !== before.accountKey || after.createdAt !== before.createdAt) refuse('not_found_or_stale');
  unchanged(after, await read(client, ctx, after.revision, 'UPDATE'));
  return after;
}

/** Dedicated existing GUC client, short READ COMMITTED transaction; failed/ambiguous commits never return a token. */
async function persist(db: QualifiedConnectorBrokerDatabase, ctx: Context, before: Snapshot, result: QualifiedConnectorRefreshResult): Promise<Snapshot> {
  active(ctx);
  return withQualifiedConnectorSession(db, ctx.principal, client => writeRefresh(client, ctx, before, result), { signal: ctx.signal });
}

/** Refresh is outside any row-lock transaction; recheck after decrypt, adapter settlement, CAS and commit. */
async function refreshCredential(db: QualifiedConnectorBrokerDatabase, ctx: Context, before: Snapshot): Promise<QualifiedPersonalCredential> {
  if (!ctx.refresh || !before.refresh || BigInt(before.revision) === MAX_REVISION) refuse('refresh_unavailable');
  const token = await decryptQualifiedConnectorToken(db, ctx.principal, before.refresh);
  unchanged(before, await read(db, ctx, before.revision));
  const result = refreshed(await invokeRefresh(ctx, before, token));
  unchanged(before, await read(db, ctx, before.revision));
  const after = await persist(db, ctx, before, result);
  unchanged(after, await read(db, ctx, after.revision));
  if (!unexpired(after)) refuse('refresh_failed');
  return { accessToken: result.accessToken, connectionId: ctx.selection.connectionId, provider: ctx.selection.provider,
    revision: after.revision, expiresAt: after.expiresAt };
}

/**
 * @description Resolve exactly one authenticated personal credential, refusing stale selections and refresh races.
 * @param db Existing request-bound GUC pool. Do not supply an ambient caller-owned transaction.
 * @param principal Verified issuer/sub, required to match existing request identity; never guessed or stamped here.
 * @param selection Trusted UUID/provider/revision selection. No defaults, household, legacy or environment lookup.
 * @param options Trusted refresh adapter and optional caller abort signal; adapter implementations are separate.
 * @returns Controller-only plaintext at the final revalidation point, not permission to dispatch after later awaits.
 */
export async function resolveQualifiedPersonalCredential(
  db: QualifiedConnectorBrokerDatabase, principal: QualifiedConnectorPrincipal, selection: QualifiedPersonalSelection,
  options: QualifiedConnectorBrokerOptions = {},
): Promise<QualifiedPersonalCredential> {
  const started = Date.now();
  log.debug({ op: 'resolve' }, 'qualified broker started');
  try {
    const ctx = context(principal, selection, options);
    const before = await read(db, ctx, ctx.selection.expectedRevision);
    const result = unexpired(before) ? await currentCredential(db, ctx, before) : await refreshCredential(db, ctx, before);
    active(ctx);
    if (result.expiresAt !== null && Date.parse(result.expiresAt) <= Date.now()) refuse('not_found_or_stale');
    log.debug({ op: 'resolve', durationMs: Date.now() - started }, 'qualified broker completed');
    return result;
  } catch (error) {
    const failure = new QualifiedCredentialUnavailableError(error instanceof QualifiedCredentialUnavailableError
      || error instanceof QualifiedConnectorSessionError ? error.code : 'storage_failure');
    log.error({ op: 'resolve', durationMs: Date.now() - started, err: failure }, 'qualified broker refused');
    throw failure;
  }
}

/** Decrypt does not establish current authorization: a second fresh row check is mandatory before return. */
async function currentCredential(db: QualifiedConnectorBrokerDatabase, ctx: Context, before: Snapshot): Promise<QualifiedPersonalCredential> {
  const token = await decryptQualifiedConnectorToken(db, ctx.principal, before.access);
  unchanged(before, await read(db, ctx, before.revision));
  if (!unexpired(before)) refuse('not_found_or_stale');
  return { accessToken: token, connectionId: ctx.selection.connectionId, provider: ctx.selection.provider,
    revision: before.revision, expiresAt: before.expiresAt };
}
