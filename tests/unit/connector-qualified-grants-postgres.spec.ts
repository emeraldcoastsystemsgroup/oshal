/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prepare production grant lifecycle tests on disposable enforcing-role PostgreSQL. SOURCE ONLY until a coordinated runtime window; no provider or endpoint proof.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prepare exact UUID metadata lookup success and foreign/missing refusal under the actual enforcing role.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import {
  createFreshQualifiedGrant as create, reconnectFreshQualifiedGrant as reconnect,
  revokeQualifiedGrant as revoke, listQualifiedGrants as list, getQualifiedGrant as get,
  type FreshQualifiedGrantInput, type QualifiedGrantMetadata,
} from '@/app/routes/connector-qualified-grants';
import { decryptQualifiedConnectorToken as decrypt, type QualifiedConnectorPrincipal } from '@/app/routes/connector-qualified-token-crypto';

const db = new DisposablePostgres({ purpose: 'qualified-connector-grants', memory: '256m',
  roles: [{ name: 'oshal_app', max: 4 }, 'oshal_bot'],
  migrations: ['060-platform-rls-tenancy.sql', '100-connector-base-schema.sql', '181-qualified-connector-credentials.sql'] });
const A = { sub: 'grants-same-sub-sentinel', principalIssuer: 'https://issuer-a.example.com' };
const B = { ...A, principalIssuer: 'https://issuer-b.example.com' };
const fresh = (accountKey: string): FreshQualifiedGrantInput => ({ validatedIdentity: { provider: 'smartthings', accountKey },
  accessToken: 'postgres-fresh-access-token-sentinel', refreshToken: 'postgres-fresh-refresh-token-sentinel', expiresAt: '2099-01-01T00:00:00.000Z' });
const target = (row: QualifiedGrantMetadata) => ({ connectionId: row.connectionId, provider: row.provider,
  accountKey: row.accountKey, expectedRevision: row.revision });
const reconnectInput = (row: QualifiedGrantMetadata) => ({ ...fresh(row.accountKey), connectionId: row.connectionId, expectedRevision: row.revision });
let app: Pool;
let legacyBefore: unknown[];

/** Actual runtime role + caller-owned transaction; fixture sets exact identity, never the lifecycle module. */
async function bound<T>(who: QualifiedConnectorPrincipal, body: (client: PoolClient) => Promise<T>, operator = false): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.current_sub',$1,true), set_config('oshal.current_issuer',$2,true), "
      + "set_config('oshal.is_operator',$3,true)", [who.sub, who.principalIssuer, operator ? 'on' : 'off']);
    const value = await body(client);
    await client.query('COMMIT'); return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function saved(who: QualifiedConnectorPrincipal, connectionId: string) {
  return bound(who, async client => (await client.query('SELECT * FROM oshal_qualified_connections WHERE connection_id=$1', [connectionId])).rows[0]);
}
async function make(account: string, who = A) { return bound(who, client => create(client, who, fresh(account))); }

/** Observe an actual PostgreSQL lock dependency, not a sleep or a doubled query result. */
async function waitForBlock(waiter: number, locker: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.pool.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, locker]);
    if (result.rows[0].blocked === true) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('fixture did not observe the expected row-lock dependency');
}

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'qualified-grants-postgres-example-secret-sentinel');
  await db.start();
  await db.pool.query('ALTER TABLE oshal_qualified_deks OWNER TO oshal_app');
  await db.pool.query('ALTER TABLE oshal_qualified_connections OWNER TO oshal_app');
  app = db.rolePool('oshal_app');
  await db.pool.query(`INSERT INTO oshal_connections (user_sub,provider,account_key,access_token,refresh_token)
    VALUES ($1,'smartthings','legacy-account-sentinel','legacy-access-token-sentinel','legacy-refresh-token-sentinel')`, [A.sub]);
  legacyBefore = (await db.pool.query('SELECT * FROM oshal_connections')).rows;
}, 180_000);
afterAll(async () => { try { await db.stop(); } finally { vi.unstubAllEnvs(); } }, 60_000);

