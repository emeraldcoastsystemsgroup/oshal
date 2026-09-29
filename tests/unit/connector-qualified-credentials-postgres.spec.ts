/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prepare real disposable PostgreSQL upgrade/RLS regressions for qualified personal credentials. SOURCE ONLY until explicitly scheduled; no provider or deployed-store proof.
 */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import {
  decryptQualifiedConnectorToken as decrypt, encryptQualifiedConnectorToken as encrypt,
  type QualifiedConnectorPrincipal,
} from '@/app/routes/connector-qualified-token-crypto';
import { decryptToken as decryptLegacy, encryptToken as encryptLegacy } from '@/app/routes/connector-token-crypto';

const db = new DisposablePostgres({ purpose: 'qualified-connector-credentials', roles: ['oshal_app', 'oshal_bot'],
  migrations: ['060-platform-rls-tenancy.sql', '100-connector-base-schema.sql'] });
const migration = readFileSync(resolve(__dirname, '../../scripts/migrations/181-qualified-connector-credentials.sql'), 'utf8');
const A = { sub: 'qualified-same-sub-sentinel', principalIssuer: 'https://first.example.com' };
const B = { ...A, principalIssuer: 'https://second.example.com' };
const SECRET = 'qualified-postgres-test-secret-sentinel';
const PLAIN = 'qualified-postgres-token-sentinel';
let app: Pool;
let legacyBefore: { connections: unknown[]; deks: unknown[] };

/** Fixture sessions use one actual runtime-role transaction, never a mock pool or operator bypass. */
async function asPrincipal<T>(who: QualifiedConnectorPrincipal, body: (client: PoolClient) => Promise<T>, operator = false): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.current_sub',$1,true), set_config('oshal.current_issuer',$2,true), "
      + "set_config('oshal.is_operator',$3,true)", [who.sub, who.principalIssuer, operator ? 'on' : 'off']);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Legacy format fixture only: generated in memory, never a stored deployment credential. */
function rawLegacyToken(): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), nonce);
  const bytes = Buffer.concat([cipher.update(PLAIN, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), bytes].map(value => value.toString('base64')).join(':');
}

const legacySnapshot = async () => ({
  connections: (await db.pool.query('SELECT * FROM oshal_connections ORDER BY connection_id')).rows,
  deks: (await db.pool.query('SELECT * FROM oshal_user_deks ORDER BY user_sub')).rows,
});

/** Seed mixed pre-upgrade formats with the old codec, then apply the actual migration. */
beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('OSHAL_ENVELOPE_CRYPTO', 'true');
  vi.stubEnv('OSHAL_ENVELOPE_DEK_FAILURE', 'deny');
  await db.start();
  const envelope = await encryptLegacy(db.pool, A.sub, PLAIN);
  vi.stubEnv('OSHAL_ENVELOPE_CRYPTO', 'false');
  const shared = await encryptLegacy(db.pool, A.sub, PLAIN);
  for (const [index, blob] of [rawLegacyToken(), shared, envelope].entries()) {
    await db.pool.query(`INSERT INTO oshal_connections (user_sub,provider,account_key,access_token,refresh_token)
      VALUES ($1,'smartthings',$2,$3,$3)`, [A.sub, 'legacy-' + index, blob]);
  }
  legacyBefore = await legacySnapshot();
  await db.pool.query(migration);
  await db.pool.query('ALTER TABLE oshal_qualified_deks OWNER TO oshal_app');
  await db.pool.query('ALTER TABLE oshal_qualified_connections OWNER TO oshal_app');
  app = db.rolePool('oshal_app');
}, 180_000);
afterAll(async () => { try { await db.stop(); } finally { vi.unstubAllEnvs(); } }, 60_000);

/** One fresh account, encrypted inside the same bound runtime transaction. */
async function connect(who: QualifiedConnectorPrincipal, account: string) {
  return asPrincipal(who, async client => {
    const blob = await encrypt(client, who, PLAIN);
    const result = await client.query(`INSERT INTO oshal_qualified_connections
      (principal_issuer,owner_sub,provider,account_key,access_token,refresh_token)
      VALUES ($1,$2,'smartthings',$3,$4,$4) RETURNING connection_id,revision`,
    [who.principalIssuer, who.sub, account, blob]);
    return { ...result.rows[0], blob };
  });
}

