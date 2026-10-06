/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment A guards: a local account's email is whatever was typed when the account was made and was never verified, so a local-issuer principal never becomes an operator by email; nor does an authenticated request that carries no verified issuer (an older personal access token). Route-level: /api/swarm/roles/me, /status and /claim-root, the Jarvis brief and erasure refusal bind the same way, and the root row a local caller claims stores no email. operatorMatchKeys clears the email for the local issuer only; isOperator(req), resolveRole via callerFromRequest, resolveSwarmRoleGrant and requireAdminConsoleAccess all refuse a local principal whose address is on a root row or on OSHAL_OPERATOR_EMAILS, admit the same local principal by its own subject, and still admit an identity-provider principal reporting that address. A request with no issuer keeps the identity-only match it always had.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { isOperator, isOperatorIdentity, operatorMatchKeys, operatorRequestIssuer } from '@/shared/middleware/authz';
import { createSwarmRolesRoutes } from '@/app/routes/swarm-roles-routes';
import { createJarvisBriefRoutes } from '@/app/routes/jarvis-brief-routes';
import { composeMorningBrief, defaultBriefDeps } from '@/app/routes/jarvis-brief-sections';
import { isDeleteRefused } from '@/features/data-lifecycle/services/exporter-registry';
import { evaluateSuperAdmin } from '@/shared/middleware/superadmin';
import { LOCAL_AUTH_PRINCIPAL_ISSUER, MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { callerFromRequest, requireAdminConsoleAccess, resolveRole } from '@/features/governance/rbac/policy';
import { resolveSwarmRoleGrant } from '@/features/governance/rbac/grant-sources';
import { Role } from '@/features/governance/rbac/roles';

const IDP = 'https://login.example.test/tenant-a/v2.0';
const ADDRESS = 'owner@example.com';
const LOCAL_SUB = 'local-0123456789abcdef';
const IDP_SUB = 'idp-subject-7f3a';

const OPERATOR_ENV = ['OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_RBAC_OPERATOR_SUBS', 'OSHAL_RBAC_OPERATOR_EMAILS'];
const saved: Record<string, string | undefined> = {};

/** An authenticated request as the local, mock and identity-provider rails shape it: the issuer rides on the user claims. */
function signedIn(sub: string, email: string | null, iss?: string | null): Request {
  const user: Record<string, unknown> = { sub, email };
  if (iss !== undefined && iss !== null) user.iss = iss;
  return { oidc: { isAuthenticated: () => true, user } } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number } {
  const res = {} as Response & { statusCode?: number };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Response['status'];
  res.json = vi.fn(() => res) as unknown as Response['json'];
  return res;
}

beforeEach(() => {
  for (const key of OPERATOR_ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  clearPrivilegedIdentities();
});

afterEach(() => {
  for (const key of OPERATOR_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearPrivilegedIdentities();
});

describe('operatorMatchKeys', () => {
  it('clears the email for the local issuer and for a request carrying no verified issuer, and nothing else', () => {
    expect(operatorMatchKeys(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)).toEqual({ sub: LOCAL_SUB, email: null });
    expect(operatorMatchKeys(IDP_SUB, ADDRESS, IDP)).toEqual({ sub: IDP_SUB, email: ADDRESS });
    expect(operatorMatchKeys('mock-user', ADDRESS, MOCK_OIDC_PRINCIPAL_ISSUER)).toEqual({ sub: 'mock-user', email: ADDRESS });
    // An authenticated request that carries no verified issuer (null) has an unverified email too...
    expect(operatorMatchKeys(IDP_SUB, ADDRESS, null)).toEqual({ sub: IDP_SUB, email: null });
    // ...while identity-only callers (crons, dispatchers) pass no issuer at all and keep both keys.
    expect(operatorMatchKeys(IDP_SUB, ADDRESS)).toEqual({ sub: IDP_SUB, email: ADDRESS });
    expect(operatorMatchKeys(IDP_SUB, ADDRESS, undefined)).toEqual({ sub: IDP_SUB, email: ADDRESS });
    expect(operatorMatchKeys('', '', LOCAL_AUTH_PRINCIPAL_ISSUER)).toEqual({ sub: null, email: null });
  });
});

describe('a local principal whose email is on a root row', () => {
  beforeEach(() => setPrivilegedIdentities([{ sub: IDP_SUB, email: ADDRESS, role: 'root' }]));

  it('is not an operator on its request, while the identity-provider principal with that address is', () => {
    expect(isOperator(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER))).toBe(false);
    expect(isOperator(signedIn(IDP_SUB, ADDRESS, IDP))).toBe(true);
    expect(isOperator(signedIn('idp-other', ADDRESS, IDP))).toBe(true);
    // The identity-only form keeps its compatibility match when no issuer is known.
    expect(isOperatorIdentity('anyone', ADDRESS)).toBe(true);
    expect(isOperatorIdentity(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(false);
  });

  it('resolves to viewer through callerFromRequest, and to admin for the provider principal', () => {
    expect(resolveRole(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)))).toBe(Role.Viewer);
    expect(resolveRole(callerFromRequest(signedIn(IDP_SUB, ADDRESS, IDP)))).toBe(Role.Admin);
    expect(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)).issuer).toBe(LOCAL_AUTH_PRINCIPAL_ISSUER);
  });

  it('carries no swarm-role provenance, reports its email as not evaluated, and is not root by a borrowed address', () => {
    const local = resolveSwarmRoleGrant({ sub: LOCAL_SUB, email: ADDRESS, roles: [], issuer: LOCAL_AUTH_PRINCIPAL_ISSUER });
    expect(local).toMatchObject({ role: Role.Viewer, sources: [], source: 'none', isRoot: false, emailEvaluated: false });
    const provider = resolveSwarmRoleGrant({ sub: 'idp-other', email: ADDRESS, roles: [], issuer: IDP });
    expect(provider).toMatchObject({ role: Role.Admin, sources: ['swarm-role'], isRoot: false, emailEvaluated: true });
    expect(resolveSwarmRoleGrant({ sub: IDP_SUB, email: null, roles: [], issuer: IDP }).isRoot).toBe(true);
  });

  it('is refused by the admin console, which the root row alone restricts', () => {
    const next = vi.fn();
    const res = fakeRes();
    requireAdminConsoleAccess()(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    const admitted = vi.fn();
    requireAdminConsoleAccess()(signedIn('idp-other', ADDRESS, IDP), fakeRes(), admitted);
    expect(admitted).toHaveBeenCalledOnce();
  });

  it('is an operator through its own subject: a role row or an OSHAL_OPERATOR_SUBS entry', () => {
    process.env.OSHAL_OPERATOR_SUBS = LOCAL_SUB;
    expect(isOperator(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER))).toBe(true);
    delete process.env.OSHAL_OPERATOR_SUBS;
    setPrivilegedIdentities([{ sub: LOCAL_SUB, email: ADDRESS, role: 'admin' }]);
    expect(isOperator(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER))).toBe(true);
    expect(resolveRole(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)))).toBe(Role.Admin);
  });
});

