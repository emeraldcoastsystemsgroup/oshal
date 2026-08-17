/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the Entra-to-local migration boundary: tenant-only configuration, durable first-link/existing-link behavior, collision and disabled-account refusal, canonical local principal rewriting, and fail-closed HTTP outcomes.
 */

import type { Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  createEntraLocalIdentityBridgeMiddleware,
  expectedEntraIssuer,
  isEntraLocalAuthHybridEnabled,
  isEntraLocalIdentityBridgeEnabled,
  normalizeEntraIssuer,
  requireBridgeFirstLinkEmails,
  requireBridgeTenantId,
  resolveCanonicalLocalIdentity,
} from '@/app/middleware/entra-local-identity-bridge';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';

const TENANT = 'c59b8a83-b841-4f94-af93-2fe32390f0cf';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const EXTERNAL_SUB = '7fc1af6f-e89b-4bda-b595-57ea86fe3d54';
const ENTRA_OID = 'f1f62f20-e094-4a8d-b62b-9fb560b01ff8';
const LOCAL_SUB = 'local-8e324ea27c84c6d8';
const ACTIVE_ROW = {
  local_user_sub: LOCAL_SUB,
  email: 'igraiser@gsquaredfunding.com',
  display_name: 'Ira Graiser',
  status: 'active',
};

const BRIDGE_ENV = {
  ENTRA_LOCAL_IDENTITY_BRIDGE: 'true',
  MICROSOFT_TENANT_ID: TENANT,
  LOCAL_AUTH: 'false',
  MOCK_OIDC: 'false',
  ENTRA_LOCAL_IDENTITY_EMAILS: 'igraiser@gsquaredfunding.com',
} as NodeJS.ProcessEnv;

const HYBRID_ENV = {
  ...BRIDGE_ENV,
  ENTRA_LOCAL_IDENTITY_BRIDGE: 'false',
  ENTRA_LOCAL_AUTH_HYBRID: 'true',
  LOCAL_AUTH: 'true',
} as NodeJS.ProcessEnv;

function scriptedPool(...steps: Array<{ rows: unknown[] } | Error>): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  for (const step of steps) {
    if (step instanceof Error) query.mockRejectedValueOnce(step);
    else query.mockResolvedValueOnce(step);
  }
  return { pool: { query } as unknown as Pool, query };
}

function authenticatedRequest(overrides: Record<string, unknown> = {}): Request & { oidc: Record<string, unknown> } {
  const claims = {
    iss: ISSUER,
    tid: TENANT,
    sub: EXTERNAL_SUB,
    oid: ENTRA_OID,
    preferred_username: 'IGRAISER@GSQUAREDFUNDING.COM',
    ...overrides,
  };
  const context: Record<string, unknown> = {
    isAuthenticated() { return this === context; },
    user: claims,
    idTokenClaims: { ...claims, nonce: 'verified-by-upstream-oidc' },
    idToken: 'opaque-verified-id-token',
    accessToken: { access_token: 'test-token' },
    boundToOriginal() { return this === context; },
  };
  return { oidc: context, headers: {} } as unknown as Request & { oidc: Record<string, unknown> };
}

async function invoke(middleware: RequestHandler, req: Request): Promise<{
  nextCalls: number;
  status: number;
  body: Record<string, unknown> | null;
}> {
  let nextCalls = 0;
  let status = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: Record<string, unknown>) { body = value; return this; },
  } as unknown as Response;
  await (middleware as unknown as (
    request: Request,
    response: Response,
    next: () => void,
  ) => Promise<void>)(req, res, () => { nextCalls += 1; });
  return { nextCalls, status, body };
}

