/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real inactive qualified broker, crypto and request ALS with explicit SQL/transaction/provider doubles and deterministic revocation barriers. Not PostgreSQL/RLS or live provider proof.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Model timestamp parser precision loss separately from exact stored microseconds; guard refresh CAS and same-millisecond replacement without claiming PostgreSQL proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptQualifiedConnectorToken as encrypt, decryptQualifiedConnectorToken as decrypt } from '@/app/routes/connector-qualified-token-crypto';
import {
  resolveQualifiedPersonalCredential as resolveCredential, QualifiedCredentialUnavailableError,
  type QualifiedConnectorBrokerOptions, type QualifiedPersonalSelection, type QualifiedConnectorRefreshInput,
} from '@/app/routes/connector-qualified-broker';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logger }));
const A = { sub: 'qualified-broker-sub-sentinel', principalIssuer: 'https://issuer-a.example.com' };
const B = { ...A, principalIssuer: 'https://issuer-b.example.com' };
const ID = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-2222-3333-4444-555555555555';
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const future = () => new Date(Date.now() + 60_000).toISOString();
const expired = () => new Date(Date.now() - 60_000).toISOString();
const selection = { connectionId: ID, provider: 'smartthings', expectedRevision: '1' };
type Row = Record<string, unknown>;
type Hook = (kind: string, sql: string, values: unknown[], transaction: boolean) => void | Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_SECRET', 'qualified-broker-test-secret-sentinel');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Named SQL timestamp double: preserve six stored digits; never compare through a JS Date. */
function storedTimestamp(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\.(\d{3})Z$/, '.$1000Z') : value;
}

/** Model pg's default Date decoding separately from explicit SQL text projections. Real PG companion is separate. */
function projectedRow(row: Row, sql: string): Row {
  const result = { ...row, created_at: new Date(String(row.created_at)),
    expiry: row.expiry === null ? null : new Date(String(row.expiry)) };
  return { ...result,
    ...(sql.includes('AS created_at_witness') ? { created_at_witness: storedTimestamp(row.created_at) } : {}),
    ...(sql.includes('AS expiry_witness') ? { expiry_witness: storedTimestamp(row.expiry) } : {}) };
}

