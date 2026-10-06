/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148) guards. These run against the LIVE Postgres on purpose: the claim this feature makes is "exactly one root, enforced by the database", and that claim is about a partial unique index — a mocked pool would prove only that the code calls query(). Per the integration-boundary corollary a database fix needs a real store/query against the enforcing schema, so a missing DB FAILS these specs loudly rather than skipping (a spec that skips is a guard that does not exist).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, instead of resolving an address from the environment at all. Refusing an unpointed run made the 2026-09-14 accident impossible, but it was the wrong shape of answer: `specDatabaseUrl` was called at MODULE level, so nothing supplying the variable meant the import threw and vitest reported a failed suite with ZERO cases — the partial unique index, the two doors onto root and the fail-closed operator gate were all unproven in every gate the file appeared in, and a guard that cannot run proves nothing. A private server is both safe and executable, and there is no value any caller can supply that would reach a deployment. The "refuses to run: this database already has a swarm root" bail goes with it: a server created seconds ago holds no root but this file's. `-c row_security=off` is carried across from the old pool unchanged. NO database role is declared — the subject here is the APPLICATION role column (root/admin/user rows in swarm_roles), and the store's own contract is that this table is deliberately NOT owner-RLS'd because the privileged-identity cache must read every row, so a NOSUPERUSER login would have nothing extra to observe. The per-case DELETE stays: it is isolation BETWEEN cases on a table nothing else can reach, not teardown of somebody's data.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment A guards on the real store: a login never becomes a privileged EMAIL, and a local account's email never makes it an operator. claimRoot with email 'admin' stores null (grantRole and transferRoot likewise store only addresses); a root row carrying 'admin' written behind the store is ignored by the cache; a local-issuer principal whose address is on a root row or on OSHAL_OPERATOR_EMAILS is not an operator while an identity-provider principal with that address still is; a failed refresh drops every identity but keeps the record that roles are configured.
 */

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureSwarmRoleSchema, listRoles, getRole, getRootSubFromStore, refreshPrivilegedCache,
  claimRoot, grantRole, revokeRole, transferRoot, SwarmRoleError,
} from '@/features/swarm-roles';
import { isOperatorIdentity, isBreakGlassOnlyOperator } from '@/shared/middleware/authz';
import {
  clearPrivilegedIdentities, getRootSub, privilegedIdentityStatus, setPrivilegedIdentities,
} from '@/shared/middleware/privileged-identities';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// `row_security=off` is the libpq option the old pool carried, kept verbatim.
const database = new DisposablePostgres({
  purpose: 'swarm-roles-store', database: 'swarm_roles_fixture', memory: '256m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});

/** Unique per run so a parallel run or a leftover row can never be mistaken for this one's. */
const RUN = `role-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const SUB_A = `${RUN}-a`;
const SUB_B = `${RUN}-b`;
const SUB_C = `${RUN}-c`;
/** A local account's subject, in the shape the local-auth store derives (local-<hash>). */
const LOCAL_SUB = `local-${RUN.replace(/[^0-9a-f]/g, '0').padEnd(16, '0').slice(0, 16)}`;

let pool: Pool;
/** The subs this spec assigns roles to, so the listing case can name the rows it expects. */
const OWNED = [SUB_A, SUB_B, SUB_C, LOCAL_SUB];

/**
 * Isolation BETWEEN cases — each one starts from an unclaimed root — on a table that lives in a
 * server this file created and will destroy. It is not teardown of anybody's data.
 */
async function wipe(): Promise<void> {
  await pool.query('DELETE FROM swarm_roles WHERE user_sub = ANY($1::text[])', [OWNED]);
  clearPrivilegedIdentities();
}

beforeAll(async () => {
  pool = await database.start();
  await ensureSwarmRoleSchema(pool);
  await wipe();
}, 120_000);

afterEach(wipe);
// No teardown DELETE pass: the whole server goes away, so there is nothing to clean and nowhere
// to clean it.
afterAll(async () => { await database.stop(); });

describe('the single-root invariant is enforced by the DATABASE, not by application code', () => {
  it('permits exactly one winner when two claims race', async () => {
    // Both claims are issued before either resolves — the partial unique index is the arbiter.
    const results = await Promise.allSettled([
      claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' }),
      claimRoot(pool, { userSub: SUB_B, email: 'b@example.com' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(SwarmRoleError);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM swarm_roles WHERE role = 'root'`);
    expect(rows[0].n).toBe(1);
  });

  it('rejects a second root even when inserted behind the store, straight into SQL', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    // The guard has to survive code that bypasses the store entirely — that is the whole point
    // of putting the invariant in the schema.
    await expect(
      pool.query(`INSERT INTO swarm_roles (user_sub, role) VALUES ($1, 'root')`, [SUB_B]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a claim while root is held, and says so', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await expect(claimRoot(pool, { userSub: SUB_B })).rejects.toMatchObject({ status: 409 });
  });
});

