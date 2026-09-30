/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist fresh issuer-qualified personal grants with exact-owner CAS and metadata-only results; callers own authentication, provider validation and transactions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve one exact owner-qualified UUID for server-owned reconnect/revoke targets without list-page guessing or credential selection.
 */
import { createChildLogger } from '@/shared/logger';
import {
  encryptQualifiedConnectorToken,
  type QualifiedConnectorPrincipal, type QualifiedConnectorQueryable,
} from './connector-qualified-token-crypto';

const log = createChildLogger({ module: 'connector-qualified-grants' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'connection_id, provider, account_key, status, revision::text AS revision, expiry, created_at, updated_at';
const OWNER = 'principal_issuer = $1 AND owner_sub = $2';
const EXACT = OWNER + ' AND connection_id = $3::uuid AND provider = $4 AND account_key = $5 AND revision = $6::bigint';

/** Provider verifier output supplied by trusted server code, never inferred from a legacy grant or email. */
export interface ValidatedQualifiedAccount { readonly provider: string; readonly accountKey: string }
/** Fresh credentials from the same verified ceremony; omission/null explicitly discards any old refresh token. */
export interface FreshQualifiedGrantInput {
  readonly validatedIdentity: ValidatedQualifiedAccount;
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresAt: string | null;
}
/** Exact target for a caller-authorized mutation; revisions are decimal strings, not lossy JS numbers. */
export interface QualifiedGrantTarget extends ValidatedQualifiedAccount {
  readonly connectionId: string;
  readonly expectedRevision: string;
}
/** Reconnection may not retarget the immutable provider/account tuple. */
export interface ReconnectFreshQualifiedGrantInput extends FreshQualifiedGrantInput {
  readonly connectionId: string;
  readonly expectedRevision: string;
}
/** Stable keyset pagination without exposing another principal or unbounded result sets. */
export interface QualifiedGrantListInput { readonly limit?: number; readonly afterConnectionId?: string }
/** UUID-only lookup; the server learns the immutable provider/account/revision from stored metadata. */
export interface QualifiedGrantLookupInput { readonly connectionId: string }
/** Public result allowlist: never include encrypted or plaintext credential material. */
export interface QualifiedGrantMetadata {
  readonly connectionId: string; readonly provider: string; readonly accountKey: string;
  readonly status: 'connected' | 'needs_reconnect' | 'revoked'; readonly revision: string;
  readonly expiresAt: string | null; readonly createdAt: string; readonly updatedAt: string;
}
/** Fixed outward failure codes contain no provider, SQL, identity or credential diagnostics. */
export type QualifiedGrantErrorCode = 'invalid_input' | 'conflict' | 'not_found_or_stale' | 'storage_failure';

class GrantFailure extends Error {
  constructor(readonly code: QualifiedGrantErrorCode) { super('qualified connector grant: ' + code); }
}
function refuse(code: QualifiedGrantErrorCode): never { throw new GrantFailure(code); }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > max || Buffer.from(value, 'utf8').toString('utf8') !== value) refuse('invalid_input');
  return value;
}
function principalSnapshot(value: QualifiedConnectorPrincipal): QualifiedConnectorPrincipal {
  if (!value || typeof value !== 'object') refuse('invalid_input');
  return { sub: text(value.sub, 1024), principalIssuer: text(value.principalIssuer, 2048) };
}
function accountSnapshot(value: ValidatedQualifiedAccount): ValidatedQualifiedAccount {
  if (!value || typeof value !== 'object') refuse('invalid_input');
  const provider = text(value.provider, 40), accountKey = text(value.accountKey, 2048);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider)) refuse('invalid_input');
  return { provider, accountKey };
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)
    || BigInt(value) > 9223372036854775807n) refuse('invalid_input');
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) refuse('invalid_input');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 65536
    || Buffer.from(value, 'utf8').toString('utf8') !== value) refuse('invalid_input');
  return value;
}
function freshExpiry(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value || Date.parse(value) <= Date.now()) refuse('invalid_input');
  return value;
}
function freshSnapshot(input: FreshQualifiedGrantInput): FreshQualifiedGrantInput {
  if (!input || typeof input !== 'object') refuse('invalid_input');
  const refresh = input.refreshToken;
  return { validatedIdentity: accountSnapshot(input.validatedIdentity), accessToken: token(input.accessToken),
    refreshToken: refresh === undefined || refresh === null ? null : token(refresh), expiresAt: freshExpiry(input.expiresAt) };
}
function targetSnapshot(value: QualifiedGrantTarget): QualifiedGrantTarget {
  if (!value || typeof value !== 'object') refuse('invalid_input');
  return { ...accountSnapshot(value), connectionId: uuid(value.connectionId), expectedRevision: revision(value.expectedRevision) };
}
function ownerValues(who: QualifiedConnectorPrincipal): unknown[] { return [who.principalIssuer, who.sub]; }
function targetValues(who: QualifiedConnectorPrincipal, target: QualifiedGrantTarget): unknown[] {
  return [...ownerValues(who), target.connectionId, target.provider, target.accountKey, target.expectedRevision];
}
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') refuse('storage_failure');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) refuse('storage_failure');
  return date.toISOString();
}
function metadata(row: Record<string, unknown>): QualifiedGrantMetadata {
  if (!['connected', 'needs_reconnect', 'revoked'].includes(String(row.status))) refuse('storage_failure');
  return { connectionId: uuid(row.connection_id), ...accountSnapshot({ provider: row.provider as string, accountKey: row.account_key as string }),
    status: row.status as QualifiedGrantMetadata['status'], revision: revision(row.revision),
    expiresAt: row.expiry === null ? null : timestamp(row.expiry), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) };
}
async function run<T>(operation: string, body: () => Promise<T>): Promise<T> {
  const start = Date.now();
  log.debug({ operation }, 'qualified grant start');
  try {
    const result = await body();
    log.debug({ operation, durationMs: Date.now() - start }, 'qualified grant complete');
    return result;
  } catch (error) {
    const safe = new GrantFailure(error instanceof GrantFailure ? error.code : 'storage_failure');
    log.error({ operation, err: safe, durationMs: Date.now() - start }, 'qualified grant refused');
    throw safe;
  }
}
async function encryptFresh(db: QualifiedConnectorQueryable, who: QualifiedConnectorPrincipal, fresh: FreshQualifiedGrantInput) {
  const access = await encryptQualifiedConnectorToken(db, who, fresh.accessToken);
  const refresh = fresh.refreshToken === null || fresh.refreshToken === undefined ? null
    : await encryptQualifiedConnectorToken(db, who, fresh.refreshToken);
  freshExpiry(fresh.expiresAt);
  return [access, refresh, fresh.expiresAt];
}

