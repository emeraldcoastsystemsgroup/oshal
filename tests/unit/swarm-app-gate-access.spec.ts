/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: prove the global app gate enforces tiers on hard-mounted kernel routes while preserving inactive precedence, legacy manifests, and anonymous guest-matrix ownership.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove verified issuer forwarding, missing-issuer refusal, and same-subject cross-issuer isolation at the real HTTP boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Pin the fleet service-secret rail at the HTTP boundary: a call carrying X-Oshal-User-Sub-B64 resolves its subject (appAccessCallerSub) but has no verified issuer, and the gate refuses it with app_access_identity_required before any tier is resolved. Second review of PR 605 found that refusal undocumented and untested; the decision to keep it is recorded in docs/security/application-authorization.md.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { AppAccessResolver, ResolvedAppAccess, SwarmAppService } from '../../src/features/swarm-apps';
import { createSwarmAppGateMiddleware } from '../../src/app/middleware/swarm-app-gate-middleware';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { appAccessCallerIssuer, appAccessCallerSub } from '../../src/app/middleware/app-access-policy';

const ACCESS = { supported: ['deny', 'viewer', 'editor', 'admin'] as const, defaultTier: 'viewer' as const };
const ISSUER = 'https://identity.example.test';

async function boot(input: {
  owner: ReturnType<SwarmAppService['ownerOf']>;
  decision?: ResolvedAppAccess;
  subject?: string;
  issuer?: string | null;
  session?: { sub: string; issuer: string | null };
  resolver?: AppAccessResolver;
}): Promise<{ server: Server; base: string; resolve: ReturnType<typeof vi.fn> }> {
  const ownerOf = vi.fn().mockReturnValue(input.owner);
  const service = { ownerOf } as unknown as SwarmAppService;
  const resolve = vi.fn().mockResolvedValue(input.decision);
  const resolver = input.resolver ?? { resolveForPrincipal: resolve } as unknown as AppAccessResolver;
  const app = express();
  if (input.session) {
    app.use((req, _res, next) => {
      Object.assign(req, { oidc: {
        isAuthenticated: () => true,
        user: { sub: input.session!.sub, iss: 'https://presentation.example.test' },
        idTokenClaims: { iss: input.session!.issuer },
      } });
      next();
    });
  }
  if (input.subject) {
    app.use((_req, _res, next) => runWithRequestIdentity(
      { sub: input.subject!, principalIssuer: input.issuer === undefined ? ISSUER : input.issuer, isOperator: false }, () => next(),
    ));
  }
  app.use(createSwarmAppGateMiddleware(service, resolver));
  app.all('/api/kernel/*rest', (req, res) => res.json({ reached: true, method: req.method }));
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, resolve };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('hard-mounted kernel app access gate', () => {
  afterEach(() => { delete process.env.OSHAL_APP_ACCESS_MODE; });

  it('never joins a carried service subject to a subject-less OIDC issuer', () => {
    expect(appAccessCallerIssuer({ oshalCallerSub: 'carried-subject', oidc: {
      isAuthenticated: () => true, user: {}, idTokenClaims: { iss: ISSUER },
    } } as never)).toBeNull();
  });

  it.each(['delegated', 'oidc'] as const)('forwards the exact verified %s issuer to the resolver', async (rail) => {
    const declaration = { ...ACCESS, supported: [...ACCESS.supported] };
    const { server, base, resolve } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: declaration },
      ...(rail === 'delegated' ? { subject: 'same-sub', issuer: ISSUER } : { session: { sub: 'same-sub', issuer: ISSUER } }),
      decision: { appName: 'kernel-app', userSub: 'same-sub', tier: 'admin', bundle: null, source: 'explicit' },
    });
    try {
      expect((await fetch(`${base}/api/kernel/write`, { method: 'POST' })).status).toBe(200);
      expect(resolve).toHaveBeenCalledExactlyOnceWith('kernel-app', 'same-sub', ISSUER, declaration);
    } finally { await stop(server); }
  });

  it.each(['delegated', 'oidc'] as const)('rejects a signed-in %s caller with no verified issuer despite supplied issuer hints', async (rail) => {
    const { server, base, resolve } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      ...(rail === 'delegated' ? { subject: 'same-sub', issuer: null } : { session: { sub: 'same-sub', issuer: null } }),
      decision: { appName: 'kernel-app', userSub: 'same-sub', tier: 'admin', bundle: null, source: 'explicit' },
    });
    try {
      const response = await fetch(`${base}/api/kernel/write?issuer=${encodeURIComponent(ISSUER)}`, {
        method: 'POST', headers: { 'x-user-issuer': ISSUER, 'x-principal-issuer': ISSUER },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('reached');
      expect(resolve).not.toHaveBeenCalled();
    } finally { await stop(server); }
  });

  it('refuses a fleet service-secret caller that carries a user subject but no verified issuer', async () => {
    process.env.SWARM_SERVICE_SECRET = 'example-gate-fixture-secret';
    const declaration = { ...ACCESS, supported: [...ACCESS.supported] };
    const ownerOf = vi.fn().mockReturnValue({ appName: 'kernel-app', status: 'active', access: declaration });
    const resolve = vi.fn().mockResolvedValue({ appName: 'kernel-app', userSub: 'carried-sub', tier: 'admin', bundle: null, source: 'explicit' });
    let carried: string | null = null;
    const app = express();
    // The production stamp for a fleet-secret call (server.ts identity middleware): no subject,
    // operator-level system traffic. The subject travels only in the trusted-service header.
    app.use((_req, _res, next) => runWithRequestIdentity({ sub: null, isOperator: true }, () => next()));
    app.use((req, _res, next) => { carried = appAccessCallerSub(req); next(); });
    app.use(createSwarmAppGateMiddleware(
      { ownerOf } as unknown as SwarmAppService,
      { resolveForPrincipal: resolve } as unknown as AppAccessResolver,
    ));
    app.all('/api/kernel/*rest', (_req, res) => res.json({ reached: true }));
    const server = createServer(app);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/api/kernel/write`, { method: 'POST', headers: {
        'x-service-secret': 'example-gate-fixture-secret',
        'x-oshal-user-sub-b64': Buffer.from('carried-sub', 'utf8').toString('base64url'),
      } });
      expect(carried, 'the carried subject IS resolved; it is the verified issuer that is missing').toBe('carried-sub');
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'app_access_identity_required' });
      expect(resolve, 'no tier is guessed as local-auth or read across every issuer').not.toHaveBeenCalled();
    } finally { await stop(server); delete process.env.SWARM_SERVICE_SECRET; }
  });

  it('does not reuse another issuer\'s admin tier for the same subject', async () => {
    const legacyResolve = vi.fn(async (appName: string, userSub: string) => ({
      appName, userSub, tier: 'admin' as const, bundle: null, source: 'explicit' as const,
    }));
    const resolveForPrincipal = vi.fn(async (appName: string, userSub: string, issuer: string) => ({
      appName, userSub, tier: issuer === ISSUER ? 'admin' as const : 'deny' as const,
      bundle: null, source: 'explicit' as const,
    }));
    const resolver = { resolve: legacyResolve, resolveForPrincipal };
    for (const [issuer, expectedStatus] of [[ISSUER, 200], ['https://other.example.test', 403]] as const) {
      const { server, base } = await boot({
        owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
        subject: 'same-sub', issuer, resolver,
      });
      try {
        expect((await fetch(`${base}/api/kernel/write`, { method: 'POST' })).status).toBe(expectedStatus);
      } finally { await stop(server); }
    }
    expect(legacyResolve).not.toHaveBeenCalled();
    expect(resolveForPrincipal.mock.calls.map((call) => call[2])).toEqual([ISSUER, 'https://other.example.test']);
  });

  it('blocks a signed-in explicitly denied user on the hard-mounted route', async () => {
    const { server, base } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
      decision: { appName: 'kernel-app', userSub: 'user-a', tier: 'deny', bundle: null, source: 'explicit' },
    });
    try {
      const response = await fetch(`${base}/api/kernel/read`);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: 'app_access_denied', app: 'kernel-app' });
    } finally { await stop(server); }
  });

  it('applies viewer method lockdown before the hard-mounted handler', async () => {
    const { server, base } = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
      decision: { appName: 'kernel-app', userSub: 'user-a', tier: 'viewer', bundle: null, source: 'explicit' },
    });
    try {
      expect((await fetch(`${base}/api/kernel/read`)).status).toBe(200);
      const write = await fetch(`${base}/api/kernel/write`, { method: 'POST' });
      expect(write.status).toBe(403);
      await expect(write.json()).resolves.toMatchObject({ error: 'app_readonly' });
    } finally { await stop(server); }
  });

  it('keeps legacy manifests and truly anonymous callers under their existing policies', async () => {
    const legacy = await boot({ owner: { appName: 'kernel-app', status: 'active' }, subject: 'user-a' });
    try {
      expect((await fetch(`${legacy.base}/api/kernel/write`, { method: 'POST' })).status).toBe(200);
      expect(legacy.resolve).not.toHaveBeenCalled();
    } finally { await stop(legacy.server); }

    const anonymous = await boot({
      owner: { appName: 'kernel-app', status: 'active', access: { ...ACCESS, supported: [...ACCESS.supported] } },
    });
    try {
      expect((await fetch(`${anonymous.base}/api/kernel/write`, { method: 'POST' })).status).toBe(200);
      expect(anonymous.resolve).not.toHaveBeenCalled();
    } finally { await stop(anonymous.server); }
  });

  it('keeps inactive-app 503 precedence and never resolves an assignment', async () => {
    const { server, base, resolve } = await boot({
      owner: { appName: 'kernel-app', status: 'inactive', access: { ...ACCESS, supported: [...ACCESS.supported] } },
      subject: 'user-a',
    });
    try {
      expect((await fetch(`${base}/api/kernel/read`)).status).toBe(503);
      expect(resolve).not.toHaveBeenCalled();
    } finally { await stop(server); }
  });
});
