/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (B1-B3) on a private PostgreSQL whose runtime role is NOSUPERUSER NOBYPASSRLS, through the real GUC-stamping pool: with buildPortalDefaultRlsPolicyStatements applied to a settings table, a person reads their own row and the portal-default row and nobody else's; a person cannot insert, update or delete the portal-default row, move a row onto or off it, upsert onto its key or lock it (the database refuses, whatever a route layer misses); an operator can; a falsy own value is kept over a truthy portal default; an anonymous read sees only the portal default; resolvePortalDefault answers own, then portal-default, then null, and never reads another person's row. Each fails on the tree before the fix.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPortalDefaultRlsPolicyStatements } from '@/shared/services/database';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { PORTAL_DEFAULT_OWNER, isPortalDefaultOwner, resolvePortalDefault } from '@/shared/portal-default';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const RUNTIME = 'oshal_app_fixture';
const TABLE = 'settings_fixture';
const A = 'idp-person-a';
const B = 'idp-person-b';
const C = 'local-0123456789abcdef';

const database = new DisposablePostgres({ purpose: 'portal-default-rows', roles: [{ name: RUNTIME, max: 4 }], max: 4 });
let owner: Pool;
let runtime: Pool;

/** Runs one query as a signed-in person (or an operator, or nobody) through the GUC-stamping runtime pool. */
const as = (sub: string | null, isOperator = false) => (text: string, params: unknown[] = []) =>
  runWithRequestIdentity({ sub, isOperator }, () => runtime.query(text, params));

/** The value column of one owner's row, read as the given identity. */
const readValue = (sub: string | null) => async (rowOwner: string): Promise<string | null> => {
  const { rows } = await as(sub)(`SELECT value FROM ${TABLE} WHERE owner_sub = $1 AND key = 'theme'`, [rowOwner]);
  return (rows[0]?.value as string | undefined) ?? null;
};

