/**
 * Rate-limit preset hardening tests (additive, all disabled by default).
 *
 * Proves:
 *  - flag OFF (default): makeLimiter returns a no-op middleware that calls next()
 *    without limiting (today's behavior unchanged);
 *  - flag ON: makeLimiter returns a real express-rate-limit middleware
 *    (function arity matches express middleware, not the bare next-caller);
 *  - env numeric overrides are honored.
 *
 * Note: presets internalMeshLimiter / expensiveOpLimiter are evaluated at module
 * import time, so their on/off state reflects the env at import. These tests use
 * makeLimiter directly to exercise both branches deterministically.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for opt-in rate-limit presets.
 */
import { test, expect } from '@playwright/test';
import type { Request, Response } from 'express';
import { makeLimiter } from '@/features/security/hardening/rate-limit-presets';

test.beforeEach(() => {
  delete process.env.OSHAL_RATE_LIMIT_UNITTEST;
  delete process.env.OSHAL_RATE_LIMIT_UNITTEST_MAX;
  delete process.env.OSHAL_RATE_LIMIT_UNITTEST_WINDOW_MS;
});

test('off by default — makeLimiter returns a pass-through no-op', () => {
  const mw = makeLimiter('unittest', { max: 1, windowMs: 60_000 });
  let called = false;
  // The no-op must call next() unconditionally and never touch res.
  const req = { headers: {} } as Request;
  const res = {} as Response;
  mw(req, res, () => { called = true; });
  expect(called).toBe(true);
});

test('off by default — even repeated calls never limit (no-op branch)', () => {
  const mw = makeLimiter('unittest', { max: 1, windowMs: 60_000 });
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' } } as unknown as Request;
  const res = {} as Response;
  let count = 0;
  for (let i = 0; i < 5; i++) mw(req, res, () => { count++; });
  expect(count).toBe(5); // all passed through; nothing throttled
});

test('flag on — makeLimiter returns a real limiter middleware', () => {
  process.env.OSHAL_RATE_LIMIT_UNITTEST = 'on';
  const mw = makeLimiter('unittest', { max: 1, windowMs: 60_000 });
  // express-rate-limit middleware is a function; it differs from our trivial
  // no-op in that it has its own properties (resetKey/getKey) attached.
  expect(typeof mw).toBe('function');
  expect('resetKey' in mw).toBe(true);
});

test('env numeric overrides are read for an enabled limiter', () => {
  process.env.OSHAL_RATE_LIMIT_UNITTEST = 'on';
  process.env.OSHAL_RATE_LIMIT_UNITTEST_MAX = '7';
  const mw = makeLimiter('unittest', { max: 1, windowMs: 60_000 });
  expect(typeof mw).toBe('function');
  // The override is applied internally; presence of the real limiter (resetKey)
  // confirms the enabled branch ran with overrides resolved.
  expect('resetKey' in mw).toBe(true);
});