describe('root has exactly two doors: claim and transfer', () => {
  it('grantRole cannot mint root', async () => {
    await expect(
      grantRole(pool, { userSub: SUB_A, role: 'root' as never, grantedBySub: null }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await getRootSubFromStore(pool)).toBeNull();
  });

  it('revokeRole refuses to remove root, so a swarm cannot be left rootless', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await expect(revokeRole(pool, SUB_A, SUB_A)).rejects.toMatchObject({ status: 409 });
    expect(await getRootSubFromStore(pool)).toBe(SUB_A);
  });

  it('grantRole refuses to change the sitting root out from under itself', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await expect(
      grantRole(pool, { userSub: SUB_A, role: 'admin', grantedBySub: SUB_A }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('transfer moves root and DEMOTES the outgoing root to admin rather than dropping them', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await transferRoot(pool, { toSub: SUB_B, toEmail: 'b@example.com', bySub: SUB_A });

    expect(await getRootSubFromStore(pool)).toBe(SUB_B);
    expect((await getRole(pool, SUB_A))?.role).toBe('admin');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM swarm_roles WHERE role = 'root'`);
    expect(rows[0].n).toBe(1);
  });

  it('refuses a transfer when root is unclaimed', async () => {
    await expect(transferRoot(pool, { toSub: SUB_B, bySub: null })).rejects.toMatchObject({ status: 409 });
  });
});

describe('the operator gate reads database roles, with env as break-glass', () => {
  const savedSubs = process.env.OSHAL_OPERATOR_SUBS;
  const savedEmails = process.env.OSHAL_OPERATOR_EMAILS;

  afterEach(() => {
    if (savedSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
    else process.env.OSHAL_OPERATOR_SUBS = savedSubs;
    if (savedEmails === undefined) delete process.env.OSHAL_OPERATOR_EMAILS;
    else process.env.OSHAL_OPERATOR_EMAILS = savedEmails;
  });

  it('grants the gate to a DB root with an EMPTY env allowlist', async () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await refreshPrivilegedCache(pool);

    expect(isOperatorIdentity(SUB_A, 'a@example.com')).toBe(true);
    expect(getRootSub()).toBe(SUB_A);
    // …and denies a stranger, so this is a grant and not an "everyone" bug.
    expect(isOperatorIdentity(SUB_C, 'c@example.com')).toBe(false);
  });

  it('grants the gate to a DB admin, and revoking it takes effect without a restart', async () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    await claimRoot(pool, { userSub: SUB_A });
    await grantRole(pool, { userSub: SUB_B, email: 'b@example.com', role: 'admin', grantedBySub: SUB_A });
    expect(isOperatorIdentity(SUB_B, null)).toBe(true);

    await revokeRole(pool, SUB_B, SUB_A);
    expect(isOperatorIdentity(SUB_B, 'b@example.com')).toBe(false);
  });

  it('a plain `user` role never satisfies the gate', async () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    await claimRoot(pool, { userSub: SUB_A });
    await grantRole(pool, { userSub: SUB_B, role: 'user', grantedBySub: SUB_A });
    expect(isOperatorIdentity(SUB_B, null)).toBe(false);
  });

  it('keeps the env allowlist working with NO roles loaded — the adoption path for existing boxes', () => {
    clearPrivilegedIdentities();
    process.env.OSHAL_OPERATOR_SUBS = SUB_C;
    expect(isOperatorIdentity(SUB_C, null)).toBe(true);
    expect(isBreakGlassOnlyOperator(SUB_C, null)).toBe(true);
  });

  it('reports break-glass-only as FALSE once the same identity holds a real role', async () => {
    process.env.OSHAL_OPERATOR_SUBS = SUB_A;
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await refreshPrivilegedCache(pool);
    expect(isOperatorIdentity(SUB_A, null)).toBe(true);
    expect(isBreakGlassOnlyOperator(SUB_A, null)).toBe(false);
  });

  it('denies everyone when neither roles nor allowlist are configured (fail-closed)', () => {
    clearPrivilegedIdentities();
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    expect(isOperatorIdentity(SUB_A, 'a@example.com')).toBe(false);
    expect(isOperatorIdentity(null, null)).toBe(false);
  });
});

describe('a role-store read failure clears the cache rather than leaving it stale', () => {
  it('drops privilege instead of preserving a revoked admin', async () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    await refreshPrivilegedCache(pool);
    expect(isOperatorIdentity(SUB_A, null)).toBe(true);

    // A pool that always fails, standing in for an unreachable role table. The BOUNDARY under
    // test here is the failure handler's choice — clear vs keep — not the database itself.
    const brokenPool = {
      query: () => Promise.reject(new Error('role table unreachable')),
    } as unknown as Pool;
    await expect(refreshPrivilegedCache(brokenPool)).rejects.toThrow('role table unreachable');

    expect(isOperatorIdentity(SUB_A, 'a@example.com')).toBe(false);
  });
});

describe('listing', () => {
  it('orders root first, then admins', async () => {
    await claimRoot(pool, { userSub: SUB_A });
    await grantRole(pool, { userSub: SUB_B, role: 'admin', grantedBySub: SUB_A });
    await grantRole(pool, { userSub: SUB_C, role: 'user', grantedBySub: SUB_A });

    const mine = (await listRoles(pool)).filter((r) => OWNED.includes(r.userSub));
    expect(mine.map((r) => r.role)).toEqual(['root', 'admin', 'user']);
  });
});

describe('ADR-174 Amendment A: a login never becomes a privileged email, and a local email never grants operator', () => {
  const savedSubs = process.env.OSHAL_OPERATOR_SUBS;
  const savedEmails = process.env.OSHAL_OPERATOR_EMAILS;

  beforeEach(() => {
    // No break-glass entry at all: anything that passes below can only come from a role row.
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  afterEach(() => {
    if (savedSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
    else process.env.OSHAL_OPERATOR_SUBS = savedSubs;
    if (savedEmails === undefined) delete process.env.OSHAL_OPERATOR_EMAILS;
    else process.env.OSHAL_OPERATOR_EMAILS = savedEmails;
  });

  it('claimRoot with email "admin" stores null, and the root row still binds the account by subject', async () => {
    const row = await claimRoot(pool, { userSub: LOCAL_SUB, email: 'admin' });
    expect(row.email).toBeNull();
    expect((await getRole(pool, LOCAL_SUB))?.email).toBeNull();
    expect(isOperatorIdentity(LOCAL_SUB, 'admin', LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(true);
    // An identity-provider user whose preferred_username is 'admin' reports 'admin' as its email.
    expect(isOperatorIdentity('kc-3f2a', 'admin')).toBe(false);
  });

  it('grantRole and transferRoot store an email only when it is an address', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    expect((await getRole(pool, SUB_A))?.email).toBe('a@example.com');
    await grantRole(pool, { userSub: SUB_B, email: 'admin', role: 'admin', grantedBySub: SUB_A });
    expect((await getRole(pool, SUB_B))?.email).toBeNull();
    await transferRoot(pool, { toSub: SUB_C, toEmail: 'admin', bySub: SUB_A });
    expect((await getRole(pool, SUB_C))?.email).toBeNull();
    expect(isOperatorIdentity('kc-3f2a', 'admin')).toBe(false);
  });

  it('ignores a login stored as a role email behind the store, when the cache loads it', async () => {
    // The installer, plain SQL, or a row written before this change: the cache is the one place the gate reads.
    await pool.query(`INSERT INTO swarm_roles (user_sub, email, role) VALUES ($1, 'admin', 'root')`, [LOCAL_SUB]);
    await refreshPrivilegedCache(pool);
    expect(isOperatorIdentity('kc-3f2a', 'admin')).toBe(false);
    expect(isOperatorIdentity(LOCAL_SUB, null, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(true);
  });

  it("a local-issuer principal is never an operator by its email; an identity-provider principal with that address still is", async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'Owner@Example.com' });
    // The address is on a root row. A local account that typed it at invite time holds nothing...
    expect(isOperatorIdentity(LOCAL_SUB, 'owner@example.com', LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(false);
    expect(isBreakGlassOnlyOperator(LOCAL_SUB, 'owner@example.com', LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(false);
    // ...while a provider sign-in reporting that verified address matches, as before.
    expect(isOperatorIdentity('kc-other', 'owner@example.com', 'https://login.example.test/tenant')).toBe(true);
    // The same for the env break-glass list.
    process.env.OSHAL_OPERATOR_EMAILS = 'ops@example.com';
    expect(isOperatorIdentity(LOCAL_SUB, 'ops@example.com', LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(false);
    expect(isOperatorIdentity('kc-other', 'ops@example.com', 'https://login.example.test/tenant')).toBe(true);
    // A local account IS an operator through its own row or subject entry.
    await grantRole(pool, { userSub: LOCAL_SUB, email: 'owner@example.com', role: 'admin', grantedBySub: SUB_A });
    expect(isOperatorIdentity(LOCAL_SUB, 'owner@example.com', LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(true);
  });

  it('a role row for a local-auth-shaped subject stores no email, even a real address', async () => {
    const localShaped = `local-${'0123456789abcdef'}`;
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    const row = await grantRole(pool, { userSub: localShaped, email: 'typed@example.com', role: 'admin', grantedBySub: SUB_A });
    expect(row.email).toBeNull();
    // The typed address is no key for an identity-provider principal; the local account is bound by its subject.
    expect(isOperatorIdentity('kc-other', 'typed@example.com', 'https://login.example.test/tenant')).toBe(false);
    expect(isOperatorIdentity(localShaped, null, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(true);
    await pool.query('DELETE FROM swarm_roles WHERE user_sub = $1', [localShaped]);
  });

  it('a local-shaped row written behind the store with a real address never matches by email once the cache loads it', async () => {
    // Plain SQL, the installer, or a row from an older version: the cache is the one place the gate reads.
    await pool.query(`INSERT INTO swarm_roles (user_sub, email, role) VALUES ($1, 'typed@example.com', 'root')`, [LOCAL_SUB]);
    await refreshPrivilegedCache(pool);
    expect(isOperatorIdentity('kc-other', 'typed@example.com', 'https://login.example.test/tenant')).toBe(false);
    expect(isOperatorIdentity(LOCAL_SUB, null, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(true);
  });

  it('setPrivilegedIdentities ignores a login as the root email but keeps a real address', () => {
    setPrivilegedIdentities([{ sub: LOCAL_SUB, email: 'admin', role: 'root' }]);
    expect(isOperatorIdentity('kc-3f2a', 'admin')).toBe(false);
    setPrivilegedIdentities([{ sub: 'kc-owner', email: 'Owner@Example.com', role: 'root' }]);
    expect(isOperatorIdentity('kc-other', 'owner@example.com')).toBe(true);
  });
});

describe('ADR-174 Amendment A: a failed refresh keeps the record that roles are configured', () => {
  it('drops every identity but still reports roles configured, until the next successful load', async () => {
    await claimRoot(pool, { userSub: SUB_A, email: 'a@example.com' });
    expect(privilegedIdentityStatus().rolesConfigured).toBe(true);

    const brokenPool = { query: () => Promise.reject(new Error('role table unreachable')) } as unknown as Pool;
    await expect(refreshPrivilegedCache(brokenPool)).rejects.toThrow('role table unreachable');
    expect(isOperatorIdentity(SUB_A, 'a@example.com')).toBe(false);
    expect(privilegedIdentityStatus()).toMatchObject({ loaded: false, count: 0, rolesConfigured: true });

    await refreshPrivilegedCache(pool);
    expect(privilegedIdentityStatus()).toMatchObject({ loaded: true, count: 1, rolesConfigured: true });
  });
});
