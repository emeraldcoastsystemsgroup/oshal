/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 9 guard: MOCK_OIDC is fail-closed by default. (1) Unset/false/garbage env never enables the mock — only an explicit truthy value does; (2) with MOCK_OIDC unset and no OIDC session secret configured, createOidcMiddleware() THROWS at construction (fail loud) instead of silently falling back to the open mock session — the exact latent footgun the hardening list names for a fresh deploy whose .env is missing; (3) the explicit MOCK_OIDC=true path still yields the injected demo session (local dev unbroken); (4) the compose interpolation default is pinned to false, so a box whose .env forgot the key boots CLOSED — the installer writes MOCK_OIDC=true explicitly for dev boxes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createOidcMiddleware, isMockOidcEnabled } from '../../src/shared/middleware/oidc';

const ENV_KEYS = [
  'MOCK_OIDC', 'MOCK_OIDC_ALLOW_HEADER', 'SESSION_SECRET', 'AUTH_SESSION_SECRET',
  'KEYCLOAK_CLIENT_SECRET', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET',
  'OIDC_BASE_URLS', 'SESSION_COOKIE_DOMAIN', 'APP_URL', 'KEYCLOAK_URL', 'KEYCLOAK_EXTERNAL_URL',
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('MOCK_OIDC is an explicit opt-in, never a default', () => {
  it('unset, empty, false, and garbage all mean DISABLED', () => {
    expect(isMockOidcEnabled()).toBe(false);
    for (const v of ['', 'false', '0', 'no', 'banana', 'TRUE-ish']) {
      process.env.MOCK_OIDC = v;
      expect(isMockOidcEnabled(), `MOCK_OIDC=${JSON.stringify(v)} must not enable the mock`).toBe(false);
    }
  });

  it('only an explicit truthy value enables it', () => {
    for (const v of ['true', '1', 'yes', 'TRUE']) {
      process.env.MOCK_OIDC = v;
      expect(isMockOidcEnabled(), `MOCK_OIDC=${v}`).toBe(true);
    }
  });
});

describe('missing OIDC config fails LOUD, never silently mocks', () => {
  it('createOidcMiddleware throws when MOCK_OIDC is unset and no session secret exists', () => {
    // The fresh-deploy footgun shape: no .env at all. The only acceptable outcome is a
    // boot-time throw — an open mock session here would authenticate every visitor.
    expect(() => createOidcMiddleware()).toThrow(/SESSION_SECRET|KEYCLOAK_CLIENT_SECRET/);
  });

  it('the explicit MOCK_OIDC=true path still injects the demo session (local dev unbroken)', () => {
    process.env.MOCK_OIDC = 'true';
    const set = createOidcMiddleware();
    const req: Record<string, unknown> = { header: () => undefined };
    let nexted = false;
    (set.authMiddleware as (rq: unknown, rs: unknown, nx: () => void) => void)(req, {}, () => { nexted = true; });
    expect(nexted).toBe(true);
    const oidc = req.oidc as { isAuthenticated: () => boolean; user: { sub: string } };
    expect(oidc.isAuthenticated()).toBe(true);
    expect(oidc.user.sub).toBeTruthy();
  });
});

describe('the compose default is fail-closed', () => {
  it('docker-compose.oshal-local.yml interpolates MOCK_OIDC with a FALSE default', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '../../docker-compose.oshal-local.yml'), 'utf8');
    // The one sanctioned shape. A true-default here silently opens auth on any box whose
    // .env forgot the key (SECURITY-HARDENING 9) — the installer opts dev boxes in explicitly.
    expect(compose).toMatch(/MOCK_OIDC:\s*\$\{MOCK_OIDC:-false\}/);
    expect(compose).not.toMatch(/MOCK_OIDC:-true/);
  });
});