/**
 * @description Create only a new personal account. Caller must commit/roll back its already-bound transaction.
 * @param db Identity-bound transaction query port, never a pool that changes clients between calls.
 * @param principal Verified exact issuer/subject, supplied by server authentication.
 * @param input Fresh provider-validated account and credentials from the same ceremony.
 * @returns Allowlisted metadata, or a sanitized refusal; existing accounts are never overwritten.
 */
export function createFreshQualifiedGrant(db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal,
  input: FreshQualifiedGrantInput): Promise<QualifiedGrantMetadata> {
  return run('create', async () => {
    const who = principalSnapshot(principal), fresh = freshSnapshot(input);
    const values = [...ownerValues(who), fresh.validatedIdentity.provider, fresh.validatedIdentity.accountKey];
    const existing = await db.query(`SELECT connection_id FROM oshal_qualified_connections WHERE ${OWNER} AND provider = $3 AND account_key = $4`, values);
    if (existing.rows.length) refuse('conflict');
    const encrypted = await encryptFresh(db, who, fresh);
    const result = await db.query(`INSERT INTO oshal_qualified_connections
      (principal_issuer, owner_sub, provider, account_key, access_token, refresh_token, expiry)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (principal_issuer, owner_sub, provider, account_key) DO NOTHING RETURNING ${COLUMNS}`, [...values, ...encrypted]);
    if (result.rows.length !== 1) refuse('conflict');
    return metadata(result.rows[0]);
  });
}

/**
 * @description Replace an exact grant with freshly validated credentials, never coalescing an old refresh token.
 * @param db Already-bound caller-owned transaction; a lock spans encryption and CAS until caller completion.
 * @param principal Verified exact issuer/subject.
 * @param input Immutable account target, expected revision and fresh provider-verifier output.
 * @returns Metadata at the database-generated revision; absent/stale/foreign targets share one refusal.
 */
