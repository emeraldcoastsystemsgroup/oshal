/**
 * Proves the app-layer object-level authorization that prevents IDOR:
 * src/shared/middleware/authz.ts.
 *
 * Guarantee under test: a caller reaches a resource only when they own it, are an
 * operator, or (transitionally) it is unowned and OSHAL_ALLOW_LEGACY_UNOWNED explicitly
 * permits it. Cross-user access is denied; default null-owner behavior is fail-closed.
 * Operator status is a fail-closed allowlist. Covers the negative paths
 * the release-hardening plan calls for (W1.5 cross-user denial, W2.2 null-owner behaviour).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact case-sensitive subject allowlists and canonical base64url trusted-service user transport while retaining case-insensitive email matching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCaller,
  getTrustedServiceUserSub,
  hasValidServiceSecret,
  isOperator,
  canAccessResource,
  requireOperator,
  requireServiceSecret,
  serviceSecretOr,
  serviceSecretHeaders,
  trustedServiceUserHeaders,
} from '../../src/shared/middleware/authz';
import type { Request, Response } from 'express';

/** Build a minimal Request carrying an OIDC user (or none). */
function reqAs(sub: string | null, email?: string): Request {
  const user = sub === null && email === undefined ? undefined : { sub: sub ?? undefined, email };
  return { oidc: { user } } as unknown as Request;
}

// These functions read process.env (operator allowlists, legacy-unowned flag).
// Snapshot and restore the keys we touch so tests don't leak into each other.
const ENV_KEYS = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_ALLOW_LEGACY_UNOWNED', 'SWARM_SERVICE_SECRET'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getCaller', () => {
  it('extracts sub and lowercases the email', () => {
    expect(getCaller(reqAs('u1', 'User@Example.COM'))).toEqual({ sub: 'u1', email: 'user@example.com' });
  });
  it('falls back to preferred_username when email is absent', () => {
    const req = { oidc: { user: { sub: 'u2', preferred_username: 'Name@Corp' } } } as unknown as Request;
    expect(getCaller(req)).toEqual({ sub: 'u2', email: 'name@corp' });
  });
  it('returns null sub/email for an unauthenticated request', () => {
    expect(getCaller(reqAs(null))).toEqual({ sub: null, email: null });
  });
});

describe('isOperator', () => {
  it('is FALSE when no allowlist is configured (fail-closed)', () => {
    expect(isOperator(reqAs('u1', 'u1@x.com'))).toBe(false);
  });
  it('matches operator subjects exactly and rejects case/whitespace aliases', () => {
    process.env.OSHAL_OPERATOR_SUBS = ' admin-sub , other ';
    expect(isOperator(reqAs('admin-sub'))).toBe(true);
    expect(isOperator(reqAs('Admin-Sub'))).toBe(false);
    expect(isOperator(reqAs('admin-sub '))).toBe(false);
    expect(isOperator(reqAs(' admin-sub'))).toBe(false);
  });
  it('is TRUE when the caller email is in OSHAL_OPERATOR_EMAILS', () => {
    process.env.OSHAL_OPERATOR_EMAILS = 'boss@corp.com';
    expect(isOperator(reqAs('u9', 'Boss@Corp.com'))).toBe(true);
  });
  it('is FALSE for a caller not on either allowlist', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'admin-sub';
    process.env.OSHAL_OPERATOR_EMAILS = 'boss@corp.com';
    expect(isOperator(reqAs('intruder', 'intruder@evil.com'))).toBe(false);
  });
});

describe('canAccessResource — object-level authorization (IDOR core)', () => {
  it('allows the owner to access their own resource', () => {
    expect(canAccessResource(reqAs('owner-1'), 'owner-1')).toBe(true);
  });

  it('DENIES a different user accessing another user\'s resource', () => {
    expect(canAccessResource(reqAs('user-b'), 'user-a')).toBe(false);
  });

  it('allows an operator to access any owned resource', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'op-1';
    expect(canAccessResource(reqAs('op-1'), 'someone-else')).toBe(true);
  });

  it('DENIES an anonymous caller on an owned resource', () => {
    expect(canAccessResource(reqAs(null), 'owner-1')).toBe(false);
  });

  describe('legacy unowned (null owner_sub) behaviour', () => {
    it('DENIES access by DEFAULT (flag unset = fail-closed)', () => {
      expect(canAccessResource(reqAs('anyone'), null)).toBe(false);
    });
    it('allows only when compatibility flag is explicitly "true"', () => {
      process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'true';
      expect(canAccessResource(reqAs('anyone'), undefined)).toBe(true);
    });
    it('DENIES unowned access when OSHAL_ALLOW_LEGACY_UNOWNED=false', () => {
      process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
      expect(canAccessResource(reqAs('anyone'), null)).toBe(false);
    });
    it('an operator still reaches unowned rows even when legacy access is locked down', () => {
      process.env.OSHAL_ALLOW_LEGACY_UNOWNED = 'false';
      process.env.OSHAL_OPERATOR_SUBS = 'op-1';
      expect(canAccessResource(reqAs('op-1'), null)).toBe(true);
    });
  });
});

