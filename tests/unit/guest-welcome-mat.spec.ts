/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins createGuestWelcomeMat (the /applications app-store preview gate): an anonymous GET is 302'd to /guest?next=<originalUrl> ONLY when guest mode is on; any session (guest or real), a non-GET, or guest mode off must fall through to the wrapped requiresAuth unchanged — the mat must never widen or replace real auth, only re-route the cold anonymous landing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
import { createGuestWelcomeMat } from '../../src/shared/middleware/guest-session';

const ORIGINAL_ENV = process.env.ENABLE_GUEST_MODE;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ENABLE_GUEST_MODE;
  else process.env.ENABLE_GUEST_MODE = ORIGINAL_ENV;
});

/**
 * @description Builds a minimal req/res pair plus spies for asserting which path
 * the mat took: a redirect, or delegation to the wrapped requiresAuth.
 * @param options - Request shape: method, originalUrl, and whether a session exists.
 * @returns The fake req/res, the wrapped-auth spy state, and the captured redirect.
 */
function invoke(options: { method?: string; originalUrl?: string; authenticated?: boolean }) {
  const state = { delegated: false, redirect: null as null | { status: number; url: string } };
  const requiresAuth: RequestHandler = () => {
    state.delegated = true;
  };
  const req = {
    method: options.method ?? 'GET',
    originalUrl: options.originalUrl ?? '/applications',
    ...(options.authenticated ? { oidc: { isAuthenticated: () => true } } : {}),
  } as unknown as Request;
  const res = {
    redirect: (status: number, url: string) => {
      state.redirect = { status, url };
    },
  } as unknown as Response;
  createGuestWelcomeMat(requiresAuth)(req, res, () => {});
  return state;
}

describe('createGuestWelcomeMat', () => {
  it('302s a cold anonymous GET to /guest with the deep link when guest mode is on', () => {
    process.env.ENABLE_GUEST_MODE = 'true';
    const state = invoke({ originalUrl: '/applications' });
    expect(state.delegated).toBe(false);
    expect(state.redirect).toEqual({ status: 302, url: '/guest?next=%2Fapplications' });
  });

  it('URL-encodes the full original URL (query string included) into next', () => {
    process.env.ENABLE_GUEST_MODE = 'true';
    const state = invoke({ originalUrl: '/applications?utm=x&y=1' });
    expect(state.redirect?.url).toBe('/guest?next=%2Fapplications%3Futm%3Dx%26y%3D1');
  });

  it('falls through to requiresAuth when guest mode is off', () => {
    delete process.env.ENABLE_GUEST_MODE;
    const state = invoke({});
    expect(state.redirect).toBeNull();
    expect(state.delegated).toBe(true);
  });

  it('falls through to requiresAuth for an authenticated session (guest cookie or real login)', () => {
    process.env.ENABLE_GUEST_MODE = 'true';
    const state = invoke({ authenticated: true });
    expect(state.redirect).toBeNull();
    expect(state.delegated).toBe(true);
  });

  it('falls through to requiresAuth for non-GET requests', () => {
    process.env.ENABLE_GUEST_MODE = 'true';
    const state = invoke({ method: 'POST' });
    expect(state.redirect).toBeNull();
    expect(state.delegated).toBe(true);
  });
});
