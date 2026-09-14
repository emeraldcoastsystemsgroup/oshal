/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard admin-console fallback behavior and exact privileged subject matching without changing case-insensitive operator email semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-148 alignment guard: resolveRole must recognise a swarm_roles grant with an EMPTY env allowlist, so the admin console stops disagreeing with the Users page and the cockpit rail. Drives the real policy function against the real privileged-identity snapshot; the env-allowlist and fail-closed cases are asserted alongside so break-glass cannot regress.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  isOperatorAllowlistConfigured,
  requireAdminConsoleAccess,
  resolveRole,
} from '@/features/governance/rbac/policy';
import { Role } from '@/features/governance/rbac/roles';
import {
  setPrivilegedIdentities,
  clearPrivilegedIdentities,
} from '@/shared/middleware/privileged-identities';

const OPERATOR_ENV = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_RBAC_OPERATOR_SUBS', 'OSHAL_RBAC_OPERATOR_EMAILS'];
const saved: Record<string, string | undefined> = {};
for (const key of OPERATOR_ENV) saved[key] = process.env[key];

function reqFor(sub: string | null, email: string | null = null): Request {
  return { oidc: { user: sub || email ? { sub, email } : undefined } } as unknown as Request;
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
  it('is permissive when no operator allowlist is configured (solo / local dev)', () => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
    expect(isOperatorAllowlistConfigured()).toBe(false);

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
