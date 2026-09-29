/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise production grant lifecycle and real qualified crypto with named SQL/logger doubles; no database/RLS/provider acceptance claim.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFreshQualifiedGrant as create, reconnectFreshQualifiedGrant as reconnect,
  revokeQualifiedGrant as revoke, listQualifiedGrants as list,
  type FreshQualifiedGrantInput, type QualifiedGrantMetadata,
} from '@/app/routes/connector-qualified-grants';
import { decryptQualifiedConnectorToken as decrypt } from '@/app/routes/connector-qualified-token-crypto';

const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logger }));
const A = { sub: 'same-sub-sentinel', principalIssuer: 'https://issuer-a.example.com' };
const B = { ...A, principalIssuer: 'https://issuer-b.example.com' };
const fresh = (): FreshQualifiedGrantInput => ({ validatedIdentity: { provider: 'smartthings', accountKey: 'account-sentinel' },
  accessToken: 'fresh-access-token-sentinel', refreshToken: 'fresh-refresh-token-sentinel', expiresAt: '2099-01-01T00:00:00.000Z' });
const target = (row: QualifiedGrantMetadata) => ({ connectionId: row.connectionId, provider: row.provider,
  accountKey: row.accountKey, expectedRevision: row.revision });
const reconnectInput = (row: QualifiedGrantMetadata) => ({ ...fresh(), connectionId: row.connectionId, expectedRevision: row.revision });
type Row = Record<string, unknown> & { connection_id: string; revision: string };
type Before = (sql: string, values: unknown[]) => void | Promise<void>;

/** Named SQL-map double: no sessions, RLS, transactions, constraints or real locking. */
function qualifiedSqlDouble() {
  const grants = new Map<string, Row>(), keys = new Map<string, string>();
  const failures: unknown[] = [];
  const control: { before?: Before } = {};
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    expect(sql).not.toMatch(/\boshal_(?:connections|user_deks)\b|set_config|\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
    await control.before?.(sql, values);
    try {
      if (sql.includes('oshal_qualified_deks')) return keyQuery(sql, values, keys);
      return grantQuery(sql, values, grants);
    } catch (error) { failures.push(error); throw error; }
  });
  return { query, grants, keys, control, failures };
}
function keyQuery(sql: string, values: unknown[], keys: Map<string, string>) {
  const key = JSON.stringify(values.slice(0, 2));
  if (sql.startsWith('SELECT wrapped_dek')) {
    expect(sql).toContain('WHERE owner_sub = $1 AND principal_issuer = $2');
    return { rows: keys.has(key) ? [{ wrapped_dek: keys.get(key)! }] : [] };
  }
  expect(sql).toContain('ON CONFLICT (principal_issuer, owner_sub) DO NOTHING');
  if (!keys.has(key)) keys.set(key, String(values[2]));
  return { rows: [] };
}
function owned(rows: Row[], values: unknown[]) {
  return rows.filter(row => row.principal_issuer === values[0] && row.owner_sub === values[1]);
}
function exact(rows: Row[], values: unknown[]) {
  return owned(rows, values).filter(row => row.connection_id === values[2] && row.provider === values[3]
    && row.account_key === values[4] && row.revision === values[5]);
}
function grantQuery(sql: string, values: unknown[], grants: Map<string, Row>): { rows: Row[] } {
  if (sql.startsWith('INSERT')) return insertQuery(sql, values, grants);
  expect(sql).toContain('principal_issuer = $1 AND owner_sub = $2');
  const rows = [...grants.values()];
  if (sql.includes('connection_id = $3::uuid')) {
    expect(sql).toContain('connection_id = $3::uuid AND provider = $4 AND account_key = $5 AND revision = $6::bigint');
    if (sql.startsWith('UPDATE')) return updateQuery(sql, values, exact(rows, values));
    expect(sql).toMatch(/ FOR UPDATE$/);
    return { rows: exact(rows, values) };
  }
  if (sql.startsWith('SELECT connection_id FROM')) {
    expect(sql).toContain('AND provider = $3 AND account_key = $4');
    return { rows: owned(rows, values).filter(row => row.provider === values[2] && row.account_key === values[3]) };
  }
  expect(sql).toContain('ORDER BY connection_id LIMIT $4');
  expect(sql).toContain('($3::uuid IS NULL OR connection_id > $3::uuid)');
  expect(sql).not.toMatch(/access_token|refresh_token|SELECT \*/);
  return { rows: owned(rows, values).filter(row => values[2] === null || row.connection_id > String(values[2]))
    .sort((a, b) => a.connection_id.localeCompare(b.connection_id)).slice(0, Number(values[3])) };
}
function insertQuery(sql: string, values: unknown[], grants: Map<string, Row>) {
  expect(sql).toContain('ON CONFLICT (principal_issuer, owner_sub, provider, account_key) DO NOTHING');
  expect(sql.split('RETURNING')[0]).not.toMatch(/DO UPDATE|coalesce|\brevision\s*[,)]/i);
  const collision = owned([...grants.values()], values).some(row => row.provider === values[2] && row.account_key === values[3]);
  if (collision) return { rows: [] };
  const row: Row = { connection_id: randomUUID(), principal_issuer: values[0], owner_sub: values[1],
    provider: values[2], account_key: values[3], access_token: values[4], refresh_token: values[5], expiry: values[6],
    status: 'connected', revision: '1', created_at: new Date('2026-09-29T00:00:00.000Z'), updated_at: new Date('2026-09-29T00:00:00.000Z') };
  grants.set(row.connection_id, row);
  return { rows: [row] };
}
function updateQuery(sql: string, values: unknown[], rows: Row[]) {
  expect(sql.split('WHERE')[0]).not.toMatch(/\brevision\s*=|coalesce/i);
  if (!rows.length) return { rows: [] };
  const row = rows[0];
  if (sql.includes("SET status = 'revoked'")) {
    expect(sql).toContain('refresh_token = NULL');
    row.status = 'revoked'; row.refresh_token = null;
  } else {
    expect(sql).toContain("SET access_token = $7, refresh_token = $8, expiry = $9, status = 'connected'");
    row.access_token = values[6]; row.refresh_token = values[7]; row.expiry = values[8]; row.status = 'connected';
  }
  row.revision = String(BigInt(row.revision) + 1n); row.updated_at = new Date();
  return { rows: [row] };
}
const writes = (db: ReturnType<typeof qualifiedSqlDouble>) => db.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/.test(sql));

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('SESSION_SECRET', 'qualified-grants-example-secret-sentinel'); });
afterEach(() => vi.unstubAllEnvs());

