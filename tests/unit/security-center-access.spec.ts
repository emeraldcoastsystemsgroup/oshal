/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pin the Security Center's operator-only
 *              | boundary (operator decision 2026-07-07): the requiresOperator middleware is
 *              | fail-closed, the /api/security mount carries it, and the manifest is scope: operator.
 */

/**
 * @description
 * The Security Center's findings map the platform's own weak points (secret locations and
 * redacted previews, ungated routes), so basic users must never reach it. Three layers are
 * pinned here: (1) the requiresOperator middleware itself (fail-closed allowlist semantics),
 * (2) the server.ts mount wiring (requiresAuth + requiresOperator on /api/security — the real
 * boundary), (3) the manifest scope (operator — hides the catalog/ribbon entry).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { requiresOperator } from '../../src/shared/middleware/authz';
import type { Request, Response, NextFunction } from 'express';

/** Build a minimal Request carrying an OIDC user (or none). */
function reqAs(sub: string | null, email?: string): Request {
  const user = sub === null && email === undefined ? undefined : { sub: sub ?? undefined, email };
  return { oidc: { user } } as unknown as Request;
}

/** Response double capturing status/json; next() spy. */
function resDouble(): { res: Response; status: () => number | null; body: () => unknown } {
  let code: number | null = null;
  let payload: unknown;
  const res = {
    status(c: number) { code = c; return this; },
    json(b: unknown) { payload = b; return this; },
  } as unknown as Response;
  return { res, status: () => code, body: () => payload };
}

const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('requiresOperator middleware — fail-closed', () => {
  it('403s a signed-in non-operator and never calls next()', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'admin-sub-1';
    const { res, status, body } = resDouble();
    const next = vi.fn() as unknown as NextFunction;
    requiresOperator(reqAs('basic-user-9'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(403);
    expect(body()).toEqual({ error: 'Operator privilege required' });
  });

  it('403s everyone when the allowlist is empty (fail-closed)', () => {
    const { res, status } = resDouble();
    const next = vi.fn() as unknown as NextFunction;
    requiresOperator(reqAs('any-sub'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(403);
  });

  it('passes an allowlisted sub through to next()', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'admin-sub-1';
    const { res, status } = resDouble();
    const next = vi.fn() as unknown as NextFunction;
    requiresOperator(reqAs('admin-sub-1'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBeNull();
  });

  it('passes an allowlisted email through to next()', () => {
    process.env.OSHAL_OPERATOR_EMAILS = 'admin@example.com';
    const { res } = resDouble();
    const next = vi.fn() as unknown as NextFunction;
    requiresOperator(reqAs('whoever', 'admin@example.com'), res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('Security Center wiring — operator-only at every layer', () => {
  const root = path.resolve(__dirname, '..', '..');

  it('server.ts mounts /api/security behind requiresAuth AND requiresOperator', () => {
    const server = fs.readFileSync(path.join(root, 'src', 'app', 'server.ts'), 'utf8');
    expect(server).toMatch(/app\.use\('\/api\/security',\s*requiresAuth,\s*requiresOperator,/);
  });

  it('the security-center manifest is scope: operator (hidden from non-operator catalogs)', () => {
    const manifest = fs.readFileSync(path.join(root, 'swarm-apps', 'security.yaml'), 'utf8');
    expect(manifest).toMatch(/^scope:\s*operator\s*$/m);
  });

  it('migration 064 admits the operator scope value', () => {
    const mig = fs.readFileSync(path.join(root, 'scripts', 'migrations', '064-swarm-app-operator-scope.sql'), 'utf8');
    expect(mig).toContain("scope IN ('person', 'tenant', 'public', 'operator')");
  });
});
