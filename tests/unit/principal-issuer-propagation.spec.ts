/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Guard fail-closed issuer extraction and the collision-resistant issuer namespace on signed guest sessions
 * -----------------------------------------------------------------------------
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  getAuthenticatedPrincipalIssuer,
  normalizePrincipalIssuer,
} from '@/shared/middleware/principal-issuer';
import {
  createGuestSessionInjector,
  GUEST_COOKIE,
  mintGuestCookie,
} from '@/shared/middleware/guest-session';

const SAVED_ENABLE_GUEST_MODE = process.env.ENABLE_GUEST_MODE;
const SAVED_SESSION_SECRET = process.env.SESSION_SECRET;

afterEach(() => {
  restoreEnv('ENABLE_GUEST_MODE', SAVED_ENABLE_GUEST_MODE);
  restoreEnv('SESSION_SECRET', SAVED_SESSION_SECRET);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('verified principal issuer propagation', () => {
  it('reads only a bounded issuer from an authenticated kernel identity', () => {
    expect(normalizePrincipalIssuer('  https://issuer.example.test  '))
      .toBe('https://issuer.example.test');
    expect(normalizePrincipalIssuer('x'.repeat(2049))).toBeNull();
    expect(getAuthenticatedPrincipalIssuer({} as Request)).toBeNull();

    const req = {
      oidc: {
        isAuthenticated: () => true,
        user: { iss: 'https://issuer.example.test' },
      },
    } as unknown as Request;
    expect(getAuthenticatedPrincipalIssuer(req)).toBe('https://issuer.example.test');
  });

  it('stamps a signed guest cookie with its own non-OIDC namespace', async () => {
    process.env.ENABLE_GUEST_MODE = 'true';
    process.env.SESSION_SECRET = 'issuer-propagation-spec-secret';
    const minted = mintGuestCookie();
    expect(minted).not.toBeNull();
    const req = {
      cookies: { [GUEST_COOKIE]: minted?.value },
      headers: {},
    } as unknown as Request;

    await new Promise<void>((resolve) => {
      createGuestSessionInjector()(req, {} as Response, (() => resolve()) as NextFunction);
    });

    expect(getAuthenticatedPrincipalIssuer(req)).toBe('urn:oshal:guest');
  });
});
