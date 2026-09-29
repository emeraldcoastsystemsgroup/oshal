/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prepare actual PostgreSQL/pg/GUC/crypto/broker microsecond-CAS and replacement regressions under an enforcing role. Source only until a separately authorized fixture run; provider alone is doubled.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { wrapPoolWithRuntimeDdlGuard } from '@/shared/services/database/schema-bootstrap-policy';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { withQualifiedConnectorSession as session } from '@/app/routes/connector-qualified-session';
import { resolveQualifiedPersonalCredential as resolveCredential } from '@/app/routes/connector-qualified-broker';
import { encryptQualifiedConnectorToken as encrypt, decryptQualifiedConnectorToken as decrypt,
  type QualifiedConnectorPrincipal } from '@/app/routes/connector-qualified-token-crypto';

const fixture = new DisposablePostgres({ purpose: 'qualified-connector-broker',
  roles: [{ name: 'oshal_app', max: 3, options: '-c TimeZone=America/New_York' }],
  migrations: ['181-qualified-connector-credentials.sql'] });
const A = { sub: 'broker-pg-same-sub-sentinel', principalIssuer: 'https://first.example.com' };
const B = { ...A, principalIssuer: 'https://second.example.com' };
const CREATED = '2026-09-29T11:58:20.123456Z';
const EXPIRED = '2001-01-01T00:00:00.987654Z';
const SQL_FORMAT = '\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'';
let db: Pool;

/** Synthetic authenticated fixture identity drives the production ALS/GUC path, not a SQL scope double. */
function asOwner<T>(who: QualifiedConnectorPrincipal, work: () => T): T {
  return runWithRequestIdentity({ ...who, isOperator: false }, work);
}
const selection = (connectionId: string) => ({ connectionId, provider: 'smartthings', expectedRevision: '1' });
const providerResult = () => ({ accessToken: 'pg-rotated-access-sentinel', refreshToken: 'pg-rotated-refresh-sentinel',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET', 'qualified-broker-pg-secret-sentinel');
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  await fixture.start();
  await fixture.pool.query('ALTER TABLE oshal_qualified_deks OWNER TO oshal_app');
  await fixture.pool.query('ALTER TABLE oshal_qualified_connections OWNER TO oshal_app');
  db = wrapPoolWithRuntimeDdlGuard(wrapPoolWithGuc(fixture.rolePool('oshal_app')));
}, 180_000);
afterAll(async () => { try { await fixture.stop(); } finally { vi.unstubAllEnvs(); } }, 60_000);

/** Real encryption plus INSERT in the same production owner session; no inherited DSN or legacy credential. */
async function seed(who = A, created = CREATED, expiry = EXPIRED, account = randomUUID()) {
  return asOwner(who, () => session(db, who, async client => {
    const access = await encrypt(client, who, 'pg-original-access-sentinel');
    const refresh = await encrypt(client, who, 'pg-original-refresh-sentinel');
    const result = await client.query(`INSERT INTO oshal_qualified_connections
      (principal_issuer,owner_sub,provider,account_key,access_token,refresh_token,created_at,expiry)
      VALUES ($1,$2,'smartthings',$3,$4,$5,$6::timestamptz,$7::timestamptz) RETURNING connection_id`,
    [who.principalIssuer, who.sub, account, access, refresh, created, expiry]);
    return String(result.rows[0].connection_id);
  }));
}

/** Authoritative row and exact UTC text, read through enforcing role and the real pg decoder. */
async function stored(who: QualifiedConnectorPrincipal, id: string) {
  return asOwner(who, async () => (await db.query(`SELECT connection_id,revision,access_token,refresh_token,created_at,expiry,
    to_char(created_at AT TIME ZONE 'UTC',${SQL_FORMAT}) AS created_exact,
    to_char(expiry AT TIME ZONE 'UTC',${SQL_FORMAT}) AS expiry_exact
    FROM oshal_qualified_connections WHERE connection_id=$1`, [id])).rows[0]);
}

