/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P1 verification: exercise ManifestRouteMounterImpl end-to-end over a real express server — a package route file is required, mounted, dispatched (with path-stripping + per-route auth), unmounted, and a no-op when the flag is off.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Regression tests for dispatch chaining: several modules on ONE mountPath must all be reachable (the little-monsters shape — only the first was dispatched before), and a more-specific mount must win over a shorter one still falling through.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | D10 regression test: every package factory receives ITS OWN ctx.appPackageDir, and a factory-time capture stays correct at request time after other packages mount — the process-global env var pointed every request-time reader at whichever package mounted last.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Close the D2 mode-matrix gap: `auth: operator` shipped in buildGuards but this suite never exercised it. New cases prove the [requiresAuth, requiresOperator] chain end-to-end — authenticated non-operator session → 403, session sub on OSHAL_OPERATOR_SUBS → 200, EMPTY allowlist fail-closed → 403 even for a session, and unauthenticated → 401 from the OIDC wall BEFORE the operator gate (never a bare 403).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove package @/ alias resolution through the real tsconfig-paths hook and Node createRequire against an external temporary package; no resolver mock can mask the production seam.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2 route-boundary matrix: deny blocks every method, viewer blocks writes, editor/admin defer to package code, missing declarations preserve legacy behavior, shadow observes, resolver failure closes, and delegated request identity is evaluated.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express, { type Express, type RequestHandler } from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';
import {
  ManifestRouteMounterImpl,
  registerPackageFrameworkAliases,
} from '../../src/app/composition/manifest-route-mounter';
import type {
  AppAccessResolver,
  ResolvedAppAccess,
  SwarmAppAccessDeclaration,
  SwarmAppRouteDeclaration,
} from '../../src/features/swarm-apps';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';

// A minimal AppContext stand-in — the mounter only passes it through to the route factory.
const FAKE_CTX = { marker: 'ctx-was-passed' } as unknown as import('../../src/app/composition/app-context').AppContext;

// A package route module authored as a bot would ship it: a factory that receives the app
// context and returns a bare middleware (no framework imports, so no node_modules needed at
// this temp path). It reports back whether it received the ctx, proving the wiring.
const PACKAGE_ROUTE_JS = `
exports.createTestRoutes = function (ctx) {
  return function (req, res, next) {
    if (req.url === '/ping' || req.url.indexOf('/ping') === 0) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, from: 'package', ctxMarker: ctx && ctx.marker, url: req.url }));
      return;
    }
    next();
  };
};
`;

let pkgDir: string;
const ROUTES: SwarmAppRouteDeclaration[] = [
  { module: 'route.js', factory: 'createTestRoutes', mountPath: '/api/pkgtest', requiresAuth: false },
];

/** Build a real express app + mounter with the flag/auth we want, listen on an ephemeral port. */
async function bootApp(opts: {
  flag: boolean;
  requiresAuth?: RequestHandler;
  appAccess?: AppAccessResolver;
  callerSub?: string;
}): Promise<{
  app: Express; server: Server; base: string; mounter: ManifestRouteMounterImpl;
}> {
  if (opts.flag) process.env.APP_PACKAGE_DYNAMIC_ROUTES = '1';
  else delete process.env.APP_PACKAGE_DYNAMIC_ROUTES;

  const app = express();
  if (opts.callerSub) {
    app.use((_req, _res, next) => runWithRequestIdentity(
      { sub: opts.callerSub!, isOperator: false },
      () => next(),
    ));
  }
  const requiresAuth: RequestHandler = opts.requiresAuth ?? ((_req, _res, next) => next());
  const mounter = new ManifestRouteMounterImpl(app, requiresAuth, FAKE_CTX, opts.appAccess);
  app.use((_req, res) => res.status(404).json({ notFound: true })); // terminal 404 after the dispatcher

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { app, server, base: `http://127.0.0.1:${port}`, mounter };
}

beforeAll(() => {
  pkgDir = mkdtempSync(join(tmpdir(), 'oshal-pkg-'));
  writeFileSync(join(pkgDir, 'route.js'), PACKAGE_ROUTE_JS, 'utf8');
});

afterAll(() => {
  rmSync(pkgDir, { recursive: true, force: true });
  delete process.env.APP_PACKAGE_DYNAMIC_ROUTES;
  delete process.env.OSHAL_APP_ACCESS_MODE;
});

const ALL_ACCESS: SwarmAppAccessDeclaration = {
  supported: ['deny', 'viewer', 'editor', 'admin'],
  defaultTier: 'viewer',
  mappings: { editor: 'internal_editor_bundle', admin: 'internal_admin_bundle' },
};

