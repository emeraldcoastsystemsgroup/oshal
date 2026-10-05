/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the real auth-state HTTP router with synthetic authenticated session rails so filtered display claims cannot erase or replace the verified issuer.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthStateRoutes } from '@/app/routes/auth-state-routes';
import { GUEST_PRINCIPAL_ISSUER, LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';

type Session = { authenticated: boolean; user?: Record<string, unknown>; idTokenClaims?: unknown };
type AuthState = { authenticated: boolean; user: Record<string, unknown> | null; principalIssuer: string | null; mode: string; guestMode: boolean };
let session: Session | null, server: Server, base: string;

beforeAll(async () => {
  const app = express();
  // Only the session-verification port is synthetic. The router and issuer resolver are real.
  app.use((req, _res, next) => {
    const current = session;
    if (current) Object.defineProperty(req, 'oidc', { value: {
      isAuthenticated: () => current.authenticated, user: current.user,
      ...(Object.prototype.hasOwnProperty.call(current, 'idTokenClaims') ? { idTokenClaims: current.idTokenClaims } : {}),
    } });
    next();
  });
  app.use('/api/auth/user', createAuthStateRoutes());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  session = null;
  vi.stubEnv('MOCK_OIDC', 'false'); vi.stubEnv('LOCAL_AUTH', 'false');
  vi.stubEnv('OIDC_ISSUER_URL', 'https://configured.fixture.test');
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});

/** @description Read the genuine mounted router without credentials, caller issuer headers or redirect following.
 * @returns The successful auth-state response, including its authoritative nullable issuer.
 */
async function readAuthState(): Promise<AuthState> {
  const response = await fetch(base + '/api/auth/user', { redirect: 'manual' });
  expect(response.status).toBe(200);
  return response.json() as Promise<AuthState>;
}

describe('auth-state verified issuer over real HTTP', () => {
  it('exposes verified claims when the OIDC presentation user omits the issuer', async () => {
    session = { authenticated: true, user: { sub: 'same-subject', name: 'Fixture display' }, idTokenClaims: { iss: 'https://first.fixture.test' } };
    expect(await readAuthState()).toMatchObject({ authenticated: true, mode: 'oidc', user: session.user, principalIssuer: 'https://first.fixture.test' });
  });

  it('keeps the same subject distinct across verified issuers and overrides conflicting presentation claims', async () => {
    const user = { sub: 'same-subject', iss: 'https://display.fixture.test' };
    session = { authenticated: true, user, idTokenClaims: { iss: 'https://first.fixture.test' } };
    const first = await readAuthState();
    session = { authenticated: true, user, idTokenClaims: { iss: 'https://second.fixture.test' } };
    const second = await readAuthState();
    expect(first.user?.sub).toBe(second.user?.sub);
    expect(first.principalIssuer).toBe('https://first.fixture.test');
    expect(second.principalIssuer).toBe('https://second.fixture.test');
    expect(first.principalIssuer).not.toBe(second.principalIssuer);
  });

  it.each([{}, null, { iss: null }, { iss: '' }, { iss: '   ' }, { iss: 42 }, { iss: 'x'.repeat(2049) }])('keeps invalid present protocol claims fail-closed: %j', async idTokenClaims => {
    session = { authenticated: true, user: { sub: 'same-subject', iss: 'https://display.fixture.test' }, idTokenClaims };
    expect(await readAuthState()).toMatchObject({ authenticated: true, principalIssuer: null });
  });

  it('keeps missing provenance null despite a deployment issuer setting', async () => {
    session = { authenticated: true, user: { sub: 'same-subject' } };
    expect(await readAuthState()).toMatchObject({ authenticated: true, principalIssuer: null });
  });

  it.each([LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER])('retains the existing trusted non-OIDC issuer fallback: %s', async issuer => {
    session = { authenticated: true, user: { sub: 'same-subject', iss: issuer } };
    expect(await readAuthState()).toMatchObject({ authenticated: true, principalIssuer: issuer });
  });

  it('returns the exact guest issuer alongside the existing guest posture', async () => {
    session = { authenticated: true, user: { sub: 'guest:fixture-one', iss: GUEST_PRINCIPAL_ISSUER, is_guest: true } };
    expect(await readAuthState()).toMatchObject({ authenticated: true, principalIssuer: GUEST_PRINCIPAL_ISSUER, mode: 'guest', guestMode: true });
  });

  it('reports null issuer and user for unauthenticated requests, including stale claims', async () => {
    expect(await readAuthState()).toMatchObject({ authenticated: false, user: null, principalIssuer: null });
    session = { authenticated: false, user: { sub: 'same-subject', iss: LOCAL_AUTH_PRINCIPAL_ISSUER }, idTokenClaims: { iss: 'https://first.fixture.test' } };
    expect(await readAuthState()).toMatchObject({ authenticated: false, user: null, principalIssuer: null });
  });
});