export function reconnectFreshQualifiedGrant(db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal,
  input: ReconnectFreshQualifiedGrantInput): Promise<QualifiedGrantMetadata> {
  return run('reconnect', async () => {
    const who = principalSnapshot(principal), fresh = freshSnapshot(input);
    const target = targetSnapshot({ ...fresh.validatedIdentity, connectionId: input.connectionId, expectedRevision: input.expectedRevision });
    const values = targetValues(who, target);
    const locked = await db.query(`SELECT connection_id FROM oshal_qualified_connections WHERE ${EXACT} FOR UPDATE`, values);
    if (locked.rows.length !== 1) refuse('not_found_or_stale');
    const encrypted = await encryptFresh(db, who, fresh);
    const result = await db.query(`UPDATE oshal_qualified_connections SET access_token = $7, refresh_token = $8, expiry = $9, status = 'connected'
      WHERE ${EXACT} RETURNING ${COLUMNS}`, [...values, ...encrypted]);
    if (result.rows.length !== 1) refuse('not_found_or_stale');
    return metadata(result.rows[0]);
  });
}

/**
 * @description Resolve exact personal grant metadata for server-owned ceremony/DELETE target selection.
 * @param db Already-bound caller transaction query port.
 * @param principal Verified exact issuer/subject.
 * @param input Connection UUID only; provider/account must not be guessed from browser input.
 * @returns Allowlisted metadata, or the same sanitized not_found_or_stale for foreign/missing UUIDs.
 */
export function getQualifiedGrant(db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal,
  input: QualifiedGrantLookupInput): Promise<QualifiedGrantMetadata> {
  return run('get', async () => {
    const who = principalSnapshot(principal);
    if (!input || typeof input !== 'object') refuse('invalid_input');
    const connectionId = uuid(input.connectionId);
    const result = await db.query(`SELECT ${COLUMNS} FROM oshal_qualified_connections WHERE ${OWNER} AND connection_id = $3::uuid`,
      [...ownerValues(who), connectionId]);
    if (result.rows.length !== 1) refuse('not_found_or_stale');
    return metadata(result.rows[0]);
  });
}

/**
 * @description List bounded personal metadata only, including explicit revoked/reconnect states and expiry.
 * @param db Already-bound caller transaction query port.
 * @param principal Verified exact issuer/subject.
 * @param input Optional UUID keyset cursor and limit (default 50, maximum 100).
 * @returns Allowlisted metadata; no token or ciphertext is selected or returned.
 */
export function listQualifiedGrants(db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal,
  input: QualifiedGrantListInput = {}): Promise<QualifiedGrantMetadata[]> {
  return run('list', async () => {
    if (!input || typeof input !== 'object') refuse('invalid_input');
    const who = principalSnapshot(principal), limit = input.limit ?? 50, cursor = input.afterConnectionId;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) refuse('invalid_input');
    const after = cursor === undefined ? null : uuid(cursor);
    const result = await db.query(`SELECT ${COLUMNS} FROM oshal_qualified_connections WHERE ${OWNER}
      AND ($3::uuid IS NULL OR connection_id > $3::uuid) ORDER BY connection_id LIMIT $4`, [...ownerValues(who), after, limit]);
    return result.rows.map(metadata);
  });
}

/**
 * @description Revoke only the exact personal grant/revision; never erase or mutate another owner/account.
 * @param db Already-bound caller-owned transaction; no identity settings or transaction commands are issued here.
 * @param principal Verified exact issuer/subject.
 * @param input Exact UUID/provider/account/revision target, even for a repeated revocation.
 * @returns Metadata with revoked status and new DB-owned revision. Schema-required encrypted access stays stored.
 */
export function revokeQualifiedGrant(db: QualifiedConnectorQueryable, principal: QualifiedConnectorPrincipal,
  input: QualifiedGrantTarget): Promise<QualifiedGrantMetadata> {
  return run('revoke', async () => {
    const who = principalSnapshot(principal), target = targetSnapshot(input);
    const result = await db.query(`UPDATE oshal_qualified_connections SET status = 'revoked', refresh_token = NULL
      WHERE ${EXACT} RETURNING ${COLUMNS}`, targetValues(who, target));
    if (result.rows.length !== 1) refuse('not_found_or_stale');
    return metadata(result.rows[0]);
  });
}