describe('qualified credential migration and actual enforcing-role boundary (requires disposable PostgreSQL)', () => {
  it('has an enforcing table-owner role, exact-identity FORCE RLS, no public/bot credential grants or definer helper', async () => {
    expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
      .toEqual({ rolsuper: false, rolbypassrls: false });
    const tables = (await app.query(`SELECT relname,relrowsecurity,relforcerowsecurity,
      pg_get_userbyid(relowner)=current_user AS owned FROM pg_class
      WHERE relname IN ('oshal_qualified_connections','oshal_qualified_deks')`)).rows;
    expect(tables).toHaveLength(2);
    for (const row of tables) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owned: true });
    expect((await app.query(`SELECT prosecdef FROM pg_proc WHERE proname='oshal_qualified_connection_revision'`)).rows)
      .toEqual([{ prosecdef: false }]);
    for (const table of ['oshal_qualified_connections', 'oshal_qualified_deks']) {
      expect((await app.query('SELECT has_table_privilege($1,$2,$3) AS ok', ['oshal_bot', table, 'SELECT'])).rows[0].ok).toBe(false);
      expect((await app.query(`SELECT acl.privilege_type FROM pg_class relation,
        LATERAL aclexplode(relation.relacl) acl WHERE relation.oid=$1::regclass AND acl.grantee=0`, [table])).rows).toEqual([]);
    }
  });

  it('keeps legacy connections/DEKs byte-for-byte unchanged, readable only by their unchanged legacy codec', async () => {
    expect(await legacySnapshot()).toEqual(legacyBefore);
    const rows = (await db.pool.query('SELECT access_token FROM oshal_connections')).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(await decryptLegacy(db.pool, A.sub, row.access_token)).toBe(PLAIN);
    for (const row of rows) await expect(asPrincipal(A, client => decrypt(client, A, row.access_token))).rejects.toThrow('decrypt failed');
    expect(await legacySnapshot()).toEqual(legacyBefore);
  });

  it('allows two same-sub issuers to keep the same provider/account independently, and refuses cross-issuer access even with operator on', async () => {
    const one = await connect(A, 'same-account-sentinel'), two = await connect(B, 'same-account-sentinel');
    expect(one.connection_id).not.toBe(two.connection_id);
    for (const [who, mine, other] of [[A, one, two], [B, two, one]] as const) {
      await asPrincipal(who, async client => {
        const rows = (await client.query('SELECT connection_id FROM oshal_qualified_connections WHERE account_key=$1',
          ['same-account-sentinel'])).rows;
        expect(rows).toEqual([{ connection_id: mine.connection_id }]);
        expect(await decrypt(client, who, mine.blob)).toBe(PLAIN);
        await expect(decrypt(client, who, other.blob)).rejects.toThrow('decrypt failed');
        expect((await client.query('UPDATE oshal_qualified_connections SET status=$2 WHERE connection_id=$1',
          [other.connection_id, 'revoked'])).rowCount).toBe(0);
        expect((await client.query('DELETE FROM oshal_qualified_connections WHERE connection_id=$1', [other.connection_id])).rowCount).toBe(0);
        expect((await client.query('SELECT owner_sub FROM oshal_qualified_deks')).rows).toEqual([{ owner_sub: who.sub }]);
        expect((await client.query('UPDATE oshal_qualified_deks SET wrapped_dek=$2 WHERE principal_issuer=$1',
          [who === A ? B.principalIssuer : A.principalIssuer, 'qdk1:refused-sentinel'])).rowCount).toBe(0);
      }, true);
    }
    expect(await legacySnapshot()).toEqual(legacyBefore);
  });

  it('denies wrong-session insertion and crypto lookup, blank issuer and unscoped sessions', async () => {
    await expect(asPrincipal(A, client => client.query(`INSERT INTO oshal_qualified_deks
      (principal_issuer,owner_sub,wrapped_dek) VALUES ($1,$2,'qdk1:refused-sentinel')`,
    [B.principalIssuer, 'foreign-sub-sentinel']))).rejects.toMatchObject({ code: '42501' });
    await expect(asPrincipal(A, client => encrypt(client, B, PLAIN))).rejects.toThrow('encrypt failed');
    for (const who of [{ ...A, principalIssuer: '' }, { ...A, sub: '' }, { sub: '', principalIssuer: '' }]) {
      await asPrincipal(who, async client => {
        expect((await client.query('SELECT * FROM oshal_qualified_connections')).rows).toEqual([]);
        expect((await client.query('SELECT * FROM oshal_qualified_deks')).rows).toEqual([]);
      }, true);
    }
    expect((await app.query('SELECT * FROM oshal_qualified_deks')).rows).toEqual([]);
  });

  it('keeps exact issuer spelling distinct rather than canonicalizing case or trailing slash', async () => {
    const who = { ...A, principalIssuer: 'https://FIRST.example.com/' };
    const row = await connect(who, 'same-account-sentinel');
    await asPrincipal(A, async client => {
      expect((await client.query('SELECT connection_id FROM oshal_qualified_connections WHERE connection_id=$1', [row.connection_id])).rows).toEqual([]);
    });
    expect(await asPrincipal(who, client => decrypt(client, who, row.blob))).toBe(PLAIN);
  });

  it('rejects owner/account reassignment and changes revision on ciphertext/status updates', async () => {
    const who = { ...A, sub: 'revision-owner-sentinel' }, row = await connect(who, 'revision-account-sentinel');
    expect(row.revision).toBe('1');
    await asPrincipal(who, async client => {
      const next = await encrypt(client, who, 'replacement-sentinel');
      const updated = (await client.query(`UPDATE oshal_qualified_connections SET access_token=$2,revision=999
        WHERE connection_id=$1 AND revision=1 RETURNING revision`, [row.connection_id, next])).rows[0];
      expect(updated.revision).toBe('2');
      expect((await client.query('UPDATE oshal_qualified_connections SET status=$2 WHERE connection_id=$1 AND revision=1',
        [row.connection_id, 'revoked'])).rowCount).toBe(0);
    });
    await expect(asPrincipal(who, client => client.query('UPDATE oshal_qualified_connections SET account_key=$2 WHERE connection_id=$1',
      [row.connection_id, 'other-account-sentinel']))).rejects.toMatchObject({ code: '23514' });
    await expect(asPrincipal(who, client => client.query('UPDATE oshal_qualified_connections SET principal_issuer=$2 WHERE connection_id=$1',
      [row.connection_id, B.principalIssuer]))).rejects.toThrow();
  });

  it('does not mint a key on decrypt and rolls back fresh encryption/key creation with its caller transaction', async () => {
    const source = await connect(A, 'missing-key-source-sentinel');
    const missing = { ...A, sub: 'no-key-sentinel' };
    await expect(asPrincipal(missing, client => decrypt(client, missing, source.blob))).rejects.toThrow('decrypt failed');
    const rollback = { ...A, sub: 'rollback-key-sentinel' };
    await expect(asPrincipal(rollback, async client => {
      await encrypt(client, rollback, PLAIN);
      throw new Error('synthetic abort sentinel');
    })).rejects.toThrow('synthetic abort sentinel');
    for (const who of [missing, rollback]) {
      expect(await asPrincipal(who, async client => (await client.query('SELECT * FROM oshal_qualified_deks')).rows)).toEqual([]);
    }
  });

  it('does not duplicate keys during concurrent first encryption and reruns migration without adopting legacy data', async () => {
    const who = { ...A, sub: 'racing-owner-sentinel' };
    const blobs = await Promise.all([asPrincipal(who, client => encrypt(client, who, 'one-sentinel')),
      asPrincipal(who, client => encrypt(client, who, 'two-sentinel'))]);
    await asPrincipal(who, async client => {
      expect((await client.query('SELECT * FROM oshal_qualified_deks')).rows).toHaveLength(1);
      expect(await decrypt(client, who, blobs[0])).toBe('one-sentinel');
      expect(await decrypt(client, who, blobs[1])).toBe('two-sentinel');
    });
    await db.pool.query(migration);
    expect(await legacySnapshot()).toEqual(legacyBefore);
    expect(await asPrincipal(who, client => decrypt(client, who, blobs[0]))).toBe('one-sentinel');
  });
});
