import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  isOperatorAllowlistConfigured,
  requireAdminConsoleAccess,
} from '@/features/governance/rbac/policy';

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
});