describe('requireOperator', () => {
  function resMock() {
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
    (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
    return res;
  }
  it('returns true and does not respond for an operator', () => {
    process.env.OSHAL_OPERATOR_SUBS = 'op-1';
    const res = resMock();
    expect(requireOperator(reqAs('op-1'), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
  it('returns false and sends 403 for a non-operator', () => {
    const res = resMock();
    expect(requireOperator(reqAs('u1'), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('serviceSecretOr', () => {
  function run(headerSecret: string | undefined) {
    const next = vi.fn();
    const fallback = vi.fn();
    const req = { headers: headerSecret === undefined ? {} : { 'x-service-secret': headerSecret } } as unknown as Request;
    serviceSecretOr(fallback)(req, {} as Response, next);
    return { next, fallback };
  }
  it('calls next() (bypasses auth) on a matching X-Service-Secret', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    const { next, fallback } = run('super-secret');
    expect(next).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
  it('exposes the same strict service-secret decision for request identity stamping', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    expect(hasValidServiceSecret({ headers: { 'x-service-secret': 'super-secret' } } as unknown as Request)).toBe(true);
    expect(hasValidServiceSecret({ headers: { 'x-service-secret': 'wrong' } } as unknown as Request)).toBe(false);
  });
  it('builds outbound internal-service headers only when configured', () => {
    expect(serviceSecretHeaders()).toEqual({});
    expect(trustedServiceUserHeaders('user-sub')).toEqual({});
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    expect(serviceSecretHeaders()).toEqual({ 'X-Service-Secret': 'super-secret' });
  });
  it('round-trips an exact subject through the canonical encoded service header', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    for (const exactSub of [' Auth0|Case-Sensitive ', '   ']) {
      const outbound = trustedServiceUserHeaders(exactSub);
      expect(outbound['X-Oshal-User-Sub-B64']).toBe(Buffer.from(exactSub, 'utf8').toString('base64url'));
      expect(outbound['X-Oshal-User-Sub']).toBeUndefined();
      const headers = Object.fromEntries(Object.entries(outbound).map(([key, value]) => [key.toLowerCase(), value]));
      expect(getTrustedServiceUserSub({ headers } as unknown as Request)).toBe(exactSub);
    }
  });
  it('fails closed on malformed encoded subjects and never falls back to a conflicting legacy claim', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    for (const malformed of ['not+base64url', 'YQ==', Buffer.from([0xff]).toString('base64url')]) {
      const req = { headers: {
        'x-service-secret': 'super-secret',
        'x-oshal-user-sub-b64': malformed,
        'x-oshal-user-sub': 'admin-sub',
      } } as unknown as Request;
      expect(getTrustedServiceUserSub(req)).toBeNull();
    }
    expect(() => trustedServiceUserHeaders('a'.repeat(513))).toThrow(/512/);
  });
  it('rejects ambiguous legacy whitespace but preserves exact legacy case', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    const trusted = (sub: string) => getTrustedServiceUserSub({
      headers: { 'x-service-secret': 'super-secret', 'x-oshal-user-sub': sub },
    } as unknown as Request);
    expect(trusted('Auth0|Case')).toBe('Auth0|Case');
    expect(trusted(' Auth0|Case')).toBeNull();
    expect(trusted('Auth0|Case ')).toBeNull();
  });
  it('falls through to the auth fallback on a wrong secret', () => {
    process.env.SWARM_SERVICE_SECRET = 'super-secret';
    const { next, fallback } = run('wrong');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
  it('falls through (no bypass exists) when SWARM_SERVICE_SECRET is unconfigured', () => {
    const { next, fallback } = run('anything');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireServiceSecret', () => {
  function run(configured: string | undefined, provided: string | undefined) {
    if (configured === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = configured;
    const next = vi.fn();
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
    const headers = provided === undefined ? {} : { 'x-service-secret': provided };
    requireServiceSecret({ headers } as unknown as Request, res, next);
    return { next, json, status: res.status as ReturnType<typeof vi.fn> };
  }

  it('fails closed with 503 when the deployment secret is absent', () => {
    const result = run(undefined, undefined);
    expect(result.status).toHaveBeenCalledWith(503);
    expect(result.next).not.toHaveBeenCalled();
  });

  it('rejects a missing or incorrect caller secret', () => {
    expect(run('expected-secret', undefined).status).toHaveBeenCalledWith(401);
    expect(run('expected-secret', 'wrong-secret').status).toHaveBeenCalledWith(401);
  });

  it('continues only for the exact configured secret', () => {
    const result = run('expected-secret', 'expected-secret');
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.status).not.toHaveBeenCalled();
  });
});