describe('a local principal whose email is on OSHAL_OPERATOR_EMAILS', () => {
  beforeEach(() => { process.env.OSHAL_OPERATOR_EMAILS = `ops@example.com, ${ADDRESS.toUpperCase()}`; });

  it('is not an operator and not an admin, while a provider or mock principal with that address is', () => {
    expect(isOperator(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER))).toBe(false);
    expect(resolveRole(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)))).toBe(Role.Viewer);
    expect(resolveSwarmRoleGrant({ sub: LOCAL_SUB, email: ADDRESS, roles: [], issuer: LOCAL_AUTH_PRINCIPAL_ISSUER }).sources).toEqual([]);
    const refused = fakeRes();
    const next = vi.fn();
    requireAdminConsoleAccess()(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER), refused, next);
    expect(next).not.toHaveBeenCalled();
    expect(refused.statusCode).toBe(403);

    expect(isOperator(signedIn(IDP_SUB, ADDRESS, IDP))).toBe(true);
    expect(isOperator(signedIn('mock-user-001', ADDRESS, MOCK_OIDC_PRINCIPAL_ISSUER))).toBe(true);
    expect(resolveRole(callerFromRequest(signedIn(IDP_SUB, ADDRESS, IDP)))).toBe(Role.Admin);
    expect(resolveSwarmRoleGrant({ sub: IDP_SUB, email: ADDRESS, roles: [], issuer: IDP }).sources).toEqual(['break-glass']);
  });
});

/** One request against a throwaway loopback server with the given signed-in user. */
async function serve(mount: (app: express.Express) => void): Promise<{ get: (path: string, user: Record<string, unknown>, method?: string) => Promise<{ status: number; body: Record<string, unknown> }>; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = JSON.parse(String(req.headers['x-fixture-user'] ?? 'null')) as Record<string, unknown> | null;
    if (user) Object.assign(req, { oidc: { isAuthenticated: () => true, user } });
    next();
  });
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path, user, method = 'GET') => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': JSON.stringify(user) }, body: method === 'POST' ? '{}' : undefined });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const passThrough: RequestHandler = (_req, _res, next) => next();

