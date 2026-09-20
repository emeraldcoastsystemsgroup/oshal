/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148) guards. These run against the LIVE Postgres on purpose: the claim this feature makes is "exactly one root, enforced by the database", and that claim is about a partial unique index — a mocked pool would prove only that the code calls query(). Per the integration-boundary corollary a database fix needs a real store/query against the enforcing schema, so a missing DB FAILS these specs loudly rather than skipping (a spec that skips is a guard that does not exist).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, instead of resolving an address from the environment at all. Refusing an unpointed run made the 2026-09-14 accident impossible, but it was the wrong shape of answer: `specDatabaseUrl` was called at MODULE level, so nothing supplying the variable meant the import threw and vitest reported a failed suite with ZERO cases — the partial unique index, the two doors onto root and the fail-closed operator gate were all unproven in every gate the file appeared in, and a guard that cannot run proves nothing. A private server is both safe and executable, and there is no value any caller can supply that would reach a deployment. The "refuses to run: this database already has a swarm root" bail goes with it: a server created seconds ago holds no root but this file's. `-c row_security=off` is carried across from the old pool unchanged. NO database role is declared — the subject here is the APPLICATION role column (root/admin/user rows in swarm_roles), and the store's own contract is that this table is deliberately NOT owner-RLS'd because the privileged-identity cache must read every row, so a NOSUPERUSER login would have nothing extra to observe. The per-case DELETE stays: it is isolation BETWEEN cases on a table nothing else can reach, not teardown of somebody's data.
 */

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureSwarmRoleSchema, listRoles, getRole, getRootSubFromStore, refreshPrivilegedCache,
  claimRoot, grantRole, revokeRole, transferRoot, SwarmRoleError,
} from '@/features/swarm-roles';
import { isOperatorIdentity, isBreakGlassOnlyOperator } from '@/shared/middleware/authz';
import { clearPrivilegedIdentities, getRootSub } from '@/shared/middleware/privileged-identities';
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

let pool: Pool;
/** The subs this spec assigns roles to, so the listing case can name the rows it expects. */
const OWNED = [SUB_A, SUB_B, SUB_C];

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