describe('Entra local identity bridge configuration', () => {
  it('is explicit, with hybrid implying the same durable bridge', () => {
    expect(isEntraLocalIdentityBridgeEnabled({})).toBe(false);
    expect(isEntraLocalIdentityBridgeEnabled({ ENTRA_LOCAL_IDENTITY_BRIDGE: 'true' })).toBe(true);
    expect(isEntraLocalIdentityBridgeEnabled({ ENTRA_LOCAL_AUTH_HYBRID: 'yes' })).toBe(true);
    expect(isEntraLocalAuthHybridEnabled({ ENTRA_LOCAL_AUTH_HYBRID: '1' })).toBe(true);
  });

  it('requires one tenant UUID and rejects multi-tenant aliases', () => {
    expect(requireBridgeTenantId({ MICROSOFT_TENANT_ID: TENANT.toUpperCase() })).toBe(TENANT);
    for (const tenant of ['', 'common', 'organizations', 'consumers', 'not-a-uuid']) {
      expect(() => requireBridgeTenantId({ MICROSOFT_TENANT_ID: tenant })).toThrow(/tenant-specific UUID/);
    }
  });

  it('requires a nonempty, fully valid first-link email allowlist', () => {
    expect(Array.from(requireBridgeFirstLinkEmails({
      ENTRA_LOCAL_IDENTITY_EMAILS: ' Roger@Example.com,igraiser@gsquaredfunding.com ',
    }))).toEqual(['roger@example.com', 'igraiser@gsquaredfunding.com']);
    for (const value of ['', '   ', 'not-an-email', 'roger@example.com,', 'roger@example.com,broken']) {
      expect(() => requireBridgeFirstLinkEmails({ ENTRA_LOCAL_IDENTITY_EMAILS: value })).toThrow(
        /ENTRA_LOCAL_IDENTITY_EMAILS/,
      );
    }
  });

  it('normalizes only exact tenant-specific HTTPS Entra issuers', () => {
    expect(normalizeEntraIssuer(`${ISSUER}/`)).toBe(ISSUER);
    expect(expectedEntraIssuer(TENANT.toUpperCase())).toBe(ISSUER);
    expect(normalizeEntraIssuer('https://login.microsoftonline.com/common/v2.0')).toBeNull();
    expect(normalizeEntraIssuer(`https://login.microsoftonline.com.evil.test/${TENANT}/v2.0`)).toBeNull();
    expect(normalizeEntraIssuer(`${ISSUER}?tenant=${TENANT}`)).toBeNull();
    expect(normalizeEntraIssuer(ISSUER.replace('https:', 'http:'))).toBeNull();
  });

  it('refuses standalone local/mock configurations but permits the explicit local-auth hybrid pilot', () => {
    const dependencies = { ensureSchema: vi.fn().mockResolvedValue(undefined) };
    expect(() => createEntraLocalIdentityBridgeMiddleware({} as Pool, {
      ...BRIDGE_ENV, LOCAL_AUTH: 'true',
    }, dependencies)).toThrow(/ENTRA_LOCAL_AUTH_HYBRID=true/);
    expect(() => createEntraLocalIdentityBridgeMiddleware({} as Pool, HYBRID_ENV, dependencies)).not.toThrow();
    expect(() => createEntraLocalIdentityBridgeMiddleware({} as Pool, {
      ...BRIDGE_ENV, MOCK_OIDC: 'true',
    }, dependencies)).toThrow(/MOCK_OIDC/);
    const missingAllowlist = { ...BRIDGE_ENV, ENTRA_LOCAL_IDENTITY_EMAILS: undefined };
    expect(() => createEntraLocalIdentityBridgeMiddleware(
      {} as Pool, missingAllowlist, dependencies,
    )).toThrow(/ENTRA_LOCAL_IDENTITY_EMAILS/);
  });
});