describe('qualified grants production lifecycle / named SQL double + real crypto', () => {
  it('persists fresh encrypted credentials and returns a strict metadata allowlist', async () => {
    const db = qualifiedSqlDouble();
    const row = await create(db, A, fresh()).catch(error => { throw db.failures[0] ?? error; });
    const stored = db.grants.get(row.connectionId)!;
    expect(row).toMatchObject({ provider: 'smartthings', accountKey: 'account-sentinel', status: 'connected', revision: '1', expiresAt: fresh().expiresAt });
    expect(Object.keys(row).sort()).toEqual(['connectionId', 'provider', 'accountKey', 'status', 'revision', 'expiresAt', 'createdAt', 'updatedAt'].sort());
    expect(stored.access_token).toMatch(/^qct1:/); expect(stored.refresh_token).toMatch(/^qct1:/);
    expect(await decrypt(db, A, String(stored.access_token))).toBe(fresh().accessToken);
    expect(await decrypt(db, A, String(stored.refresh_token))).toBe(fresh().refreshToken);
    expect(JSON.stringify(row)).not.toMatch(/qct1:|qdk1:|access-token|refresh-token/);
  });

  it('refuses an existing account before encryption without updating or adopting it', async () => {
    const db = qualifiedSqlDouble(); await create(db, A, fresh()); const before = [...db.grants.values()].map(row => ({ ...row }));
    db.query.mockClear(); await expect(create(db, A, fresh())).rejects.toMatchObject({ code: 'conflict' });
    expect(db.query).toHaveBeenCalledTimes(1); expect(writes(db)).toEqual([]); expect([...db.grants.values()]).toEqual(before);
  });

  it('refuses a racing account insert atomically rather than overwriting its tokens', async () => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh()), saved = { ...db.grants.get(row.connectionId)! };
    db.grants.clear(); db.control.before = (sql) => { if (sql.startsWith('INSERT INTO oshal_qualified_connections')) db.grants.set(row.connectionId, saved); };
    await expect(create(db, A, fresh())).rejects.toMatchObject({ code: 'conflict' });
    expect([...db.grants.values()]).toEqual([saved]);
  });

  it('keeps same-sub/same-account issuers and exact issuer spelling separate', async () => {
    const db = qualifiedSqlDouble(), identities = [A, B, { ...A, principalIssuer: A.principalIssuer + '/' }, { ...A, sub: 'other-sub-sentinel' }];
    const rows = await Promise.all(identities.map(who => create(db, who, fresh())));
    for (let i = 0; i < identities.length; i++) expect(await list(db, identities[i])).toEqual([rows[i]]);
    expect(db.keys.size).toBe(4); expect(new Set(rows.map(row => row.connectionId)).size).toBe(4);
  });

  it.each([undefined, null, 'replacement-refresh-token-sentinel'])('reconnect replaces access and refresh exactly (%s)', async refreshToken => {
    const db = qualifiedSqlDouble(), old = await create(db, A, fresh());
    db.grants.get(old.connectionId)!.status = 'needs_reconnect';
    const row = await reconnect(db, A, { ...reconnectInput(old), accessToken: 'replacement-access-token-sentinel', refreshToken, expiresAt: null });
    const stored = db.grants.get(row.connectionId)!;
    expect(row).toMatchObject({ revision: '2', status: 'connected', expiresAt: null });
    expect(await decrypt(db, A, String(stored.access_token))).toBe('replacement-access-token-sentinel');
    if (refreshToken) expect(await decrypt(db, A, String(stored.refresh_token))).toBe(refreshToken);
    else expect(stored.refresh_token).toBeNull();
    expect(db.query.mock.calls.some(([sql]) => sql.endsWith('FOR UPDATE'))).toBe(true);
  });

  it.each(['issuer', 'subject', 'uuid', 'provider', 'account', 'revision'])('wrong %s reconnect/revoke refuses with no crypto or grant write', async wrong => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh()), before = { ...db.grants.get(row.connectionId)! };
    const who = wrong === 'issuer' ? B : wrong === 'subject' ? { ...A, sub: 'other-sub-sentinel' } : A;
    const chosen = { ...target(row), ...(wrong === 'uuid' ? { connectionId: randomUUID() } : {}),
      ...(wrong === 'provider' ? { provider: 'nest' } : {}), ...(wrong === 'account' ? { accountKey: 'other-account-sentinel' } : {}),
      ...(wrong === 'revision' ? { expectedRevision: '2' } : {}) };
    db.query.mockClear();
    await expect(reconnect(db, who, { ...fresh(), ...chosen, validatedIdentity: { provider: chosen.provider, accountKey: chosen.accountKey } }))
      .rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(writes(db)).toEqual([]); expect(db.query).toHaveBeenCalledTimes(1);
    await expect(revoke(db, who, chosen)).rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect([...db.grants.values()]).toEqual([before]); expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('rechecks revision at final reconnect write even after its lock/crypto awaits', async () => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh()), stored = db.grants.get(row.connectionId)!;
    const before = String(stored.access_token);
    db.control.before = sql => { if (sql.startsWith('UPDATE')) stored.revision = '2'; };
    await expect(reconnect(db, A, reconnectInput(row))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(stored.access_token).toBe(before);
  });

  it('revokes exact revision, clears refresh, rejects stale repeat, permits explicit fresh reconnection', async () => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh());
    const revoked = await revoke(db, A, target(row));
    expect(revoked).toMatchObject({ status: 'revoked', revision: '2' }); expect(db.grants.get(row.connectionId)!.refresh_token).toBeNull();
    await expect(revoke(db, A, target(row))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(await reconnect(db, A, { ...reconnectInput(revoked), refreshToken: undefined })).toMatchObject({ status: 'connected', revision: '3' });
  });

  it('snapshots nested fresh account, principal, credentials and expiry before first await', async () => {
    const db = qualifiedSqlDouble(), who = { ...A }, input = { ...fresh(), validatedIdentity: { ...fresh().validatedIdentity } };
    db.control.before = () => {
      who.sub = B.sub + '-changed'; who.principalIssuer = B.principalIssuer;
      input.validatedIdentity.accountKey = 'changed-account-sentinel'; input.validatedIdentity.provider = 'nest';
      input.accessToken = 'changed-access-token-sentinel'; input.refreshToken = undefined; input.expiresAt = null;
    };
    const row = await create(db, who, input), stored = db.grants.get(row.connectionId)!;
    expect(row).toMatchObject({ provider: 'smartthings', accountKey: 'account-sentinel', expiresAt: fresh().expiresAt });
    expect(stored.principal_issuer).toBe(A.principalIssuer); expect(stored.owner_sub).toBe(A.sub);
    expect(await decrypt(db, A, String(stored.access_token))).toBe(fresh().accessToken);
    expect(await decrypt(db, A, String(stored.refresh_token))).toBe(fresh().refreshToken);
  });

  it('snapshots reconnect and revoke targets before their first await', async () => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh()), input = reconnectInput(row), who = { ...A };
    db.control.before = () => { input.connectionId = randomUUID(); input.expectedRevision = '999'; who.principalIssuer = B.principalIssuer; };
    const next = await reconnect(db, who, input); expect(next).toMatchObject({ connectionId: row.connectionId, revision: '2' });
    const selected = target(next); db.control.before = () => { selected.accountKey = 'changed-account-sentinel'; selected.expectedRevision = '999'; };
    expect(await revoke(db, A, selected)).toMatchObject({ connectionId: row.connectionId, revision: '3', status: 'revoked' });
  });

  it('lists stable bounded metadata pages only, retaining explicit status and expired timestamp', async () => {
    const db = qualifiedSqlDouble();
    for (const accountKey of ['one-sentinel', 'two-sentinel', 'three-sentinel']) await create(db, A, { ...fresh(), validatedIdentity: { provider: 'smartthings', accountKey } });
    const all = await list(db, A), chosen = db.grants.get(all[0].connectionId)!;
    chosen.status = 'needs_reconnect'; chosen.expiry = '2020-01-01T00:00:00.000Z';
    const first = await list(db, A, { limit: 1 });
    expect(first[0]).toMatchObject({ status: 'needs_reconnect', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(await list(db, A, { afterConnectionId: first[0].connectionId, limit: 2 })).toEqual(all.slice(1));
    expect(JSON.stringify(first)).not.toMatch(/qct1:|qdk1:|access_token|refresh_token|principal_issuer|owner_sub/);
  });

  it('parameterizes punctuation in account/issuer rather than interpolating SQL', async () => {
    const db = qualifiedSqlDouble(), who = { ...A, principalIssuer: "https://issuer.example.com/' OR 1=1 --" };
    const row = await create(db, who, { ...fresh(), validatedIdentity: { provider: 'smartthings', accountKey: "x'; SELECT secret; --" } });
    expect(await list(db, who)).toEqual([row]);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/SELECT secret|OR 1=1/);
  });

  it('snapshots list identity and pagination before awaiting the query', async () => {
    const db = qualifiedSqlDouble(), row = await create(db, A, fresh()), who = { ...A }, input = { limit: 1 };
    db.control.before = () => { who.principalIssuer = B.principalIssuer; input.limit = 100; };
    expect(await list(db, who, input)).toEqual([row]);
    expect(db.query.mock.calls.at(-1)?.[1]).toEqual([A.principalIssuer, A.sub, null, 1]);
  });
});