/** Deliberately not a database/RLS/lock model: named query double with only the CAS/rollback branches needed here. */
function fixture() {
  const rows = new Map<string, Row>(), deks = new Map<string, string>(), pending = new Map<string, Row>();
  const calls: Array<{ kind: string; sql: string; values: unknown[]; transaction: boolean }> = [];
  const hooks: { before?: Hook; after?: Hook } = {};
  let inTransaction = false;
  const release = vi.fn();
  const kindOf = (sql: string) => sql.startsWith('SELECT wrapped_dek') ? 'dek-read'
    : sql.startsWith('INSERT INTO oshal_qualified_deks') ? 'dek-insert'
      : sql.startsWith('SELECT connection_id') ? 'read'
        : sql.startsWith('UPDATE oshal_qualified_connections') ? 'update'
          : sql.startsWith('BEGIN') ? 'begin' : sql.toLowerCase();
  const matches = (row: Row, p: unknown[]) => row.principal_issuer === p[0] && row.owner_sub === p[1]
    && row.connection_id === p[2] && row.provider === p[3] && row.revision === p[4] && row.status === 'connected';
  const exec = async (sql: string, p: unknown[] = [], transaction = false): Promise<{ rows: Row[] }> => {
    const kind = kindOf(sql); calls.push({ kind, sql, values: [...p], transaction });
    expect(sql).not.toMatch(/\boshal_(?:connections|user_deks|tenant_memberships)\b|set_config|is_operator/);
    await hooks.before?.(kind, sql, p, transaction);
    let result: Row[] = [];
    if (kind === 'dek-read') { const value = deks.get(JSON.stringify(p.slice(0, 2))); if (value) result = [{ wrapped_dek: value }]; }
    else if (kind === 'dek-insert') { const key = JSON.stringify(p.slice(0, 2)); if (!deks.has(key)) deks.set(key, String(p[2])); }
    else if (kind === 'read') {
      expect(sql).toMatch(/principal_issuer=\$1 AND owner_sub=\$2 AND connection_id=\$3 AND provider=\$4 AND revision=\$5 AND status='connected' FOR (SHARE|UPDATE)$/);
      const row = transaction ? pending.get(String(p[2])) ?? rows.get(String(p[2])) : rows.get(String(p[2]));
      if (row && matches(row, p)) result = [projectedRow(row, sql)];
    } else if (kind === 'begin') { expect(sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED'); inTransaction = true; }
    else if (kind === 'update') {
      expect(transaction && inTransaction).toBe(true);
      expect(sql).toContain("principal_issuer=$1 AND owner_sub=$2 AND connection_id=$3 AND provider=$4 AND revision=$5 AND status='connected'");
      expect(sql).toContain('access_token=$9 AND refresh_token IS NOT DISTINCT FROM $10 AND expiry IS NOT DISTINCT FROM $11');
      const row = rows.get(String(p[2]));
      if (row && matches(row, p) && row.access_token === p[8] && row.refresh_token === p[9]
        && storedTimestamp(row.expiry) === storedTimestamp(p[10]) && row.account_key === p[11]
        && storedTimestamp(row.created_at) === storedTimestamp(p[12])) {
        const next = { ...row, access_token: p[5], refresh_token: p[6], expiry: p[7], revision: String(BigInt(String(row.revision)) + 1n) };
        pending.set(String(p[2]), next); result = [projectedRow(next, sql)];
      }
    } else if (kind === 'commit') {
      for (const [key, row] of pending) rows.set(key, { ...row });
      pending.clear(); inTransaction = false;
    } else if (kind === 'rollback') { pending.clear(); inTransaction = false; }
    else throw new Error('Unexpected SQL in explicit broker double');
    await hooks.after?.(kind, sql, p, transaction);
    return { rows: result };
  };
  const query = vi.fn((sql: string, p?: unknown[]) => exec(sql, p, false));
  const client = { query: vi.fn((sql: string, p?: unknown[]) => exec(sql, p, true)), release };
  const connect = vi.fn(async () => { await hooks.before?.('connect', '', [], false); return client; });
  const db = { query, connect };
  async function seed(who = A, id = ID, expiry: string | null = future(), revision = '1') {
    const access = await encrypt(db, who, 'access-token-sentinel');
    const refresh = await encrypt(db, who, 'refresh-token-sentinel');
    const row = { connection_id: id, principal_issuer: who.principalIssuer, owner_sub: who.sub,
      provider: 'smartthings', account_key: 'account-sentinel', status: 'connected', revision,
      access_token: access, refresh_token: refresh, expiry, created_at: new Date(NOW - 100_000).toISOString() };
    rows.set(id, row); calls.length = 0; query.mockClear(); return row;
  }
  function run(opts: QualifiedConnectorBrokerOptions = {}, selected: QualifiedPersonalSelection = selection, who = A) {
    return runWithRequestIdentity({ ...who, isOperator: false }, () => resolveCredential(db, who, selected, opts));
  }
  return { db, rows, deks, pending, calls, hooks, release, seed, run, client };
}

const provider = () => vi.fn(async () => ({
  accessToken: 'new-access-token-sentinel', refreshToken: 'new-refresh-token-sentinel', expiresAt: future(),
}));
const code = (name: string) => ({ name: 'QualifiedCredentialUnavailableError', code: name });

describe('qualified broker: actual production/crypto/ALS, named SQL and provider doubles', () => {
  it.each([null, 'future'])('returns only the exact current qualified credential with expiry %s', async expiry => {
    const f = fixture(); await f.seed(A, ID, expiry === null ? null : future());
    const result = await f.run();
    expect(result).toEqual({ accessToken: 'access-token-sentinel', connectionId: ID, provider: 'smartthings', revision: '1', expiresAt: expiry === null ? null : future() });
    expect(f.calls.filter(c => c.kind === 'read')).toHaveLength(2);
    expect(f.db.connect).not.toHaveBeenCalled();
    expect(f.calls.every(c => c.kind !== 'read' || JSON.stringify(c.values) === JSON.stringify([A.principalIssuer, A.sub, ID, 'smartthings', '1']))).toBe(true);
  });

  it('requires existing exact request issuer/sub; missing, anonymous, system and same-sub foreign issuers do not inherit operator authority', async () => {
    const f = fixture(); await f.seed();
    await expect(resolveCredential(f.db, A, selection)).rejects.toMatchObject(code('not_authorized'));
    await expect(runWithSystemIdentity(() => resolveCredential(f.db, A, selection))).rejects.toMatchObject(code('not_authorized'));
    for (const identity of [{ sub: null, principalIssuer: null }, B, { ...A, sub: 'other-sub-sentinel' }, { ...A, principalIssuer: null }]) {
      await expect(runWithRequestIdentity({ ...identity, isOperator: true }, () => resolveCredential(f.db, A, selection))).rejects.toMatchObject(code('not_authorized'));
    }
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it('isolates same-sub issuers and never searches another account or provider as fallback', async () => {
    const f = fixture(); await f.seed(A); await f.seed(B, OTHER);
    expect((await f.run({}, { ...selection, connectionId: OTHER }, B)).accessToken).toBe('access-token-sentinel');
    await expect(f.run({}, selection, B)).rejects.toMatchObject(code('not_found_or_stale'));
    await expect(f.run({}, { ...selection, provider: 'google' })).rejects.toMatchObject(code('not_found_or_stale'));
    await expect(f.run({}, { ...selection, connectionId: OTHER })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(f.calls.some(c => c.kind === 'update')).toBe(false);
  });

  it.each([
    { connectionId: 'bad' }, { provider: 'SmartThings' }, { provider: '' }, { expectedRevision: '0' },
    { expectedRevision: '01' }, { expectedRevision: '9223372036854775808' }, { expectedRevision: '1.1' },
  ])('rejects malformed selection before SQL: %j', async invalid => {
    const f = fixture(); await f.seed();
    await expect(f.run({}, { ...selection, ...invalid })).rejects.toMatchObject(code('invalid_input'));
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it.each([{ ...A, sub: ' padded' }, { ...A, principalIssuer: '' }, { ...A, sub: 'x\u0000y' }])('rejects ambiguous principal %j', async who => {
    const f = fixture(); await f.seed();
    await expect(f.run({}, selection, who)).rejects.toMatchObject(code('invalid_input'));
    expect(f.db.query).not.toHaveBeenCalled();
  });

  it('keeps BIGINT revision exact beyond Number.MAX_SAFE_INTEGER', async () => {
    const f = fixture(), revision = '9007199254740993'; await f.seed(A, ID, future(), revision);
    expect((await f.run({}, { ...selection, expectedRevision: revision })).revision).toBe(revision);
  });

  it.each(['revoked', 'needs_reconnect', 'stale', 'missing', 'legacy-access', 'legacy-refresh', 'bad-expiry'])('refuses %s row without refresh or fallback', async mode => {
    const f = fixture(), row = await f.seed(), refresh = provider();
    if (mode === 'stale') row.revision = '2';
    else if (mode === 'missing') f.rows.clear();
    else if (mode === 'legacy-access') row.access_token = 'v2:legacy-token-sentinel';
    else if (mode === 'legacy-refresh') row.refresh_token = 'k2:legacy-token-sentinel';
    else if (mode === 'bad-expiry') row.expiry = 'yesterday';
    else row.status = mode;
    await expect(f.run({ refresh })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(refresh).not.toHaveBeenCalled(); expect(f.db.connect).not.toHaveBeenCalled();
  });

  it('refuses a misbehaving port returning a foreign row despite exact SQL', async () => {
    const f = fixture(), row = await f.seed();
    f.db.query.mockResolvedValueOnce({ rows: [{ ...row, principal_issuer: B.principalIssuer }] });
    await expect(f.run()).rejects.toMatchObject(code('not_found_or_stale'));
  });

  it('snapshots mutable selection/principal before the first query wait', async () => {
    const f = fixture(); await f.seed();
    const who = { ...A }, selected = { ...selection };
    f.hooks.before = kind => { if (kind === 'read') { who.principalIssuer = B.principalIssuer; selected.connectionId = OTHER; } };
    expect((await runWithRequestIdentity({ ...A, isOperator: false }, () => resolveCredential(f.db, who, selected))).connectionId).toBe(ID);
  });

  it('rejects revocation during access decryption before returning plaintext', async () => {
    const f = fixture(), row = await f.seed();
    f.hooks.after = kind => { if (kind === 'dek-read') { row.status = 'revoked'; row.revision = '2'; } };
    await expect(f.run()).rejects.toMatchObject(code('not_found_or_stale'));
  });

  it('rejects expiry reached or request identity replaced during decryption', async () => {
    const f = fixture(); await f.seed();
    f.hooks.after = kind => { if (kind === 'dek-read') vi.setSystemTime(NOW + 61_000); };
    await expect(f.run()).rejects.toMatchObject(code('not_found_or_stale'));
    vi.setSystemTime(NOW);
    const identity = { ...A, isOperator: false };
    f.hooks.after = kind => { if (kind === 'dek-read') identity.principalIssuer = B.principalIssuer; };
    await expect(runWithRequestIdentity(identity, () => resolveCredential(f.db, A, selection))).rejects.toMatchObject(code('not_authorized'));
  });

  it('refreshes outside the transaction, then encrypts/CASes on the same dedicated client and returns the new revision', async () => {
    const f = fixture(); await f.seed(A, ID, expired());
    const refresh = provider();
    const checked = vi.fn(async (input: QualifiedConnectorRefreshInput) => {
      expect(f.db.connect).not.toHaveBeenCalled();
      expect(input).toMatchObject({ principal: A, connectionId: ID, provider: 'smartthings', revision: '1', refreshToken: 'refresh-token-sentinel' });
      return refresh();
    });
    const result = await f.run({ refresh: checked });
    expect(result).toEqual({ accessToken: 'new-access-token-sentinel', connectionId: ID, provider: 'smartthings', revision: '2', expiresAt: future() });
    expect(checked).toHaveBeenCalledOnce(); expect(f.db.connect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    const row = f.rows.get(ID)!;
    expect(await decrypt(f.db, A, String(row.access_token))).toBe('new-access-token-sentinel');
    expect(await decrypt(f.db, A, String(row.refresh_token))).toBe('new-refresh-token-sentinel');
    const update = f.calls.find(c => c.kind === 'update')!;
    expect(update.transaction).toBe(true); expect(update.values[4]).toBe('1');
    expect(update.sql.split(' WHERE ')[0]).not.toMatch(/\brevision\s*=/i);
  });

  it.each(['created_at', 'expiry', 'both'])('refreshes unchanged microsecond %s after pg Date truncation without losing rotated credentials', async field => {
    const f = fixture(), row = await f.seed(A, ID, expired()), refresh = provider();
    if (field !== 'expiry') row.created_at = '2026-09-29T11:58:20.123456Z';
    if (field !== 'created_at') row.expiry = '2026-09-29T11:59:00.987654Z';
    const result = await f.run({ refresh });
    expect(result.revision).toBe('2'); expect(refresh).toHaveBeenCalledOnce();
    expect(await decrypt(f.db, A, String(f.rows.get(ID)!.refresh_token))).toBe('new-refresh-token-sentinel');
    const update = f.calls.find(call => call.kind === 'update')!;
    expect(update.values[12]).toBe(storedTimestamp(row.created_at));
    expect(update.values[10]).toBe(storedTimestamp(row.expiry));
    expect(f.calls.some(call => call.kind === 'commit')).toBe(true);
  });

  it.each(['created_at', 'expiry'] as const)('rejects same-millisecond %s replacement after provider await before persistence', async field => {
    const f = fixture(), row = await f.seed(A, ID, expired());
    row[field] = '2026-09-29T11:58:20.123456Z';
    const refresh = vi.fn(async () => {
      row[field] = '2026-09-29T11:58:20.123457Z';
      return { accessToken: 'rotated-access-sentinel', refreshToken: 'rotated-refresh-sentinel', expiresAt: future() };
    });
    await expect(f.run({ refresh })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(refresh).toHaveBeenCalledOnce(); expect(f.db.connect).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.kind === 'update')).toBe(false);
  });

  it.each(['created_at', 'expiry'] as const)('CAS rejects same-millisecond %s change instead of weakening the exact witness', async field => {
    const f = fixture(), row = await f.seed(A, ID, expired());
    row[field] = '2026-09-29T11:58:20.123456Z';
    f.hooks.before = kind => { if (kind === 'update') row[field] = '2026-09-29T11:58:20.123457Z'; };
    await expect(f.run({ refresh: provider() })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(f.calls.some(call => call.kind === 'update')).toBe(true);
    expect(f.calls.some(call => call.kind === 'commit')).toBe(false);
  });

  it.each([
    { created_at_witness: undefined }, { created_at_witness: new Date(NOW) },
    { created_at_witness: '2026-09-29T11:58:20.123Z' },
    { created_at_witness: '2026-02-30T11:58:20.123456Z' },
    { expiry_witness: null }, { expiry_witness: '2001-01-01T00:00:00.987654Z' },
  ])('refuses missing, rounded, malformed or inconsistent database witness %j without provider calls', async invalid => {
    const f = fixture(), row = await f.seed(), refresh = provider();
    f.db.query.mockResolvedValueOnce({ rows: [{ ...projectedRow(row, 'AS created_at_witness AS expiry_witness'), ...invalid }] });
    await expect(f.run({ refresh })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(refresh).not.toHaveBeenCalled(); expect(f.db.connect).not.toHaveBeenCalled();
  });

  it('preserves only this qualified refresh ciphertext when the adapter omits rotation', async () => {
    const f = fixture(), row = await f.seed(A, ID, expired()), before = row.refresh_token;
    await f.run({ refresh: async () => ({ accessToken: 'replacement-token-sentinel', expiresAt: future() }) });
    expect(f.rows.get(ID)!.refresh_token).toBe(before);
  });

  it.each(['no-adapter', 'no-refresh', 'max-revision'])('requires refresh capability for an expired row: %s', async mode => {
    const f = fixture(), row = await f.seed(A, ID, expired()), refresh = provider();
    if (mode === 'no-refresh') row.refresh_token = null;
    if (mode === 'max-revision') row.revision = '9223372036854775807';
    await expect(f.run(mode === 'no-adapter' ? {} : { refresh }, { ...selection, expectedRevision: row.revision as string })).rejects.toMatchObject(code('refresh_unavailable'));
    expect(refresh).not.toHaveBeenCalled(); expect(f.db.connect).not.toHaveBeenCalled();
  });

  it('rejects revocation during refresh-token decryption before invoking the provider', async () => {
    const f = fixture(), row = await f.seed(A, ID, expired()), refresh = provider();
    f.hooks.after = kind => { if (kind === 'dek-read') { row.status = 'revoked'; row.revision = '2'; } };
    await expect(f.run({ refresh })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['revoke', 'replace', 'delete', 'same-revision-replacement'])('refuses %s during held provider refresh, with no credential write or retry', async change => {
    const f = fixture(), row = await f.seed(A, ID, expired());
    const started = deferred<void>(), held = deferred<{ accessToken: string; expiresAt: string }>();
    const refresh = vi.fn(() => { started.resolve(); return held.promise; });
    const pending = f.run({ refresh }); await started.promise;
    if (change === 'delete') f.rows.delete(ID);
    else if (change === 'same-revision-replacement') row.access_token = await encrypt(f.db, A, 'other-grant-token-sentinel');
    else { row.revision = '2'; if (change === 'revoke') row.status = 'revoked'; }
    held.resolve({ accessToken: 'provider-result-token-sentinel', expiresAt: future() });
    await expect(pending).rejects.toMatchObject(code('not_found_or_stale'));
    expect(refresh).toHaveBeenCalledOnce(); expect(f.db.connect).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.kind === 'update')).toBe(false);
  });

  it.each(['access', 'refresh', 'expiry', 'past', 'noncanonical'])('rejects malformed provider %s before encryption/persistence', async mode => {
    const f = fixture(); await f.seed(A, ID, expired());
    const output = { accessToken: 'provider-access-token-sentinel', refreshToken: 'provider-refresh-token-sentinel', expiresAt: future() };
    if (mode === 'access') output.accessToken = '';
    if (mode === 'refresh') output.refreshToken = '';
    if (mode === 'expiry') output.expiresAt = 'not-a-date';
    if (mode === 'past') output.expiresAt = expired();
    if (mode === 'noncanonical') output.expiresAt = '2026-09-29 13:00:00';
    await expect(f.run({ refresh: async () => output })).rejects.toMatchObject(code('refresh_failed'));
    expect(f.db.connect).not.toHaveBeenCalled();
  });

  it('snapshots provider output before post-refresh awaited revalidation', async () => {
    const f = fixture(); await f.seed(A, ID, expired());
    const output = { accessToken: 'provider-access-token-sentinel', expiresAt: future() };
    const refresh = vi.fn(async () => {
      f.hooks.before = kind => { if (kind === 'read') { output.accessToken = 'mutated-token-sentinel'; output.expiresAt = expired(); } };
      return output;
    });
    expect((await f.run({ refresh })).accessToken).toBe('provider-access-token-sentinel');
  });

  it('rejects CAS loss rather than committing or returning the refreshed credential', async () => {
    const f = fixture(), row = await f.seed(A, ID, expired());
    f.hooks.before = kind => { if (kind === 'update') row.revision = '2'; };
    await expect(f.run({ refresh: provider() })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(f.calls.some(c => c.kind === 'rollback')).toBe(true);
    expect(f.calls.some(c => c.kind === 'commit')).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.pending.size).toBe(0);
  });

  it('rejects revocation immediately after refresh commit before returning plaintext', async () => {
    const f = fixture(); await f.seed(A, ID, expired());
    f.hooks.after = kind => { if (kind === 'commit') { f.rows.get(ID)!.status = 'revoked'; f.rows.get(ID)!.revision = '3'; } };
    await expect(f.run({ refresh: provider() })).rejects.toMatchObject(code('not_found_or_stale'));
    expect(f.calls.filter(c => c.kind === 'update')).toHaveLength(1);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('aborts hung refresh promptly and consumes late completion without persistence', async () => {
    const f = fixture(); await f.seed(A, ID, expired());
    const controller = new AbortController(), started = deferred<void>(), held = deferred<{ accessToken: string; expiresAt: string }>();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const refresh = vi.fn(() => { started.resolve(); return held.promise; });
    const pending = f.run({ refresh, signal: controller.signal });
    await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject(code('aborted'));
    held.resolve({ accessToken: 'late-token-sentinel', expiresAt: future() });
    await Promise.resolve(); await Promise.resolve();
    expect(remove).toHaveBeenCalled(); expect(refresh).toHaveBeenCalledOnce(); expect(f.db.connect).not.toHaveBeenCalled();
  });

  it.each(['before', 'crypto', 'commit'])('honors abort %s without returning credentials', async phase => {
    const f = fixture(); await f.seed(A, ID, expired());
    const controller = new AbortController();
    if (phase === 'before') controller.abort();
    f.hooks.after = (kind, _sql, _p, transaction) => {
      if ((phase === 'crypto' && kind === 'dek-read' && transaction) || (phase === 'commit' && kind === 'commit')) controller.abort();
    };
    await expect(f.run({ refresh: provider(), signal: controller.signal })).rejects.toMatchObject(code('aborted'));
    if (phase === 'before') expect(f.db.query).not.toHaveBeenCalled();
    if (phase === 'crypto') expect(f.calls.some(c => c.kind === 'commit')).toBe(false);
  });

  it.each(['read', 'dek-read', 'connect', 'begin', 'update', 'commit'])('sanitizes %s storage failure and never retries refresh', async phase => {
    const f = fixture(); await f.seed(A, ID, expired());
    const refresh = provider();
    f.hooks.before = kind => { if (kind === phase) throw new Error('database-secret-token-sentinel'); };
    await expect(f.run({ refresh })).rejects.toMatchObject(code('storage_failure'));
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(1);
    for (const [fields] of logger.error.mock.calls) {
      expect(fields.err?.message).not.toContain('database-secret-token-sentinel'); expect(fields.err?.cause).toBeUndefined();
    }
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('database-secret-token-sentinel');
    expect(f.pending.size).toBe(0);
  });

  it('sanitizes provider errors and preserves stored credentials', async () => {
    const f = fixture(), row = await f.seed(A, ID, expired()), before = { ...row };
    await expect(f.run({ refresh: async () => { throw new Error('provider-secret-token-sentinel'); } })).rejects.toMatchObject(code('refresh_failed'));
    expect(f.rows.get(ID)).toEqual(before); expect(f.db.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('provider-secret-token-sentinel');
    expect(new QualifiedCredentialUnavailableError('refresh_failed').cause).toBeUndefined();
  });
});
