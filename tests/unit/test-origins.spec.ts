/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the shared spec-origin helpers: defaults mirror playwright.config.ts byte-for-byte (3456 plain / 4458 under MOCK_OIDC / 35457 live-api fallback), PLAYWRIGHT_PORT overrides every resolver, values are read at CALL time (no module-load caching), the 127.0.0.1 hostname distinction survives, and escapeForRegExp yields literal-only matches
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Hostname expectations pinned to the IPv4 loopback 127.0.0.1 — a "localhost" default resolves to ::1 where a stale wslrelay squats the port (258 ECONNREFUSED ::1 hits in the 2026-07-23 ci-local --head e2e run). These assertions ARE the guard: they go red if any helper reverts to the ::1-prone hostname. playwright.config.ts BASE_URL moved in the same change (guarded by ci-local-gate-reliability.spec.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  apiHost,
  apiOrigin,
  apiPort,
  baseHost,
  baseOrigin,
  basePort,
  escapeForRegExp,
} from '../helpers';

/** An env with no origin-relevant variables set — "the default env". */
const EMPTY: NodeJS.ProcessEnv = {};

describe('test-origins helper — default env (IPv4 loopback, same ports as the old literals)', () => {
  it('baseOrigin defaults to the plain isolated-server origin http://127.0.0.1:3456', () => {
    expect(basePort(EMPTY)).toBe(3456);
    expect(baseHost(EMPTY)).toBe('127.0.0.1:3456');
    expect(baseOrigin(EMPTY)).toBe('http://127.0.0.1:3456');
  });

  it('apiOrigin defaults to the live docker api origin http://127.0.0.1:35457 — never 3456', () => {
    expect(apiPort(EMPTY)).toBe(35457);
    expect(apiHost(EMPTY)).toBe('127.0.0.1:35457');
    expect(apiOrigin(undefined, EMPTY)).toBe('http://127.0.0.1:35457');
  });

  it('every default host is the IPv4 loopback, never the ::1-prone "localhost" (wslrelay wedge class)', () => {
    // The 2026-07-23 ci-local --head run: 61 e2e specs red with ECONNREFUSED ::1:3456 because
    // clients resolved localhost -> ::1 while the webServer served IPv4. This test goes red the
    // moment any helper's default hostname reverts.
    for (const value of [baseHost(EMPTY), baseOrigin(EMPTY), apiHost(EMPTY), apiOrigin(undefined, EMPTY)]) {
      expect(value).not.toContain('localhost');
      expect(value).toContain('127.0.0.1');
    }
  });

  it('apiOrigin still honors an explicit hostname argument', () => {
    expect(apiOrigin('oshal-local-api', EMPTY)).toBe('http://oshal-local-api:35457');
  });
});

describe('test-origins helper — env overrides (the same source of truth as playwright.config.ts)', () => {
  it('PLAYWRIGHT_PORT wins for BOTH resolvers (live-stack runs pin 35457; CI-mirror pins 3456)', () => {
    const live: NodeJS.ProcessEnv = { PLAYWRIGHT_PORT: '35457' };
    expect(baseOrigin(live)).toBe('http://127.0.0.1:35457');
    expect(apiOrigin(undefined, live)).toBe('http://127.0.0.1:35457');

    const ciMirror: NodeJS.ProcessEnv = { PLAYWRIGHT_PORT: '3456' };
    expect(baseOrigin(ciMirror)).toBe('http://127.0.0.1:3456');
    expect(apiOrigin(undefined, ciMirror)).toBe('http://127.0.0.1:3456');
  });

  it('a truthy shell MOCK_OIDC moves the base default to 4458 — mirroring playwright.config.ts — without touching the api fallback', () => {
    for (const spelling of ['true', '1', 'yes', ' TRUE ']) {
      expect(basePort({ MOCK_OIDC: spelling })).toBe(4458);
    }
    expect(basePort({ MOCK_OIDC: 'false' })).toBe(3456);
    expect(basePort({ MOCK_OIDC: '' })).toBe(3456);
    expect(apiPort({ MOCK_OIDC: 'true' })).toBe(35457);
  });

  it('an explicit PLAYWRIGHT_PORT beats the MOCK_OIDC default', () => {
    expect(basePort({ MOCK_OIDC: 'true', PLAYWRIGHT_PORT: '3456' })).toBe(3456);
  });

  it('a non-numeric PLAYWRIGHT_PORT falls back instead of producing a NaN URL', () => {
    expect(basePort({ PLAYWRIGHT_PORT: 'garbage' })).toBe(3456);
    expect(apiPort({ PLAYWRIGHT_PORT: '' })).toBe(35457);
  });

  it('reads process.env at CALL time — a mid-file override is honored, not cached at module load', () => {
    const original = process.env.PLAYWRIGHT_PORT;
    try {
      delete process.env.PLAYWRIGHT_PORT;
      const before = baseOrigin();
      process.env.PLAYWRIGHT_PORT = '19999';
      expect(baseOrigin()).toBe('http://127.0.0.1:19999');
      expect(apiOrigin()).toBe('http://127.0.0.1:19999');
      delete process.env.PLAYWRIGHT_PORT;
      expect(baseOrigin()).toBe(before);
    } finally {
      if (original === undefined) delete process.env.PLAYWRIGHT_PORT;
      else process.env.PLAYWRIGHT_PORT = original;
    }
  });
});

describe('test-origins helper — escapeForRegExp', () => {
  it('escapes regex metacharacters so hosts match literally', () => {
    const pattern = new RegExp(escapeForRegExp(apiOrigin('127.0.0.1', EMPTY)));
    expect(pattern.test('http://127.0.0.1:35457/api/health')).toBe(true);
    // Unescaped dots would match ANY character — the escaped pattern must not.
    expect(pattern.test('http://127x0y0z1:35457/api/health')).toBe(false);
  });

  it('composes into the URL waits the specs build from baseHost()', () => {
    const settled = new RegExp(`${escapeForRegExp(baseHost(EMPTY))}\\/(chat|welcome)`);
    expect(settled.test('http://127.0.0.1:3456/chat')).toBe(true);
    expect(settled.test('http://127.0.0.1:3456/callback?code=x')).toBe(false);
  });
});