describe('durable external identity links', () => {
  it('uses an existing stable issuer+subject+oid link after its email leaves the first-link allowlist', async () => {
    const { pool, query } = scriptedPool({ rows: [ACTIVE_ROW] });
    const identity = await resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, null, TENANT, ENTRA_OID,
    );
    expect(identity).toEqual({
      userSub: LOCAL_SUB,
      email: ACTIVE_ROW.email,
      displayName: ACTIVE_ROW.display_name,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([ISSUER, EXTERNAL_SUB, TENANT, ENTRA_OID]);
  });

  it('first-links an already-active local account by normalized asserted email', async () => {
    const { pool, query } = scriptedPool({ rows: [] }, { rows: [ACTIVE_ROW] });
    const identity = await resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID,
    );
    expect(identity?.userSub).toBe(LOCAL_SUB);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID]);
    expect(query.mock.calls[1][0]).toContain("status IN ('active', 'invited')");
    expect(query.mock.calls[1][0]).toContain('entra_tenant_id, entra_object_id');
  });

  it('atomically accepts a pre-provisioned invitation while preserving the password rollback rail', async () => {
    const accepted = { ...ACTIVE_ROW, status: 'active' };
    const { pool, query } = scriptedPool({ rows: [] }, { rows: [accepted] });
    const identity = await resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID,
    );
    expect(identity?.userSub).toBe(LOCAL_SUB);
    const sql = String(query.mock.calls[1][0]);
    expect(sql).toContain("status IN ('active', 'invited')");
    expect(sql).toContain('activated_at = COALESCE');
    expect(sql).not.toContain('invite_token_hash = NULL');
    expect(sql).not.toContain('invite_expires_at = NULL');
  });

  it('does not bootstrap a link without an asserted account email', async () => {
    const { pool, query } = scriptedPool({ rows: [] });
    await expect(resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, null, TENANT, ENTRA_OID,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not rebind a disabled existing link by email', async () => {
    const { pool, query } = scriptedPool({ rows: [{ ...ACTIVE_ROW, status: 'disabled' }] });
    await expect(resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not first-link an unlinked disabled account', async () => {
    const { pool, query } = scriptedPool({ rows: [] }, { rows: [] }, { rows: [] });
    await expect(resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toContain("status IN ('active', 'invited')");
    expect(query.mock.calls[1][0]).not.toContain("status IN ('active', 'invited', 'disabled')");
  });

  it('turns a unique-link collision into a closed authorization result', async () => {
    const collision = Object.assign(new Error('duplicate key detail must not escape'), { code: '23505' });
    const { pool, query } = scriptedPool({ rows: [] }, collision);
    await expect(resolveCanonicalLocalIdentity(
      pool, ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID,
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('post-OIDC canonical principal mapping', () => {
  it('rewrites sub+issuer to the existing local principal and preserves the opaque OIDC context', async () => {
    const ensureSchema = vi.fn().mockResolvedValue(undefined);
    const resolveIdentity = vi.fn().mockResolvedValue({
      userSub: LOCAL_SUB,
      email: ACTIVE_ROW.email,
      displayName: ACTIVE_ROW.display_name,
    });
    const middleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, HYBRID_ENV, {
      ensureSchema,
      resolveIdentity,
    });
    const req = authenticatedRequest();
    const result = await invoke(middleware, req);

    expect(result).toEqual({ nextCalls: 1, status: 200, body: null });
    expect(resolveIdentity).toHaveBeenCalledWith(ISSUER, EXTERNAL_SUB, ACTIVE_ROW.email, TENANT, ENTRA_OID);
    expect(getCaller(req)).toEqual({ sub: LOCAL_SUB, email: ACTIVE_ROW.email });
    expect(getAuthenticatedPrincipalIssuer(req)).toBe('urn:oshal:local-auth');
    expect((req.oidc.user as Record<string, unknown>).tid).toBe(TENANT);
    expect((req.oidc.idTokenClaims as Record<string, unknown>).sub).toBe(LOCAL_SUB);
    expect(req.oidc.idToken).toBe('opaque-verified-id-token');
    expect((req.oidc.boundToOriginal as () => boolean)()).toBe(true);
    expect(ensureSchema).toHaveBeenCalledTimes(1);
  });

  it('rejects a verified session from any other issuer/tenant before account lookup', async () => {
    const resolveIdentity = vi.fn();
    const middleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, BRIDGE_ENV, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity,
    });
    const req = authenticatedRequest({ tid: '11111111-2222-4333-8444-555555555555' });
    const result = await invoke(middleware, req);
    expect(result.status).toBe(403);
    expect(result.body?.error).toBe('identity_not_provisioned');
    expect(result.nextCalls).toBe(0);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('passes a pilot-listed Roger email for first-link and withholds other preprovisioned emails', async () => {
    const pilotEnv = {
      ...BRIDGE_ENV,
      ENTRA_LOCAL_IDENTITY_EMAILS: 'roger@emeraldcoastsystemsgroup.com',
    };
    const rogerResolver = vi.fn().mockResolvedValue(null);
    const rogerMiddleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, pilotEnv, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity: rogerResolver,
    });
    await invoke(rogerMiddleware, authenticatedRequest({
      preferred_username: 'Roger@EmeraldCoastSystemsGroup.com',
    }));
    expect(rogerResolver).toHaveBeenCalledWith(
      ISSUER, EXTERNAL_SUB, 'roger@emeraldcoastsystemsgroup.com', TENANT, ENTRA_OID,
    );

    const otherResolver = vi.fn().mockResolvedValue(null);
    const otherMiddleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, pilotEnv, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity: otherResolver,
    });
    await invoke(otherMiddleware, authenticatedRequest());
    expect(otherResolver).toHaveBeenCalledWith(ISSUER, EXTERNAL_SUB, null, TENANT, ENTRA_OID);
  });

  it('rejects an unprovisioned/disabled account without falling through to raw Entra sub', async () => {
    const middleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, HYBRID_ENV, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity: vi.fn().mockResolvedValue(null),
    });
    const result = await invoke(middleware, authenticatedRequest());
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({
      authenticated: false,
      error: 'identity_not_provisioned',
      localLoginPath: '/login/local',
    });
    expect(result.nextCalls).toBe(0);
  });

  it('returns a closed 503 when identity storage is unavailable', async () => {
    const middleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, BRIDGE_ENV, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    const result = await invoke(middleware, authenticatedRequest());
    expect(result.status).toBe(503);
    expect(result.body?.error).toBe('identity_bridge_unavailable');
    expect(result.nextCalls).toBe(0);
  });

  it('leaves an anonymous request untouched for the normal requiresAuth/login flow', async () => {
    const middleware = createEntraLocalIdentityBridgeMiddleware({} as Pool, BRIDGE_ENV, {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      resolveIdentity: vi.fn(),
    });
    const req = { oidc: { isAuthenticated: () => false }, headers: {} } as unknown as Request;
    await expect(invoke(middleware, req)).resolves.toEqual({ nextCalls: 1, status: 200, body: null });
  });
});