describe('qualified grants actual PostgreSQL companion (requires explicitly scheduled disposable runtime)', () => {
  it('uses a non-superuser/non-bypass table owner under FORCE RLS, without a definer helper', async () => {
    expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const tables = (await app.query(`SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owned
      FROM pg_class WHERE relname IN ('oshal_qualified_deks','oshal_qualified_connections')`)).rows;
    expect(tables).toHaveLength(2);
    for (const row of tables) expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true, owned: true });
    expect((await app.query("SELECT prosecdef FROM pg_proc WHERE proname='oshal_qualified_connection_revision'")).rows).toEqual([{ prosecdef: false }]);
  });

  it('stores fresh real ciphertext and returns only metadata, with independent same-sub issuer accounts', async () => {
    const first = await make('same-account-sentinel'), second = await make('same-account-sentinel', B);
    expect(first.connectionId).not.toBe(second.connectionId);
    for (const [who, row] of [[A, first], [B, second]] as const) {
      const stored = await saved(who, row.connectionId);
      expect(stored.access_token).toMatch(/^qct1:/); expect(stored.refresh_token).toMatch(/^qct1:/);
      expect(await bound(who, client => decrypt(client, who, stored.access_token))).toBe(fresh(row.accountKey).accessToken);
      expect(await bound(who, client => decrypt(client, who, stored.refresh_token))).toBe(fresh(row.accountKey).refreshToken);
      expect(await bound(who, client => list(client, who))).toEqual([row]);
      expect(Object.keys(row).sort()).toEqual(['connectionId', 'provider', 'accountKey', 'status', 'revision', 'expiresAt', 'createdAt', 'updatedAt'].sort());
    }
  });

  it('refuses sequential and racing account collisions without overwriting either credential', async () => {
    const row = await make('collision-account-sentinel'), before = await saved(A, row.connectionId);
    await expect(make('collision-account-sentinel')).rejects.toMatchObject({ code: 'conflict' });
    expect(await saved(A, row.connectionId)).toEqual(before);
    const results = await Promise.allSettled([make('racing-account-sentinel'), make('racing-account-sentinel')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'conflict' });
    const stored = await bound(A, client => client.query("SELECT connection_id FROM oshal_qualified_connections WHERE account_key='racing-account-sentinel'"));
    expect(stored.rows).toHaveLength(1);
  });

  it('gets an exact UUID beyond page one; foreign/missing and misbound reads reveal no metadata', async () => {
    const who = { ...A, sub: 'get-owner-sentinel' };
    const rows = await Promise.all(['get-one-sentinel', 'get-two-sentinel', 'get-three-sentinel'].map(account => make(account, who)));
    rows.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
    expect((await bound(who, client => list(client, who, { limit: 1 })))[0].connectionId).not.toBe(rows[2].connectionId);
    expect(await bound(who, client => get(client, who, { connectionId: rows[2].connectionId }))).toEqual(rows[2]);
    for (const foreign of [{ ...who, principalIssuer: B.principalIssuer }, { ...who, sub: 'get-foreign-sub-sentinel' }]) {
      await expect(bound(foreign, client => get(client, foreign, { connectionId: rows[2].connectionId }), true))
        .rejects.toMatchObject({ code: 'not_found_or_stale' });
      await expect(bound(foreign, client => get(client, who, { connectionId: rows[2].connectionId }), true))
        .rejects.toMatchObject({ code: 'not_found_or_stale' });
    }
    await expect(bound(who, client => get(client, who, { connectionId: randomUUID() }))).rejects.toMatchObject({ code: 'not_found_or_stale' });
  });

  it.each([undefined, null, 'postgres-new-refresh-token-sentinel'])('reconnect uses only fresh credentials; refresh %s and database revision', async refreshToken => {
    const row = await make('reconnect-' + randomUUID()), old = await saved(A, row.connectionId);
    const next = await bound(A, client => reconnect(client, A, { ...reconnectInput(row),
      accessToken: 'postgres-new-access-token-sentinel', refreshToken, expiresAt: null }));
    const stored = await saved(A, row.connectionId);
    expect(next).toMatchObject({ revision: '2', status: 'connected', expiresAt: null });
    expect(stored.access_token).not.toBe(old.access_token);
    expect(await bound(A, client => decrypt(client, A, stored.access_token))).toBe('postgres-new-access-token-sentinel');
    if (refreshToken) expect(await bound(A, client => decrypt(client, A, stored.refresh_token))).toBe(refreshToken);
    else expect(stored.refresh_token).toBeNull();
  });

  it('cannot read/reconnect/revoke another issuer or subject, including with operator flag', async () => {
    const row = await make('foreign-account-sentinel'), before = await saved(A, row.connectionId);
    for (const who of [B, { ...A, sub: 'foreign-sub-sentinel' }]) {
      await expect(bound(who, client => reconnect(client, who, reconnectInput(row)), true)).rejects.toMatchObject({ code: 'not_found_or_stale' });
      await expect(bound(who, client => revoke(client, who, target(row)), true)).rejects.toMatchObject({ code: 'not_found_or_stale' });
      expect((await bound(who, client => list(client, who), true)).some(item => item.connectionId === row.connectionId)).toBe(false);
    }
    expect(await saved(A, row.connectionId)).toEqual(before);
  });

  it('a misbound or unscoped query port cannot broaden authority, even when explicit input names the actual owner', async () => {
    const row = await make('misbound-account-sentinel'), before = await saved(A, row.connectionId);
    await expect(bound(B, client => reconnect(client, A, reconnectInput(row)))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    await expect(bound(B, client => revoke(client, A, target(row)))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    await expect(bound(B, client => create(client, A, fresh('misbound-create-sentinel')))).rejects.toMatchObject({ code: 'storage_failure' });
    expect(await list(app, A)).toEqual([]);
    expect(await saved(A, row.connectionId)).toEqual(before);
  });

  it.each(['uuid', 'provider', 'account', 'revision'])('refuses exact target mismatch %s without changing the original grant', async wrong => {
    const row = await make('mismatch-' + randomUUID()), before = await saved(A, row.connectionId), chosen = target(row);
    if (wrong === 'uuid') chosen.connectionId = randomUUID();
    if (wrong === 'provider') chosen.provider = 'nest';
    if (wrong === 'account') chosen.accountKey = 'other-account-sentinel';
    if (wrong === 'revision') chosen.expectedRevision = '2';
    await expect(bound(A, client => reconnect(client, A, { ...fresh(chosen.accountKey), ...chosen,
      validatedIdentity: { provider: chosen.provider, accountKey: chosen.accountKey } }))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    await expect(bound(A, client => revoke(client, A, chosen))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(await saved(A, row.connectionId)).toEqual(before);
  });

  it('revoke removes refresh capability, increments revision and rejects stale reconnect/revoke', async () => {
    const row = await make('revoke-account-sentinel'), revoked = await bound(A, client => revoke(client, A, target(row)));
    expect(revoked).toMatchObject({ status: 'revoked', revision: '2' });
    expect((await saved(A, row.connectionId)).refresh_token).toBeNull();
    await expect(bound(A, client => reconnect(client, A, reconnectInput(row)))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    await expect(bound(A, client => revoke(client, A, target(row)))).rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(await bound(A, client => reconnect(client, A, { ...reconnectInput(revoked), refreshToken: undefined })))
      .toMatchObject({ status: 'connected', revision: '3' });
  });

  it('concurrent reconnect and revoke on the same revision have exactly one winner', async () => {
    const row = await make('cas-race-account-sentinel');
    const results = await Promise.allSettled([bound(A, client => reconnect(client, A, reconnectInput(row))),
      bound(A, client => revoke(client, A, target(row)))]);
    const winners = results.filter(result => result.status === 'fulfilled') as PromiseFulfilledResult<QualifiedGrantMetadata>[];
    const losers = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    expect(winners).toHaveLength(1); expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ code: 'not_found_or_stale' });
    expect(await saved(A, row.connectionId)).toMatchObject({ revision: '2', status: winners[0].value.status });
  });

  it('holds reconnect lock across crypto awaits; queued stale revoke cannot overwrite its committed result', async () => {
    const row = await make('lock-account-sentinel');
    let reached!: () => void, release!: () => void, queued!: (pid: number) => void, locker = 0;
    const locked = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<number>(resolve => { queued = resolve; });
    const first = bound(A, async client => {
      locker = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return reconnect({ query: async (sql, values) => {
        if (sql.startsWith('SELECT wrapped_dek')) { reached(); await gate; }
        return client.query(sql, values);
      } }, A, reconnectInput(row));
    });
    // Release the gate on an early error too; no failed setup can leave an owned connection blocked.
    void first.catch(() => { reached(); release(); });
    await locked;
    const second = bound(A, async client => {
      queued((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return revoke(client, A, target(row));
    });
    void second.catch(() => { queued(0); });
    const settled = Promise.allSettled([first, second]);
    try { await waitForBlock(await waiting, locker); }
    finally { release(); await settled; }
    const results = await settled;
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { revision: '2', status: 'connected' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'not_found_or_stale' } });
  });

  it('rolls back both fresh key and grant on caller abort, without adopting same-sub legacy rows', async () => {
    const who = { ...A, sub: 'rollback-owner-sentinel' };
    await expect(bound(who, async client => { await create(client, who, fresh('rollback-account-sentinel')); throw new Error('fixture abort sentinel'); }))
      .rejects.toThrow('fixture abort sentinel');
    await bound(who, async client => {
      expect(await list(client, who)).toEqual([]);
      expect((await client.query('SELECT * FROM oshal_qualified_deks')).rows).toEqual([]);
    });
    const created = await make('legacy-account-sentinel');
    expect(created).toMatchObject({ revision: '1', status: 'connected' });
    expect((await db.pool.query('SELECT * FROM oshal_connections')).rows).toEqual(legacyBefore);
  });

  it('lists only paged metadata while preserving explicit expired and reconnect-required state', async () => {
    const who = { ...A, sub: 'list-owner-sentinel' };
    const rows = await Promise.all(['one-sentinel', 'two-sentinel', 'three-sentinel'].map(account => make(account, who)));
    rows.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
    await bound(who, client => client.query("UPDATE oshal_qualified_connections SET status='needs_reconnect',expiry='2020-01-01T00:00:00Z' WHERE connection_id=$1", [rows[0].connectionId]));
    const first = await bound(who, client => list(client, who, { limit: 1 }));
    expect(first[0]).toMatchObject({ connectionId: rows[0].connectionId, status: 'needs_reconnect', revision: '2', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(await bound(who, client => list(client, who, { afterConnectionId: first[0].connectionId, limit: 2 }))).toEqual(rows.slice(1));
    expect(JSON.stringify(first)).not.toMatch(/qct1:|qdk1:|access_token|refresh_token|owner_sub|principal_issuer/);
  });
});