beforeAll(async () => {
  owner = await database.start();
  await owner.query(`CREATE TABLE ${TABLE} (owner_sub TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_sub, key))`);
  // Applied twice: the statements are idempotent, as a boot-time bootstrap re-runs them.
  for (const pass of [1, 2]) for (const statement of buildPortalDefaultRlsPolicyStatements(TABLE, 'owner_sub')) await owner.query(statement).catch((err) => { throw new Error(`pass ${pass}: ${(err as Error).message}`); });
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${RUNTIME}`);
  await owner.query(`INSERT INTO ${TABLE} (owner_sub, key, value) VALUES ($1, 'theme', 'portal-dark'), ($2, 'theme', 'a-light'), ($3, 'theme', 'b-light')`, [PORTAL_DEFAULT_OWNER, A, B]);
  runtime = wrapPoolWithGuc(database.rolePool(RUNTIME));
}, 120_000);

afterAll(async () => { await database.stop(); });

describe('the policy statements', () => {
  it('are the owner-or-operator policy plus one SELECT policy for the portal-default row', () => {
    const statements = buildPortalDefaultRlsPolicyStatements('t', 'owner_sub');
    expect(statements.some((s) => s.includes('t_owner_or_operator'))).toBe(true);
    const read = statements.find((s) => s.includes('t_read_portal_default'));
    expect(read).toMatch(/FOR SELECT/);
    expect(read).toContain(`owner_sub = '${PORTAL_DEFAULT_OWNER}'`);
    expect(read).not.toMatch(/WITH CHECK/);
  });
});

describe('under the enforcing runtime role', () => {
  it('a person reads their own row and the portal default, and nobody else\'s', async () => {
    const { rows } = await as(A)(`SELECT owner_sub FROM ${TABLE} ORDER BY owner_sub`);
    expect(rows.map((r) => r.owner_sub)).toEqual([A, PORTAL_DEFAULT_OWNER]);
  });

  it('an anonymous read sees only the portal default', async () => {
    const { rows } = await as(null)(`SELECT owner_sub FROM ${TABLE}`);
    expect(rows.map((r) => r.owner_sub)).toEqual([PORTAL_DEFAULT_OWNER]);
  });

  it('a person cannot insert, update or delete the portal-default row; the database refuses', async () => {
    await expect(as(A)(`INSERT INTO ${TABLE} (owner_sub, key, value) VALUES ($1, 'motd', 'mine')`, [PORTAL_DEFAULT_OWNER])).rejects.toThrow(/row-level security/);
    expect((await as(A)(`UPDATE ${TABLE} SET value = 'hijacked' WHERE owner_sub = $1`, [PORTAL_DEFAULT_OWNER])).rowCount).toBe(0);
    expect((await as(A)(`DELETE FROM ${TABLE} WHERE owner_sub = $1`, [PORTAL_DEFAULT_OWNER])).rowCount).toBe(0);
    // Nor another person's row.
    expect((await as(A)(`UPDATE ${TABLE} SET value = 'hijacked' WHERE owner_sub = $1`, [B])).rowCount).toBe(0);
    const { rows } = await owner.query(`SELECT owner_sub, value FROM ${TABLE} WHERE value = 'hijacked'`);
    expect(rows).toEqual([]);
    // Their own row is theirs to change.
    expect((await as(A)(`UPDATE ${TABLE} SET value = 'a-dark' WHERE owner_sub = $1`, [A])).rowCount).toBe(1);
  });

  it('a person cannot move a row onto or off the portal default, upsert onto its key, or lock it', async () => {
    await expect(as(A)(`UPDATE ${TABLE} SET owner_sub = $1, key = 'moved' WHERE owner_sub = $2 AND key = 'theme'`, [PORTAL_DEFAULT_OWNER, A])).rejects.toThrow(/row-level security/);
    expect((await as(A)(`UPDATE ${TABLE} SET owner_sub = $1, key = 'stolen' WHERE owner_sub = $2 RETURNING *`, [A, PORTAL_DEFAULT_OWNER])).rowCount).toBe(0);
    await expect(as(A)(`INSERT INTO ${TABLE} (owner_sub, key, value) VALUES ($1, 'theme', 'pwn') ON CONFLICT (owner_sub, key) DO UPDATE SET value = EXCLUDED.value`, [PORTAL_DEFAULT_OWNER])).rejects.toThrow(/row-level security/);
    expect((await as(A)(`SELECT 1 FROM ${TABLE} WHERE owner_sub = $1 FOR UPDATE`, [PORTAL_DEFAULT_OWNER])).rowCount).toBe(0);
    const { rows } = await owner.query(`SELECT owner_sub, key, value FROM ${TABLE} WHERE owner_sub = $1`, [PORTAL_DEFAULT_OWNER]);
    expect(rows).toEqual([{ owner_sub: PORTAL_DEFAULT_OWNER, key: 'theme', value: 'portal-dark' }]);
  });

  it('an operator writes the portal-default row', async () => {
    expect((await as('idp-admin', true)(`UPDATE ${TABLE} SET value = 'portal-light' WHERE owner_sub = $1`, [PORTAL_DEFAULT_OWNER])).rowCount).toBe(1);
    await as('idp-admin', true)(`INSERT INTO ${TABLE} (owner_sub, key, value) VALUES ($1, 'motd', 'welcome')`, [PORTAL_DEFAULT_OWNER]);
    expect((await owner.query(`SELECT value FROM ${TABLE} WHERE owner_sub = $1 ORDER BY key`, [PORTAL_DEFAULT_OWNER])).rows.map((r) => r.value)).toEqual(['welcome', 'portal-light']);
  });

  it('resolvePortalDefault answers own, then portal-default, then null, through the runtime pool', async () => {
    expect(await resolvePortalDefault(readValue(A), A)).toEqual({ value: 'a-dark', source: 'own' });
    expect(await resolvePortalDefault(readValue(C), C)).toEqual({ value: 'portal-light', source: 'portal-default' });
    expect(await resolvePortalDefault(readValue(null), null)).toEqual({ value: 'portal-light', source: 'portal-default' });
    await owner.query(`DELETE FROM ${TABLE} WHERE owner_sub = $1 AND key = 'theme'`, [PORTAL_DEFAULT_OWNER]);
    expect(await resolvePortalDefault(readValue(C), C)).toBeNull();
    expect(await resolvePortalDefault(readValue(A), A)).toEqual({ value: 'a-dark', source: 'own' });
  });
});

describe('the resolver shape', () => {
  it('reads the person\'s row then the portal default, never another person\'s, and once for the portal default itself', async () => {
    const reads: string[] = [];
    const reader = async (rowOwner: string) => { reads.push(rowOwner); return null; };
    expect(await resolvePortalDefault(reader, 'person-x')).toBeNull();
    expect(reads).toEqual(['person-x', PORTAL_DEFAULT_OWNER]);
    reads.length = 0;
    await resolvePortalDefault(reader, PORTAL_DEFAULT_OWNER);
    expect(reads).toEqual([PORTAL_DEFAULT_OWNER]);
    reads.length = 0;
    await resolvePortalDefault(reader, '');
    expect(reads).toEqual([PORTAL_DEFAULT_OWNER]);
    const own = vi.fn(async (rowOwner: string) => (rowOwner === 'person-y' ? 'mine' : 'shared'));
    expect(await resolvePortalDefault(own, 'person-y')).toEqual({ value: 'mine', source: 'own' });
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("keeps a person's falsy own value (false, 0, '') instead of falling back to a truthy portal default", async () => {
    for (const falsy of [false, 0, '']) {
      const reader = async (rowOwner: string): Promise<unknown> => (rowOwner === 'person-z' ? falsy : true);
      expect(await resolvePortalDefault(reader, 'person-z'), String(falsy)).toEqual({ value: falsy, source: 'own' });
    }
  });

  it('isPortalDefaultOwner matches the reserved owner exactly', () => {
    expect(isPortalDefaultOwner(PORTAL_DEFAULT_OWNER)).toBe(true);
    for (const value of ['Portal-Default', ' portal-default', 'fleet-default', '', null, undefined]) expect(isPortalDefaultOwner(value), String(value)).toBe(false);
  });
});
