/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise current account and directory provenance through the real identity bridge and actor resolver.
 */
import type { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationAuthorizationActorResolver, directoryEvidence } from '../../src/app/middleware/application-authorization-identity';
import { createEntraLocalIdentityBridgeMiddleware } from '../../src/app/middleware/entra-local-identity-bridge';
import { getPreservedDirectoryClaims } from '../../src/shared/middleware/verified-directory-claims';

const tenant = '11111111-2222-4333-8444-555555555555';
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const now = Date.parse('2026-09-10T12:00:00Z');
const claims = { iss: issuer, tid: tenant, oid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sub: 'directory-person',
  aud: 'configured-client', iat: now / 1000, exp: now / 1000 + 3600, groups: ['bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'] };
function request(user: Record<string, unknown>, verified?: Record<string, unknown>): Request {
  return { oidc: { isAuthenticated: () => true, user, ...(verified ? { idTokenClaims: verified } : {}) }, headers: {} } as unknown as Request;
}
afterEach(() => vi.useRealTimers());

describe('verified application actor resolution', () => {
  it('checks current local account status even while a session remains authenticated', async () => {
    const localSnapshot = vi.fn().mockResolvedValueOnce({ status: 'active' }).mockResolvedValueOnce({ status: 'disabled' });
    const resolve = createApplicationAuthorizationActorResolver({} as Pool, { localSnapshot, tenantIds: async () => ['business-a'], management: () => true });
    const req = request({ iss: 'urn:oshal:local-auth', sub: 'local-person' });
    expect(await resolve(req)).toMatchObject({ isActive: true, isSwarmAdmin: true, tenantIds: ['business-a'] });
    expect(await resolve(req)).toMatchObject({ isActive: false, isSwarmAdmin: false, tenantIds: [] });
    expect(localSnapshot).toHaveBeenCalledTimes(2);
  });

  it('refuses body/header asserted identities when no verified session exists', async () => {
    const resolve = createApplicationAuthorizationActorResolver({} as Pool, { tenantIds: async () => [] });
    await expect(resolve({ body: { sub: 'root', issuer }, headers: { 'x-oshal-user-sub': 'root' } } as unknown as Request)).rejects.toMatchObject({ status: 401 });
  });

  it('does not make an arbitrary external identity a swarm administrator', async () => {
    const resolve = createApplicationAuthorizationActorResolver({} as Pool, { env: {}, now: () => now, tenantIds: async () => [] });
    expect(await resolve(request({ sub: claims.sub }, claims))).toMatchObject({ issuer, isSwarmAdmin: false, directory: [{ complete: true, issuer }] });
  });

  it('does not reuse subject-only business memberships for another issuer', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tenant_id: 'foreign-business' }] });
    const resolve = createApplicationAuthorizationActorResolver({ query } as unknown as Pool, { env: {}, now: () => now });
    expect(await resolve(request({ sub: claims.sub }, claims))).toMatchObject({ tenantIds: [], isSwarmAdmin: false });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads current administrator rights instead of accepting a cached role after revocation', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ user_sub: 'local-person', role: 'admin', granted_at: new Date(now) }] })
      .mockResolvedValueOnce({ rows: [] });
    const resolve = createApplicationAuthorizationActorResolver({ query } as unknown as Pool, {
      env: {}, localSnapshot: async () => ({ status: 'active' }), tenantIds: async () => [],
    });
    const req = request({ sub: 'local-person', iss: 'urn:oshal:local-auth' });
    expect((await resolve(req)).isSwarmAdmin).toBe(true);
    expect((await resolve(req)).isSwarmAdmin).toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('marks overage, missing groups, stale or future claims incomplete without fetching claim URLs', () => {
    expect(directoryEvidence(claims, now)?.[0]).toMatchObject({ complete: true, observedAt: new Date(now).toISOString() });
    for (const extra of [{ hasgroups: true }, { groups: undefined }, { iat: now / 1000 - 301 }, { iat: now / 1000 + 1 }, { _claim_names: { groups: 'remote' }, _claim_sources: { remote: { endpoint: 'https://attacker.invalid' } } }]) {
      expect(directoryEvidence({ ...claims, ...extra }, now)?.[0].complete).toBe(false);
    }
    expect(directoryEvidence({ ...claims, tid: 'aaaaaaaa-2222-4333-8444-555555555555' }, now)).toEqual([]);
  });

  it('preserves verified directory provenance while expiring local-account cache under continuous traffic', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const resolveIdentity = vi.fn().mockResolvedValueOnce({ userSub: 'local-person', email: 'person@example.test', displayName: 'Person' }).mockResolvedValueOnce(null);
    const bridge = createEntraLocalIdentityBridgeMiddleware({} as Pool, {
      ENTRA_LOCAL_IDENTITY_BRIDGE: 'true', MICROSOFT_TENANT_ID: tenant, LOCAL_AUTH: 'false', MOCK_OIDC: 'false',
      ENTRA_LOCAL_IDENTITY_EMAILS: 'person@example.test',
    }, { ensureSchema: async () => {}, resolveIdentity });
    const invoke = async () => {
      const req = request({ sub: claims.sub, email: 'person@example.test' }, claims);
      let status = 200;
      const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
      const next = vi.fn();
      await bridge(req, res, next as NextFunction);
      return { req, status, next };
    };
    const first = await invoke();
    expect(first.next).toHaveBeenCalledOnce();
    expect(first.req.oidc.user?.sub).toBe('local-person');
    expect(getPreservedDirectoryClaims(first.req)).toMatchObject({ iss: issuer, sub: claims.sub, groups: claims.groups });
    vi.setSystemTime(now + 20_000);
    expect((await invoke()).status).toBe(200);
    expect(resolveIdentity).toHaveBeenCalledOnce();
    vi.setSystemTime(now + 40_000);
    expect((await invoke()).status).toBe(403);
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });
});