describe('an authenticated request that carries no verified issuer (an older personal access token)', () => {
  it('matches by subject only; a request with no principal at all keeps the identity-only match', () => {
    process.env.OSHAL_OPERATOR_EMAILS = ADDRESS;
    const legacyPat = { oidc: { isAuthenticated: () => true, user: { sub: 'pat-owner', email: ADDRESS } } } as unknown as Request;
    expect(operatorRequestIssuer(legacyPat)).toBeNull();
    expect(isOperator(legacyPat)).toBe(false);
    expect(resolveRole(callerFromRequest(legacyPat))).toBe(Role.Viewer);
    process.env.OSHAL_OPERATOR_SUBS = 'pat-owner';
    expect(isOperator(legacyPat)).toBe(true);
    // A request carrying a user principal without isAuthenticated is no better: a rail cannot keep an email match by
    // omitting its issuer. Only a request with no principal at all is matched as an identity-only caller is.
    const bare = { oidc: { user: { sub: 'someone', email: ADDRESS } } } as unknown as Request;
    expect(operatorRequestIssuer(bare)).toBeNull();
    expect(isOperator(bare)).toBe(false);
    expect(operatorRequestIssuer({ oidc: {} } as unknown as Request)).toBeUndefined();
    expect(operatorRequestIssuer({} as unknown as Request)).toBeUndefined();
  });
});

describe('the OSHAL_RBAC_OPERATOR_* allowlist binds the same way', () => {
  it('gives the Operator role to a provider principal by email, never to a local one', () => {
    process.env.OSHAL_RBAC_OPERATOR_EMAILS = ADDRESS;
    expect(resolveRole(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)))).toBe(Role.Viewer);
    expect(resolveRole(callerFromRequest(signedIn(IDP_SUB, ADDRESS, IDP)))).toBe(Role.Operator);
    process.env.OSHAL_RBAC_OPERATOR_SUBS = LOCAL_SUB;
    expect(resolveRole(callerFromRequest(signedIn(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)))).toBe(Role.Operator);
  });
});

describe('the role routes bind the caller as isOperator does', () => {
  const emptyPool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
  const local = { sub: LOCAL_SUB, email: ADDRESS, iss: LOCAL_AUTH_PRINCIPAL_ISSUER };
  const provider = { sub: IDP_SUB, email: ADDRESS, iss: IDP };

  it('/me and /status report a local principal with a root-row email as no operator, and the provider principal as one', async () => {
    setPrivilegedIdentities([{ sub: 'kc-owner', email: ADDRESS, role: 'root' }]);
    const app = await serve((a) => a.use('/api/swarm/roles', createSwarmRolesRoutes(emptyPool, passThrough)));
    try {
      expect((await app.get('/api/swarm/roles/me', local)).body).toMatchObject({ isOperator: false, breakGlassOnly: false });
      expect((await app.get('/api/swarm/roles/me', provider)).body).toMatchObject({ isOperator: true });
      expect((await app.get('/api/swarm/roles/status', local)).body).toMatchObject({ callerIsOperator: false, callerIssuer: LOCAL_AUTH_PRINCIPAL_ISSUER });
      expect((await app.get('/api/swarm/roles/status', provider)).body).toMatchObject({ callerIsOperator: true });
    } finally { await app.close(); }
  });

  it('/claim-root refuses a local principal whose typed email is on OSHAL_OPERATOR_EMAILS, and admits the provider principal', async () => {
    process.env.OSHAL_OPERATOR_EMAILS = ADDRESS;
    const app = await serve((a) => a.use('/api/swarm/roles', createSwarmRolesRoutes(emptyPool, passThrough)));
    try {
      const refused = await app.get('/api/swarm/roles/claim-root', local, 'POST');
      expect(refused.status).toBe(403);
      expect(String(refused.body.error)).toContain('existing operator');
      // The provider principal passes the operator gate; the claim itself then runs against the store.
      expect((await app.get('/api/swarm/roles/claim-root', provider, 'POST')).status).not.toBe(403);
    } finally { await app.close(); }
  });

  it('the root row a caller with no verified issuer claims stores no email, whatever its subject looks like', async () => {
    process.env.OSHAL_OPERATOR_SUBS = 'pat-owner';
    const inserts: unknown[][] = [];
    const pool = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO swarm_roles/i.test(sql)) { inserts.push(params ?? []); return { rows: [{ user_sub: params?.[0], email: params?.[1], role: 'root' }] }; }
      return { rows: [] };
    }) } as unknown as Pool;
    const app = await serve((a) => a.use('/api/swarm/roles', createSwarmRolesRoutes(pool, passThrough)));
    try {
      // An older personal access token: a user principal with an email but no issuer.
      await app.get('/api/swarm/roles/claim-root', { sub: 'pat-owner', email: ADDRESS }, 'POST');
      expect(inserts.length).toBeGreaterThan(0);
      expect(inserts[0][0]).toBe('pat-owner');
      expect(inserts[0][1]).toBeNull();
    } finally { await app.close(); }
  });

  it('the root row a local operator claims stores no email', async () => {
    process.env.OSHAL_OPERATOR_SUBS = LOCAL_SUB;
    const inserts: unknown[][] = [];
    const pool = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO swarm_roles/i.test(sql)) { inserts.push(params ?? []); return { rows: [{ user_sub: params?.[0], email: params?.[1], role: 'root' }] }; }
      return { rows: [] };
    }) } as unknown as Pool;
    const app = await serve((a) => a.use('/api/swarm/roles', createSwarmRolesRoutes(pool, passThrough)));
    try {
      await app.get('/api/swarm/roles/claim-root', local, 'POST');
      expect(inserts.length).toBeGreaterThan(0);
      expect(inserts[0][0]).toBe(LOCAL_SUB);
      expect(inserts[0][1]).toBeNull();
    } finally { await app.close(); }
  });
});

