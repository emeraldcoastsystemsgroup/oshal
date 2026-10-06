/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard admin-console fallback behavior and exact privileged subject matching without changing case-insensitive operator email semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-148 alignment guard: resolveRole must recognise a swarm_roles grant with an EMPTY env allowlist, so the admin console stops disagreeing with the Users page and the cockpit rail. Drives the real policy function against the real privileged-identity snapshot; the env-allowlist and fail-closed cases are asserted alongside so break-glass cannot regress.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment A guard (and review fixes: restricted until the role table has loaded once, so the boot window and a failed first load are not a fresh install; the allowlist check counts entries; the request fixture carries a verified identity-provider issuer, since an email counts only with one): emptying the environment allowlists does not open the admin console. With OSHAL_OPERATOR_SUBS/EMAILS empty and a root row loaded, a plain signed-in user gets 403 from requireAdminConsoleAccess (the /admin page guard) and from the real GET /readiness router; the permissive bootstrap survives only with neither env lists nor roles, and closes the moment the first root row loads; a failed role refresh drops every identity but keeps the console restricted; the posture reports operatorRolesConfigured.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import type { Pool } from 'pg';
import {
  isOperatorAllowlistConfigured,
  isOperatorRolesConfigured,
  requireAdminConsoleAccess,
  resolveRole,
} from '@/features/governance/rbac/policy';
import { Role } from '@/features/governance/rbac/roles';
import {
  setPrivilegedIdentities,
  clearPrivilegedIdentities,
} from '@/shared/middleware/privileged-identities';
import { refreshPrivilegedCache } from '@/features/swarm-roles';
import { initializeSwarmRoles } from '@/app/routes/swarm-roles-routes';
import { buildRuntimeSecurityControls, createAuditExportRouter } from '@/app/routes/audit-export-routes';

const OPERATOR_ENV = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_RBAC_OPERATOR_SUBS', 'OSHAL_RBAC_OPERATOR_EMAILS'];
const saved: Record<string, string | undefined> = {};
for (const key of OPERATOR_ENV) saved[key] = process.env[key];

/** A signed-in identity-provider principal: an email counts for an operator decision only with a verified issuer. */
function reqFor(sub: string | null, email: string | null = null): Request {
  const user = sub || email ? { sub, email, iss: 'https://login.example.test/tenant' } : undefined;
  return { oidc: { isAuthenticated: () => Boolean(user), user } } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
}