/** Real owner delete/reinsert preserves every field/revision except the microsecond creation witness. */
async function replaceCreation(who: QualifiedConnectorPrincipal, id: string) {
  return asOwner(who, () => session(db, who, async client => {
    const row = (await client.query('DELETE FROM oshal_qualified_connections WHERE connection_id=$1 RETURNING *', [id])).rows[0];
    await client.query(`INSERT INTO oshal_qualified_connections
      (connection_id,principal_issuer,owner_sub,provider,account_key,access_token,refresh_token,created_at,expiry)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
    [id, who.principalIssuer, who.sub, row.provider, row.account_key, row.access_token, row.refresh_token,
      '2026-09-29T11:58:20.123457Z', EXPIRED]);
  }));
}

describe('qualified broker actual PostgreSQL timestamp/CAS/RLS boundary (source-only until scheduled)', () => {
  it('uses a non-bypass table-owner role with FORCE RLS and exact request GUCs', async () => {
    const role = (await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const tables = (await db.query(`SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owned
      FROM pg_class WHERE relname IN ('oshal_qualified_connections','oshal_qualified_deks')`)).rows;
    expect(tables).toHaveLength(2);
    for (const row of tables) expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true, owned: true });
    const gucs = await asOwner(A, async () => (await db.query(`SELECT current_setting('oshal.current_issuer') AS issuer,
      current_setting('oshal.current_sub') AS sub,current_setting('oshal.is_operator') AS operator`)).rows[0]);
    expect(gucs).toEqual({ issuer: A.principalIssuer, sub: A.sub, operator: 'off' });
  });

  it('demonstrates native pg Date truncation and old equality failure against an unchanged six-digit row', async () => {
    const id = await seed(), row = await stored(A, id);
    expect(row.created_at).toBeInstanceOf(Date); expect(row.expiry).toBeInstanceOf(Date);
    expect(row.created_at.toISOString()).toBe('2026-09-29T11:58:20.123Z');
    expect(row.expiry.toISOString()).toBe('2001-01-01T00:00:00.987Z');
    expect(row.created_exact).toBe(CREATED); expect(row.expiry_exact).toBe(EXPIRED);
    const equality = await asOwner(A, async () => (await db.query(`SELECT created_at=$2::timestamptz AS created_matches,
      expiry=$3::timestamptz AS expiry_matches FROM oshal_qualified_connections WHERE connection_id=$1`,
    [id, row.created_at.toISOString(), row.expiry.toISOString()])).rows[0]);
    expect(equality).toEqual({ created_matches: false, expiry_matches: false });
  });

  it.each(['created_at', 'expiry', 'both'])('commits a real broker refresh with microsecond %s and retains rotated credentials', async field => {
    const created = field === 'expiry' ? '2026-09-29T11:58:20.123000Z' : CREATED;
    const expiry = field === 'created_at' ? '2001-01-01T00:00:00.987000Z' : EXPIRED;
    const id = await seed(A, created, expiry), output = providerResult();
    const refresh = vi.fn(async () => output);
    const result = await asOwner(A, () => resolveCredential(db, A, selection(id), { refresh }));
    expect(result).toMatchObject({ connectionId: id, revision: '2', accessToken: output.accessToken, expiresAt: output.expiresAt });
    expect(refresh).toHaveBeenCalledOnce();
    const row = await stored(A, id);
    expect(row.revision).toBe('2'); expect(row.created_exact).toBe(created);
    expect(await asOwner(A, () => decrypt(db, A, row.access_token))).toBe(output.accessToken);
    expect(await asOwner(A, () => decrypt(db, A, row.refresh_token))).toBe(output.refreshToken);
    await expect(asOwner(A, () => resolveCredential(db, A, selection(id), { refresh })))
      .rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refuses same-revision delete/reinsert differing only in creation microseconds after provider settlement', async () => {
    const id = await seed(), original = await stored(A, id);
    const refresh = vi.fn(async () => { await replaceCreation(A, id); return providerResult(); });
    await expect(asOwner(A, () => resolveCredential(db, A, selection(id), { refresh })))
      .rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(refresh).toHaveBeenCalledOnce();
    const replacement = await stored(A, id);
    expect(replacement.revision).toBe('1'); expect(replacement.created_exact).toBe('2026-09-29T11:58:20.123457Z');
    expect(replacement.created_at.getTime()).toBe(original.created_at.getTime());
    expect(replacement.access_token).toBe(original.access_token); expect(replacement.refresh_token).toBe(original.refresh_token);
  });

  it.each(['revoke', 'replace'])('does not persist a rotated result after real %s during provider await', async mode => {
    const id = await seed(), original = await stored(A, id);
    const refresh = vi.fn(async () => {
      await asOwner(A, () => session(db, A, async client => {
        if (mode === 'revoke') await client.query("UPDATE oshal_qualified_connections SET status='revoked' WHERE connection_id=$1", [id]);
        else await client.query('UPDATE oshal_qualified_connections SET access_token=$2 WHERE connection_id=$1',
          [id, await encrypt(client, A, 'pg-replaced-access-sentinel')]);
      }));
      return providerResult();
    });
    await expect(asOwner(A, () => resolveCredential(db, A, selection(id), { refresh })))
      .rejects.toMatchObject({ code: 'not_found_or_stale' });
    expect(refresh).toHaveBeenCalledOnce();
    const row = await stored(A, id);
    expect(row.revision).toBe('2'); expect(row.refresh_token).toBe(original.refresh_token);
  });

  it('does not select or refresh the same-sub foreign issuer row through enforcing RLS', async () => {
    const account = randomUUID(), one = await seed(A, CREATED, EXPIRED, account), two = await seed(B, CREATED, EXPIRED, account);
    const refresh = vi.fn(async () => providerResult());
    for (const [who, other] of [[A, two], [B, one]] as const) {
      expect(await stored(who, other)).toBeUndefined();
      await expect(asOwner(who, () => resolveCredential(db, who, selection(other), { refresh })))
        .rejects.toMatchObject({ code: 'not_found_or_stale' });
    }
    expect(refresh).not.toHaveBeenCalled();
    expect((await stored(A, one)).revision).toBe('1'); expect((await stored(B, two)).revision).toBe('1');
  });
});