describe('qualified grant input/refusal boundaries', () => {
  it.each(['', ' padded', 'line\nbreak', '\ud800', 'x'.repeat(2049)])('rejects malformed issuer before any query %#', async principalIssuer => {
    const db = qualifiedSqlDouble(); await expect(create(db, { ...A, principalIssuer }, fresh())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(['', ' padded', 'line\nbreak', '\ud800', 'x'.repeat(1025)])('rejects malformed subject before any query %#', async sub => {
    const db = qualifiedSqlDouble(); await expect(create(db, { ...A, sub }, fresh())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.query).not.toHaveBeenCalled();
  });
  it('rejects absent provider validation and malformed connection IDs, never inferring account identity', async () => {
    const db = qualifiedSqlDouble();
    await expect(create(db, A, { ...fresh(), validatedIdentity: undefined } as unknown as FreshQualifiedGrantInput)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(reconnect(db, A, { ...fresh(), connectionId: 'invalid-uuid', expectedRevision: '1' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([
    { accessToken: '' }, { accessToken: '\ud800' }, { accessToken: 'x'.repeat(65537) }, { refreshToken: '' },
    { refreshToken: 'x'.repeat(65537) }, { expiresAt: undefined }, { expiresAt: 'invalid' }, { expiresAt: '2020-01-01T00:00:00.000Z' },
    { validatedIdentity: { provider: 'SmartThings', accountKey: 'account-sentinel' } },
    { validatedIdentity: { provider: 'smartthings', accountKey: ' padded' } },
    { validatedIdentity: { provider: 'smartthings', accountKey: 'x'.repeat(2049) } },
  ])('rejects malformed fresh fields before DB %#', async patch => {
    const db = qualifiedSqlDouble(); await expect(create(db, A, { ...fresh(), ...patch } as FreshQualifiedGrantInput)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(['0', '01', '-1', '1.5', '9223372036854775808', 1])('rejects noncanonical revision %#', async expectedRevision => {
    const db = qualifiedSqlDouble(); await expect(revoke(db, A, { connectionId: randomUUID(), provider: 'smartthings', accountKey: 'account-sentinel',
      expectedRevision: expectedRevision as string })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { afterConnectionId: 'not-a-uuid' }])('bounds list input %#', async input => {
    const db = qualifiedSqlDouble(); await expect(list(db, A, input)).rejects.toMatchObject({ code: 'invalid_input' }); expect(db.query).not.toHaveBeenCalled();
  });
  it('sanitizes raw storage errors and logger fields without carrying cause, tokens, ciphertext or identities', async () => {
    const db = qualifiedSqlDouble(), raw = [fresh().accessToken, A.principalIssuer, 'qct1:secret-sentinel'].join(' ');
    db.control.before = () => { throw new Error(raw); };
    await expect(create(db, A, fresh())).rejects.toMatchObject({ message: 'qualified connector grant: storage_failure', code: 'storage_failure' });
    const logs = JSON.stringify(logger.error.mock.calls, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value);
    for (const secret of [fresh().accessToken, A.principalIssuer, 'qct1:secret-sentinel']) expect(logs).not.toContain(secret);
    expect(writes(db)).toHaveLength(0);
  });
  it('fails closed without the actual crypto secret and never inserts a connection', async () => {
    vi.stubEnv('SESSION_SECRET', ''); const db = qualifiedSqlDouble();
    await expect(create(db, A, fresh())).rejects.toMatchObject({ code: 'storage_failure' }); expect(writes(db)).toEqual([]);
  });
  it('does not persist credentials whose expiry elapsed during encryption', async () => {
    const db = qualifiedSqlDouble(); let now = Date.parse('2026-09-29T00:00:00.000Z');
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      db.control.before = sql => { if (sql.includes('oshal_qualified_deks')) now += 10_000; };
      await expect(create(db, A, { ...fresh(), expiresAt: '2026-09-29T00:00:01.000Z' })).rejects.toMatchObject({ code: 'invalid_input' });
      expect(db.grants.size).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('contains no session authority, legacy adoption, decryption or manually assigned revisions', () => {
    const source = readFileSync(resolve(__dirname, '../../src/app/routes/connector-qualified-grants.ts'), 'utf8');
    expect(source).not.toMatch(/set_config|current_setting|is_operator|SECURITY DEFINER|\boshal_(connections|user_deks)\b|decryptQualified|COALESCE/i);
    expect(source).not.toMatch(/SET\s+revision\s*=/i);
  });
});
