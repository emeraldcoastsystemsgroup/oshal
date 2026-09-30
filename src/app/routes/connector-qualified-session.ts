/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Share exact non-operator request-bound connector transactions without minting identity. Reuse GUC reset/disposal; sanitize lifecycle failures and retain caller-owned business error classification.
 */
import { Client } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity, isSystemIdentity } from '@/shared/services/database/request-identity';
import type { QualifiedConnectorPrincipal, QualifiedConnectorQueryable } from './connector-qualified-token-crypto';

const log = createChildLogger({ module: 'connector-qualified-session' });
/** Existing GUC-stamped dedicated client; release retains the wrapper's reset-before-reuse contract. */
export interface QualifiedConnectorSessionClient extends QualifiedConnectorQueryable {
  release(destroy?: boolean): void;
}
/** Supply an existing request-bound GUC pool, never a raw/system pool or ambient caller-owned transaction. */
export interface QualifiedConnectorSessionPool {
  connect(): Promise<QualifiedConnectorSessionClient>;
}
export interface QualifiedConnectorSessionOptions { readonly signal?: AbortSignal }
export type QualifiedConnectorSessionRefusal = 'not_authorized' | 'aborted' | 'storage_failure';

/** Lifecycle failures expose neither database diagnostics nor identity/credential values. */
export class QualifiedConnectorSessionError extends Error {
  constructor(readonly code: QualifiedConnectorSessionRefusal) {
    super('Qualified connector session unavailable: ' + code);
    this.name = 'QualifiedConnectorSessionError';
  }
}

/** Snapshot exact text only; this validates input, it does not establish an authenticated identity. */
function principalCopy(principal: QualifiedConnectorPrincipal): QualifiedConnectorPrincipal {
  const valid = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value, 'utf8') <= max
    && Buffer.from(value, 'utf8').toString('utf8') === value;
  if (!valid(principal?.sub, 1024) || !valid(principal?.principalIssuer, 2048)) throw new QualifiedConnectorSessionError('not_authorized');
  return Object.freeze({ sub: principal.sub, principalIssuer: principal.principalIssuer });
}

/** Require the established non-operator personal request, including following awaited work. */
function authorized(principal: QualifiedConnectorPrincipal, signal?: AbortSignal): void {
  if (signal?.aborted) throw new QualifiedConnectorSessionError('aborted');
  const identity = getRequestIdentity();
  if (!identity || isSystemIdentity(identity) || identity.isOperator !== false
    || identity.sub !== principal.sub || identity.principalIssuer !== principal.principalIssuer) {
    throw new QualifiedConnectorSessionError('not_authorized');
  }
}

/** Fixed diagnostics only; callback errors may contain secrets and must not become logged causes/stacks. */
function lifecycleFailure(message: string): void {
  log.error({ err: new QualifiedConnectorSessionError('storage_failure') }, message);
}

/** End concrete pg first: wrapped release queues RESET, and a hung query must not pin that queue. */
function discard(client: QualifiedConnectorSessionClient): void {
  try {
    if (client instanceof Client) void client.end().catch(() => lifecycleFailure('qualified client shutdown refused'));
  } catch { lifecycleFailure('qualified client shutdown failed'); }
  try { client.release(true); }
  catch { lifecycleFailure('qualified discarded client release failed'); }
}

/** Observe late settlement and remove the listener. Aborted work cannot resume the session continuation. */
async function interruptible<T>(work: Promise<T>, signal: AbortSignal | undefined, dispose: () => void): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); dispose(); reject(new QualifiedConnectorSessionError('aborted')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Rollback is best effort for at most one second; destroying the connection also rolls back server work. */
async function rollback(client: QualifiedConnectorSessionClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.query('ROLLBACK'), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new QualifiedConnectorSessionError('storage_failure')), 1000);
    })]);
  } catch { lifecycleFailure('qualified connector rollback failed; client discarded'); }
  finally { clearTimeout(timer); }
}

/** Own one checked-out client, including late checkout and idempotent physical discard on cancellation. */
function lease() {
  let client: QualifiedConnectorSessionClient | undefined, released = false;
  return {
    get client() { return client; },
    claim(value: QualifiedConnectorSessionClient) { client = value; },
    dispose() { if (client && !released) { released = true; discard(client); } },
    release() {
      if (client && !released) {
        released = true;
        try { client.release(false); }
        catch (error) { discard(client); throw error; }
      }
    },
    get released() { return released; },
  };
}

/**
 * @description Run short credential persistence work using existing request/RLS machinery.
 * @param db Existing request-bound GUC pool; its connect/release stamps and clears the established identity.
 * @param principal Exact verified owner, which must match non-operator ALS; no SYSTEM/admin fallback.
 * @param work Short database-only work. Do not call providers or COMMIT/ROLLBACK here.
 * Callback errors propagate after rollback for business classification; callers must sanitize their exposure.
 * @param options Optional abort signal bounds waits and discards the owned pg client; never a replacement identity.
 * @returns Callback result only after acknowledged commit and context recheck. Post-commit abort cannot undo a commit.
 */
export async function withQualifiedConnectorSession<T>(
  db: QualifiedConnectorSessionPool, principal: QualifiedConnectorPrincipal,
  work: (client: QualifiedConnectorSessionClient) => Promise<T>, options: QualifiedConnectorSessionOptions = {},
): Promise<T> {
  const started = Date.now();
  log.debug({ op: 'transaction' }, 'qualified connector session started');
  const signal = options.signal;
  const owned = lease();
  let committed = false, callbackFailure = false;
  try {
    const who = principalCopy(principal);
    authorized(who, signal);
    const client = await interruptible(db.connect().then(value => {
      owned.claim(value);
      if (signal?.aborted) { owned.dispose(); throw new QualifiedConnectorSessionError('aborted'); }
      return value;
    }), signal, owned.dispose);
    authorized(who, signal);
    await interruptible(client.query('BEGIN ISOLATION LEVEL READ COMMITTED'), signal, owned.dispose);
    authorized(who, signal);
    let result: T;
    try { result = await interruptible(work(client), signal, owned.dispose); }
    catch (error) { callbackFailure = true; throw error; }
    authorized(who, signal);
    await interruptible(client.query('COMMIT'), signal, owned.dispose);
    committed = true;
    authorized(who, signal);
    log.debug({ op: 'transaction', durationMs: Date.now() - started }, 'qualified connector session committed');
    return result;
  } catch (error) {
    lifecycleFailure('qualified connector session refused');
    if (owned.client && !owned.released && !committed) await rollback(owned.client);
    owned.dispose();
    if (callbackFailure || error instanceof QualifiedConnectorSessionError) throw error;
    throw new QualifiedConnectorSessionError('storage_failure');
  } finally {
    try { owned.release(); }
    catch { lifecycleFailure('qualified connector release failed'); throw new QualifiedConnectorSessionError('storage_failure'); }
  }
}