/** Build a deterministic route resolver decision for the requested tier. */
function accessResolver(
  tier: ResolvedAppAccess['tier'],
  observe?: (userSub: string | null) => void,
): AppAccessResolver {
  return {
    async resolve(appName, userSub, declaration) {
      observe?.(userSub);
      return {
        appName,
        userSub,
        tier,
        bundle: declaration.mappings?.[tier] ?? null,
        source: 'explicit',
      };
    },
  };
}

describe('ManifestRouteMounterImpl (ADR-085 P1)', () => {
  it('resolves a framework @/ import from an external package through the real Node seam', () => {
    const frameworkRoot = mkdtempSync(join(tmpdir(), 'oshal-framework-alias-'));
    const externalPackage = mkdtempSync(join(tmpdir(), 'oshal-external-package-'));
    const sharedDir = join(frameworkRoot, 'shared');
    const frameworkModule = join(sharedDir, 'boundary-probe.js');
    const packageModule = join(externalPackage, 'route.js');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(frameworkModule, "module.exports = { marker: 'real-framework-module' };\n", 'utf8');
    writeFileSync(
      packageModule,
      "module.exports = require('@/shared/boundary-probe');\n",
      'utf8',
    );

    const unregister = registerPackageFrameworkAliases(frameworkRoot);
    try {
      const requireFromPackage = createRequire(packageModule);
      expect(requireFromPackage(packageModule)).toEqual({ marker: 'real-framework-module' });
    } finally {
      unregister();
      rmSync(frameworkRoot, { recursive: true, force: true });
      rmSync(externalPackage, { recursive: true, force: true });
    }
  });

  it('mounts a package route and serves it (path-stripped, ctx passed)', async () => {
    const { server, base, mounter } = await bootApp({ flag: true });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES);
      const res = await fetch(`${base}/api/pkgtest/ping`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, from: 'package', ctxMarker: 'ctx-was-passed', url: '/ping' });
    } finally {
      server.close();
    }
  });

  it('unmount removes the route (falls through to 404)', async () => {
    const { server, base, mounter } = await bootApp({ flag: true });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES);
      expect((await fetch(`${base}/api/pkgtest/ping`)).status).toBe(200);
      mounter.unmount('pkgtest');
      expect((await fetch(`${base}/api/pkgtest/ping`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('applies per-route auth before the package handler', async () => {
    const blockingAuth: RequestHandler = (_req, res) => res.status(401).json({ denied: true });
    const { server, base, mounter } = await bootApp({ flag: true, requiresAuth: blockingAuth });
    try {
      await mounter.mount('pkgtest', pkgDir, [{ ...ROUTES[0], requiresAuth: true }]);
      const res = await fetch(`${base}/api/pkgtest/ping`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('is a no-op when the flag is off (mount does nothing, route not served)', async () => {
    const { server, base, mounter } = await bootApp({ flag: false });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES);
      const res = await fetch(`${base}/api/pkgtest/ping`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('chains several modules on ONE mountPath — endpoints in later modules stay reachable', async () => {
    // The little-monsters shape: 3 modules all declared at /api/education. Before the
    // chaining fix only the first module ever saw a request; /voice-only 404ed.
    const pingOnly = `
exports.createPingRoutes = function () {
  return function (req, res, next) {
    if (req.url === '/ping' || req.url.indexOf('/ping?') === 0) { res.end('ping-module'); return; }
    next();
  };
};
`;
    const voiceOnly = `
exports.createVoiceRoutes = function () {
  return function (req, res, next) {
    if (req.url === '/voice-only' || req.url.indexOf('/voice-only?') === 0) { res.end('voice-module'); return; }
    next();
  };
};
`;
    writeFileSync(join(pkgDir, 'ping-routes.js'), pingOnly, 'utf8');
    writeFileSync(join(pkgDir, 'voice-routes.js'), voiceOnly, 'utf8');
    const { server, base, mounter } = await bootApp({ flag: true });
    try {
      await mounter.mount('multimod', pkgDir, [
        { module: 'ping-routes.js', factory: 'createPingRoutes', mountPath: '/api/multimod', requiresAuth: false },
        { module: 'voice-routes.js', factory: 'createVoiceRoutes', mountPath: '/api/multimod', requiresAuth: false },
      ]);
      expect(await (await fetch(`${base}/api/multimod/ping`)).text()).toBe('ping-module');
      expect(await (await fetch(`${base}/api/multimod/voice-only`)).text()).toBe('voice-module');
      expect((await fetch(`${base}/api/multimod/nowhere`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('D10: each package factory gets ITS OWN ctx.appPackageDir, stable across later mounts', async () => {
    // The bundled-asset server pattern: capture the package dir at FACTORY time, serve it
    // at request time. Pre-fix, request-time reads of OSHAL_APP_PACKAGE_DIR returned the
    // LAST-mounted package's dir — app A served app B's assets after any reload.
    const assetServer = `
exports.createAssetRoutes = function (ctx) {
  var capturedDir = ctx.appPackageDir; // factory-time capture — the sanctioned pattern
  return function (req, res, next) {
    if (req.url === '/whoami' || req.url.indexOf('/whoami?') === 0) {
      res.end(JSON.stringify({ capturedDir: capturedDir, envDirNow: process.env.OSHAL_APP_PACKAGE_DIR }));
      return;
    }
    next();
  };
};
`;
    const pkgA = mkdtempSync(join(tmpdir(), 'oshal-pkgA-'));
    const pkgB = mkdtempSync(join(tmpdir(), 'oshal-pkgB-'));
    writeFileSync(join(pkgA, 'assets.js'), assetServer, 'utf8');
    writeFileSync(join(pkgB, 'assets.js'), assetServer, 'utf8');
    const { server, base, mounter } = await bootApp({ flag: true });
    try {
      await mounter.mount('app-a', pkgA, [
        { module: 'assets.js', factory: 'createAssetRoutes', mountPath: '/api/app-a', requiresAuth: false },
      ]);
      await mounter.mount('app-b', pkgB, [
        { module: 'assets.js', factory: 'createAssetRoutes', mountPath: '/api/app-b', requiresAuth: false },
      ]);
      const a = await (await fetch(`${base}/api/app-a/whoami`)).json();
      const b = await (await fetch(`${base}/api/app-b/whoami`)).json();
      // Factory-time capture is per-package and survives app-b mounting after app-a…
      expect(a.capturedDir).toBe(pkgA);
      expect(b.capturedDir).toBe(pkgB);
      // …while the env var demonstrates exactly why request-time reads were broken:
      // both apps observe the LAST-mounted package's dir at request time.
      expect(a.envDirNow).toBe(pkgB);
      expect(b.envDirNow).toBe(pkgB);
    } finally {
      server.close();
      rmSync(pkgA, { recursive: true, force: true });
      rmSync(pkgB, { recursive: true, force: true });
    }
  });

  it('runs the more-specific mount first, falling through to the shorter one', async () => {
    const broad = `
exports.createBroadRoutes = function () {
  return function (req, res, next) {
    if (req.url === '/sub/deep' || req.url === '/top') { res.end('broad:' + req.url); return; }
    next();
  };
};
`;
    const narrow = `
exports.createNarrowRoutes = function () {
  return function (req, res, next) {
    if (req.url === '/deep') { res.end('narrow:' + req.url); return; }
    next();
  };
};
`;
    writeFileSync(join(pkgDir, 'broad-routes.js'), broad, 'utf8');
    writeFileSync(join(pkgDir, 'narrow-routes.js'), narrow, 'utf8');
    const { server, base, mounter } = await bootApp({ flag: true });
    try {
      await mounter.mount('specificity', pkgDir, [
        { module: 'broad-routes.js', factory: 'createBroadRoutes', mountPath: '/api/spec', requiresAuth: false },
        { module: 'narrow-routes.js', factory: 'createNarrowRoutes', mountPath: '/api/spec/sub', requiresAuth: false },
      ]);
      // /api/spec/sub/deep matches both mounts — the narrow module must see it first...
      expect(await (await fetch(`${base}/api/spec/sub/deep`)).text()).toBe('narrow:/deep');
      // ...and a path only the broad module handles still falls through to it.
      expect(await (await fetch(`${base}/api/spec/top`)).text()).toBe('broad:/top');
    } finally {
      server.close();
    }
  });
});

// ── ADR-085 D2: auth modes, enforced end-to-end ─────────────────────────────
// Every case runs with a DENYING requiresAuth stub, so a 200 proves the mode genuinely bypassed
// OIDC and a 401 proves it genuinely fell back. Auth is opt-in per route in this codebase — an
// unwrapped Express route IS public — so these are the tests that keep a package route from
// silently becoming anonymous.
describe('manifest route auth modes (ADR-085 D2)', () => {
  const DENY: RequestHandler = (_req, res) => { res.status(401).json({ denied: true }); };
  const SECRET = 'test-service-secret-value';

  /** @description Mount one route under a given auth mode and call it. */
  async function call(
    auth: string | undefined,
    headers: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const { server, base, mounter } = await bootApp({ flag: true, requiresAuth: DENY });
    try {
      await mounter.mount('pkgtest', pkgDir, [
        { module: 'route.js', factory: 'createTestRoutes', mountPath: '/api/pkgtest', ...extra, ...(auth ? { auth } : {}) } as SwarmAppRouteDeclaration,
      ]);
      const res = await fetch(`${base}/api/pkgtest/ping`, { headers });
      return res.status;
    } finally {
      server.close();
    }
  }

  afterEach(() => { delete process.env.SWARM_SERVICE_SECRET; delete process.env.OSHAL_OPERATOR_SUBS; });

  // THE invariant. If this ever regresses, every carved app is anonymous by default.
  it('auth and requiresAuth BOTH omitted → auth-gated (401), never anonymous', async () => {
    expect(await call(undefined)).toBe(401);
  });

  it('auth: oidc → auth-gated (401)', async () => {
    expect(await call('oidc')).toBe(401);
  });

  it('auth: public → served anonymously (200)', async () => {
    expect(await call('public')).toBe(200);
  });

  it('auth: service-or-oidc + a valid secret → 200 (the bot-node / headless-CLI path)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect(await call('service-or-oidc', { 'x-service-secret': SECRET })).toBe(200);
  });

  it('auth: service-or-oidc with NO secret header → falls back to OIDC (401)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect(await call('service-or-oidc')).toBe(401);
  });

  it('auth: service-or-oidc with a WRONG secret → 401', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    // Same LENGTH as the real one, so this exercises the constant-time compare rather than
    // short-circuiting on the length pre-check in hasValidServiceSecret.
    const wrongSameLength = 'x'.repeat(SECRET.length);
    expect(await call('service-or-oidc', { 'x-service-secret': wrongSameLength })).toBe(401);
  });

  // Fail-safe: with no secret configured, the bypass simply does not exist.
  it('auth: service-or-oidc with SWARM_SERVICE_SECRET UNSET + a forged header → 401', async () => {
    expect(await call('service-or-oidc', { 'x-service-secret': 'forged' })).toBe(401);
  });

  it('auth: service + a valid secret → 200', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect(await call('service', { 'x-service-secret': SECRET })).toBe(200);
  });

  // The whole point of `service` being distinct from `service-or-oidc`: a browser session must NOT
  // reach a machine-to-machine ingest callback. There is no OIDC fallback.
  it('auth: service with NO secret → 401 even though OIDC would be available', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect(await call('service')).toBe(401);
  });

  it('auth: service with the secret UNSET → 401 (fail-closed, never fail-open)', async () => {
    expect(await call('service', { 'x-service-secret': 'anything' })).toBe(401);
  });

  // Defence in depth — readManifest throws on this, so it should be unreachable; if a manifest ever
  // arrives another way, an unknown mode must gate, not open.
  it('an UNKNOWN mode reaching the mounter still gates (401), never anonymous', async () => {
    expect(await call('service-or-odic')).toBe(401);
  });

  // Legacy manifests predate `auth:` entirely.
  it('legacy requiresAuth: false still means public (200)', async () => {
    expect(await call(undefined, {}, { requiresAuth: false })).toBe(200);
  });

  it('legacy requiresAuth: true still means auth-gated (401)', async () => {
    expect(await call(undefined, {}, { requiresAuth: true })).toBe(401);
  });

  // ── auth: operator — the one D2 mode the matrix above never exercised ──────
  // buildGuards returns [requiresAuth, requiresOperator] (manifest-route-mounter.ts): the
  // framework OIDC wall runs FIRST, then the REAL fail-closed operator allowlist from
  // shared/middleware/authz.ts (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS; an empty
  // allowlist means there are no operators — nobody passes).
  const OPERATOR_SUB = 'operator-sub-1';

  /** @description requiresAuth stub that admits the caller as an authenticated OIDC session for `sub`. */
  const sessionAs = (sub: string): RequestHandler => (req, _res, next) => {
    (req as typeof req & { oidc?: unknown }).oidc = { user: { sub }, isAuthenticated: () => true };
    next();
  };

  /** @description Mount one `auth: operator` route behind the given requiresAuth stub and call it. */
  async function callOperator(requiresAuth: RequestHandler): Promise<number> {
    const { server, base, mounter } = await bootApp({ flag: true, requiresAuth });
    try {
      await mounter.mount('pkgtest', pkgDir, [
        { module: 'route.js', factory: 'createTestRoutes', mountPath: '/api/pkgtest', auth: 'operator' } as SwarmAppRouteDeclaration,
      ]);
      return (await fetch(`${base}/api/pkgtest/ping`)).status;
    } finally {
      server.close();
    }
  }

  it('auth: operator + an authenticated NON-operator session → 403 (allowlist gate holds)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    expect(await callOperator(sessionAs('just-a-user'))).toBe(403);
  });

  it('auth: operator + a session sub on OSHAL_OPERATOR_SUBS → 200', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    expect(await callOperator(sessionAs(OPERATOR_SUB))).toBe(200);
  });

  // Fail-closed like every other posture here: with no allowlist configured the privilege
  // simply does not exist — an authenticated session must NOT slip through as an operator.
  it('auth: operator with NO allowlist configured → 403 even for an authenticated session', async () => {
    expect(await callOperator(sessionAs(OPERATOR_SUB))).toBe(403);
  });

  // Guard order matters: requiresAuth runs BEFORE requiresOperator (authz.ts documents the
  // ordering), so an anonymous caller gets the normal OIDC 401/redirect — never a bare 403
  // that would leak "this path exists and needs operator privilege" to the unauthenticated.
  it('auth: operator, unauthenticated → the OIDC wall answers first (401, not 403)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    expect(await callOperator(DENY)).toBe(401);
  });
});

describe('manifest app access boundary (ADR-118 Phase 2)', () => {
  async function callTier(
    tier: ResolvedAppAccess['tier'],
    method: string,
  ): Promise<{ status: number; body: any }> {
    const { server, base, mounter } = await bootApp({
      flag: true,
      callerSub: 'route-access-user',
      appAccess: accessResolver(tier),
    });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES, ALL_ACCESS);
      const res = await fetch(`${base}/api/pkgtest/ping`, { method });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } finally {
      server.close();
    }
  }

  afterEach(() => { delete process.env.OSHAL_APP_ACCESS_MODE; });

  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])('deny blocks %s before package code', async (method) => {
    const result = await callTier('deny', method);
    expect(result.status).toBe(403);
    if (method !== 'HEAD') {
      expect(result.body).toMatchObject({ error: 'app_access_denied', app: 'pkgtest', tier: 'deny' });
    }
  });

  it('viewer admits reads and rejects mutations with the stable app_readonly code', async () => {
    expect((await callTier('viewer', 'GET')).status).toBe(200);
    const write = await callTier('viewer', 'POST');
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ error: 'app_readonly', tier: 'viewer' });
  });

  it.each(['editor', 'admin'] as const)('%s defers mutations to package capabilities', async (tier) => {
    expect((await callTier(tier, 'POST')).status).toBe(200);
  });

  it('an omitted declaration preserves legacy behavior and never consults the resolver', async () => {
    const resolver: AppAccessResolver = { resolve: async () => { throw new Error('must not run'); } };
    const { server, base, mounter } = await bootApp({
      flag: true,
      callerSub: 'route-access-user',
      appAccess: resolver,
    });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES);
      expect((await fetch(`${base}/api/pkgtest/ping`, { method: 'POST' })).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('shadow mode records a would-deny decision without blocking the package', async () => {
    process.env.OSHAL_APP_ACCESS_MODE = 'shadow';
    const result = await callTier('deny', 'DELETE');
    expect(result.status).toBe(200);
  });

  it('a declared app fails closed when resolution is unavailable', async () => {
    const resolver: AppAccessResolver = { resolve: async () => { throw new Error('database unavailable'); } };
    const { server, base, mounter } = await bootApp({
      flag: true,
      callerSub: 'route-access-user',
      appAccess: resolver,
    });
    try {
      await mounter.mount('pkgtest', pkgDir, ROUTES, ALL_ACCESS);
      const res = await fetch(`${base}/api/pkgtest/ping`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'app_access_unavailable' });
    } finally {
      server.close();
    }
  });

  it('evaluates a durable delegated request under the exact AsyncLocalStorage subject', async () => {
    let observed: string | null = null;
    const delegatedAuth: RequestHandler = (_req, _res, next) => {
      runWithRequestIdentity(
        { sub: 'delegated-user-sub', principalIssuer: 'https://issuer.example', isOperator: false },
        () => next(),
      );
    };
    const { server, base, mounter } = await bootApp({
      flag: true,
      requiresAuth: delegatedAuth,
      appAccess: accessResolver('editor', (sub) => { observed = sub; }),
    });
    try {
      await mounter.mount('pkgtest', pkgDir, [{
        module: 'route.js',
        factory: 'createTestRoutes',
        mountPath: '/api/pkgtest',
        auth: 'oidc',
      }], ALL_ACCESS);
      expect((await fetch(`${base}/api/pkgtest/ping`, { method: 'POST' })).status).toBe(200);
      expect(observed).toBe('delegated-user-sub');
    } finally {
      server.close();
    }
  });
});