describe('the Jarvis brief and erasure refusal bind the same way', () => {
  it("defaultBriefDeps.isOperator takes the issuer, so a local principal's trading recap is scoped away", () => {
    process.env.OSHAL_OPERATOR_EMAILS = ADDRESS;
    const deps = defaultBriefDeps({ pool: {} } as never);
    expect(deps.isOperator(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBe(false);
    expect(deps.isOperator(IDP_SUB, ADDRESS, IDP)).toBe(true);
    expect(deps.isOperator('cron-owner', ADDRESS)).toBe(true);
  });

  it('composeMorningBrief passes the issuer through, and passes none for the cron, which has no request', async () => {
    const isOperatorSpy = vi.fn(() => false);
    const deps = { isOperator: isOperatorSpy, readDeckData: () => null } as never;
    await composeMorningBrief(deps, LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER);
    expect(isOperatorSpy).toHaveBeenLastCalledWith(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER);
    await composeMorningBrief(deps, 'cron-owner');
    expect(isOperatorSpy).toHaveBeenLastCalledWith('cron-owner', null, undefined);
  });

  it('GET /api/jarvis/brief composes with the issuer isOperator binds to', async () => {
    const isOperatorSpy = vi.fn(() => false);
    const deps = { isOperator: isOperatorSpy, readDeckData: () => null } as never;
    const app = await serve((a) => a.use('/api/jarvis', createJarvisBriefRoutes(passThrough, { pool: {} } as never, deps)));
    try {
      const res = await app.get('/api/jarvis/brief', { sub: LOCAL_SUB, email: ADDRESS, iss: LOCAL_AUTH_PRINCIPAL_ISSUER });
      expect(res.status).toBe(200);
      expect(isOperatorSpy).toHaveBeenCalledWith(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER);
    } finally { await app.close(); }
  });

  it('isDeleteRefused does not treat a local user with an operator\'s typed email as the operator', () => {
    process.env.OSHAL_OPERATOR_EMAILS = ADDRESS;
    expect(isDeleteRefused(LOCAL_SUB, ADDRESS, LOCAL_AUTH_PRINCIPAL_ISSUER)).toBeNull();
    expect(isDeleteRefused(IDP_SUB, ADDRESS, IDP)).toMatch(/operator allowlist/);
    expect(isDeleteRefused(IDP_SUB, ADDRESS)).toMatch(/operator allowlist/);
  });
});

describe('OSHAL_SUPERADMIN_EMAILS binds the same way', () => {
  it('admits an identity-provider principal by email, a local or issuer-less one only by subject', () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_EMAILS = 'Dev@Example.test';
    delete process.env.OSHAL_SUPERADMIN_SUBS;
    try {
      expect(evaluateSuperAdmin(signedIn('idp-dev', 'dev@example.test', IDP)).allowed).toBe(true);
      const local = evaluateSuperAdmin(signedIn(LOCAL_SUB, 'dev@example.test', LOCAL_AUTH_PRINCIPAL_ISSUER));
      expect(local).toMatchObject({ allowed: false, checks: { onAllowlist: false } });
      expect(evaluateSuperAdmin(signedIn('pat-owner', 'dev@example.test')).allowed).toBe(false);
      process.env.OSHAL_SUPERADMIN_SUBS = LOCAL_SUB;
      expect(evaluateSuperAdmin(signedIn(LOCAL_SUB, 'dev@example.test', LOCAL_AUTH_PRINCIPAL_ISSUER)).allowed).toBe(true);
    } finally {
      delete process.env.OSHAL_DEV_CONSOLE_ENABLED;
      delete process.env.OSHAL_SUPERADMIN_EMAILS;
      delete process.env.OSHAL_SUPERADMIN_SUBS;
    }
  });
});