afterEach(() => {
  for (const key of OPERATOR_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('requireAdminConsoleAccess', () => {
  it('is permissive when no operator allowlist is configured (solo / local dev), once the role table has loaded empty', () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    expect(isOperatorAllowlistConfigured()).toBe(false);
    setPrivilegedIdentities([]); // a successful load of an empty role table: a fresh install

    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('anyone'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('403s a non-admin caller once an operator allowlist exists', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'admin-sub-1';
    expect(isOperatorAllowlistConfigured()).toBe(true);

    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('random-user'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { requiredRole?: string }).requiredRole).toBe('admin');
  });

  it('admits an allowlisted operator (resolved as admin)', () => {
    process.env.OSHAL_OPERATOR_EMAILS = 'boss@example.com';

    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor(null, 'boss@example.com'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('admits only the exact allowlisted subject, not case or whitespace aliases', () => {
    process.env.OSHAL_OPERATOR_SUBS = ' Admin-Sub ';

    for (const [sub, admitted] of [
      ['Admin-Sub', true],
      ['admin-sub', false],
      [' Admin-Sub', false],
      ['Admin-Sub ', false],
    ] as const) {
      const next = vi.fn();
      const res = fakeRes();
      requireAdminConsoleAccess()(reqFor(sub), res, next);
      expect(next.mock.calls.length, sub).toBe(admitted ? 1 : 0);
      expect(res.statusCode, sub).toBe(admitted ? undefined : 403);
    }
  });
});

describe('the governance role honours swarm_roles, not just the environment (ADR-148)', () => {
  afterEach(clearPrivilegedIdentities);

  /** No env allowlist at all — so anything that passes can ONLY have come from the role snapshot. */
  function withNoAllowlist(): void {
    for (const key of OPERATOR_ENV) delete process.env[key];
  }

  it('resolves an admin granted on the Users page as Admin with an EMPTY env allowlist', () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'granted-admin', email: 'a@example.com', role: 'admin' }]);
    expect(resolveRole({ sub: 'granted-admin', email: null })).toBe(Role.Admin);
  });

  it('resolves swarm root as Admin — root administers the swarm', () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'the-root', email: null, role: 'root' }]);
    expect(resolveRole({ sub: 'the-root', email: null })).toBe(Role.Admin);
  });

  it('matches a granted identity by email case-insensitively, and the subject exactly', () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'granted-admin', email: 'Mixed@Example.com', role: 'admin' }]);
    expect(resolveRole({ sub: null, email: 'mixed@example.com' })).toBe(Role.Admin);
    // Subject comparison stays exact — the case-sensitivity rule this module already follows.
    expect(resolveRole({ sub: 'GRANTED-ADMIN', email: null })).toBe(Role.Viewer);
  });

  it('leaves everyone else a Viewer, so this is a grant and not a blanket raise', () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'granted-admin', email: null, role: 'admin' }]);
    expect(resolveRole({ sub: 'somebody-else', email: 'other@example.com' })).toBe(Role.Viewer);
  });

  it('is Viewer with no roles loaded AND no allowlist — fail-closed, unchanged', () => {
    withNoAllowlist();
    clearPrivilegedIdentities();
    expect(resolveRole({ sub: 'nobody', email: 'nobody@example.com' })).toBe(Role.Viewer);
  });

  it('keeps the env allowlist working when no roles are loaded (break-glass preserved)', () => {
    withNoAllowlist();
    clearPrivilegedIdentities();
    process.env.OSHAL_OPERATOR_SUBS = 'env-operator';
    expect(resolveRole({ sub: 'env-operator', email: null })).toBe(Role.Admin);
  });

  it('admits a role-granted admin through the admin-console gate with an allowlist that excludes them', () => {
    withNoAllowlist();
    process.env.OSHAL_OPERATOR_SUBS = 'someone-else';
    setPrivilegedIdentities([{ sub: 'granted-admin', email: null, role: 'admin' }]);
    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('granted-admin'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('ADR-174 Amendment A: emptying the environment allowlists does not open the admin console', () => {
  afterEach(clearPrivilegedIdentities);

  /** No env allowlist at all, so the only privileged identity is the loaded root row. */
  function withNoAllowlist(): void {
    for (const key of OPERATOR_ENV) delete process.env[key];
  }

  /** The real governance router behind a fixture sign-in that takes the caller's sub from a header. */
  async function serveGovernanceRouter() {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: String(req.headers['x-test-sub'] ?? '') } } });
      next();
    });
    app.use(createAuditExportRouter({ pool: { query: vi.fn(async () => ({ rows: [] })) } } as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      call: (path: string, sub: string) => fetch(`${base}${path}`, { headers: { 'x-test-sub': sub } }),
      close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    };
  }

  it('403s a plain signed-in user when the env lists are empty but a root row exists', () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'the-root', email: 'root@example.com', role: 'root' }]);

    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('plain-user', 'plain@example.com'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', requiredRole: 'admin' });

    const rootNext = vi.fn();
    requireAdminConsoleAccess()(reqFor('the-root'), fakeRes(), rootNext);
    expect(rootNext).toHaveBeenCalledOnce();
    expect(isOperatorAllowlistConfigured()).toBe(false);
    expect(isOperatorRolesConfigured()).toBe(true);
  });

  it('keeps the permissive bootstrap with no env lists and no roles, and closes once the first root row loads', () => {
    withNoAllowlist();
    setPrivilegedIdentities([]);
    const open = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('first-person'), res, open);
    expect(open).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();

    // Root is claimed (the installer ceremony or the claim route); the env lists stay empty.
    setPrivilegedIdentities([{ sub: 'first-person', email: null, role: 'root' }]);
    const closed = vi.fn();
    const refusal = fakeRes();
    requireAdminConsoleAccess()(reqFor('second-person'), refusal, closed);
    expect(closed).not.toHaveBeenCalled();
    expect(refusal.statusCode).toBe(403);
  });

  it('stays restricted until the role table has loaded once: the boot window and a failed FIRST load are not a fresh install', async () => {
    withNoAllowlist();
    clearPrivilegedIdentities(); // nothing has loaded yet: the window between listen and the first refresh
    const booting = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('plain-user'), res, booting);
    expect(booting).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    // The first refresh fails (initializeSwarmRoles is fire-and-forget and non-fatal): still restricted.
    const unreadable = { query: () => Promise.reject(new Error('role table unreachable')) } as unknown as Pool;
    await expect(refreshPrivilegedCache(unreadable)).rejects.toThrow('role table unreachable');
    const failed = vi.fn();
    requireAdminConsoleAccess()(reqFor('plain-user'), fakeRes(), failed);
    expect(failed).not.toHaveBeenCalled();
    // An allowlisted admin is the way in meanwhile.
    process.env.OSHAL_OPERATOR_SUBS = 'the-admin';
    const admin = vi.fn();
    requireAdminConsoleAccess()(reqFor('the-admin'), fakeRes(), admin);
    expect(admin).toHaveBeenCalledOnce();
    delete process.env.OSHAL_OPERATOR_SUBS;
    // The first successful load of an empty table opens the fresh-install bootstrap.
    const readable = { query: async () => ({ rows: [] }) } as unknown as Pool;
    await refreshPrivilegedCache(readable);
    const open = vi.fn();
    requireAdminConsoleAccess()(reqFor('plain-user'), fakeRes(), open);
    expect(open).toHaveBeenCalledOnce();
  });

  it('the boot-time role load retries a transient failure, so the console opens once the table reads', async () => {
    withNoAllowlist();
    clearPrivilegedIdentities();
    let failures = 2;
    const flaky = { query: vi.fn(async () => {
      if (failures > 0) { failures -= 1; throw new Error('connection refused'); }
      return { rows: [] };
    }) } as unknown as Pool;
    const sleeps: number[] = [];
    await initializeSwarmRoles(flaky, { retryDelaysMs: [1, 2, 3], sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([1, 2]);
    expect(isOperatorRolesConfigured()).toBe(false);
    const open = vi.fn();
    requireAdminConsoleAccess()(reqFor('plain-user'), fakeRes(), open);
    expect(open).toHaveBeenCalledOnce();
    // Past the last retry the failure is logged and the console stays restricted to the allowlist.
    clearPrivilegedIdentities();
    const dead = { query: vi.fn(async () => { throw new Error('connection refused'); }) } as unknown as Pool;
    await initializeSwarmRoles(dead, { retryDelaysMs: [1], sleep: async () => undefined });
    const closed = vi.fn();
    const refusal = fakeRes();
    requireAdminConsoleAccess()(reqFor('plain-user'), refusal, closed);
    expect(closed).not.toHaveBeenCalled();
    expect(refusal.statusCode).toBe(403);
  });

  it('isOperatorAllowlistConfigured counts entries, so a whitespace-only SUBS never hides a populated EMAILS', () => {
    withNoAllowlist();
    setPrivilegedIdentities([]);
    process.env.OSHAL_OPERATOR_SUBS = '  ';
    process.env.OSHAL_OPERATOR_EMAILS = 'admin@example.com';
    expect(isOperatorAllowlistConfigured()).toBe(true);
    expect(buildRuntimeSecurityControls(process.env).operatorAllowlistConfigured).toBe(true);
    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('plain-user', 'plain@example.com'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('stays restricted after the role store fails to refresh and drops every identity', async () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'the-root', email: null, role: 'root' }]);
    // The real refresh, over a role table that cannot be read.
    const unreadable = { query: () => Promise.reject(new Error('role table unreachable')) } as unknown as Pool;
    await expect(refreshPrivilegedCache(unreadable)).rejects.toThrow('role table unreachable');

    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(reqFor('plain-user'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    // Nobody keeps a privilege from the dropped snapshot: the root is refused too until roles reload.
    const rootNext = vi.fn();
    requireAdminConsoleAccess()(reqFor('the-root'), fakeRes(), rootNext);
    expect(rootNext).not.toHaveBeenCalled();
  });

  it('the readiness route answers 403 to a plain user and 200 to the root, through the real router', async () => {
    withNoAllowlist();
    setPrivilegedIdentities([{ sub: 'the-root', email: null, role: 'root' }]);
    const app = await serveGovernanceRouter();
    try {
      const refused = await app.call('/readiness', 'plain-user');
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: 'forbidden', requiredRole: 'admin' });
      expect((await app.call('/readiness', 'the-root')).status).toBe(200);
      // A fresh install, with neither env lists nor roles, keeps the permissive bootstrap once the table has loaded.
      setPrivilegedIdentities([]);
      expect((await app.call('/readiness', 'plain-user')).status).toBe(200);
      // Before that first load, nobody but an allowlisted admin gets in.
      clearPrivilegedIdentities();
      expect((await app.call('/readiness', 'plain-user')).status).toBe(403);
    } finally { await app.close(); }
  });

  it('the governance posture reports operatorRolesConfigured', () => {
    clearPrivilegedIdentities();
    expect(buildRuntimeSecurityControls({} as NodeJS.ProcessEnv).operatorRolesConfigured).toBe(false);
    setPrivilegedIdentities([{ sub: 'the-root', email: null, role: 'root' }]);
    expect(buildRuntimeSecurityControls({} as NodeJS.ProcessEnv)).toMatchObject({
      operatorAllowlistConfigured: false,
      operatorRolesConfigured: true,
    });
  });
});
