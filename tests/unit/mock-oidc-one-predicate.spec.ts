/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard: MOCK_OIDC is ONE predicate, not three readings. isMockOidcEnabled() accepts true|1|yes in any case, but server.ts tested MOCK_OIDC === 'true' at the /api/auth/user mode string and at the demo-auth route mount — so MOCK_OIDC=1 took the full auth bypass while reporting mode 'oidc' and never mounting the demo /logout. Part 1 runs the real application auth set, the real auth-state router and the real demo mount over a real HTTP listener and requires every value the helper accepts to produce an identical observation at all three call sites. Part 2 parses src/app/server.ts and requires that file to hold no MOCK_OIDC env read of its own and to reach both of its sites through the shared registrars — an AST walk, so a commented-out or renamed call cannot satisfy it.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplicationAuthMiddlewareSet } from '@/app/middleware/application-auth';
import { createAuthStateRoutes, mountDemoAuthRoutes } from '@/app/routes/auth-state-routes';
import { isMockOidcEnabled } from '@/shared/middleware/oidc';

const SERVER_FILE = resolve(__dirname, '../../src/app/server.ts');

// Everything that could steer the auth-set selection or the mock identity away from the value
// under test. Cleared per test and restored after, so the suite never inherits a box's .env.
const ENV_KEYS = [
  'MOCK_OIDC', 'MOCK_OIDC_ALLOW_HEADER', 'MOCK_OIDC_SUB', 'MOCK_OIDC_EMAIL', 'MOCK_OIDC_NAME',
  'LOCAL_AUTH', 'ENTRA_LOCAL_AUTH_HYBRID', 'ENTRA_LOCAL_IDENTITY_BRIDGE',
  'SESSION_SECRET', 'AUTH_SESSION_SECRET', 'KEYCLOAK_CLIENT_SECRET',
  'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_BASE_URLS',
  'GOOGLE_LOGIN', 'MICROSOFT_LOGIN', 'APP_URL', 'KEYCLOAK_URL', 'KEYCLOAK_EXTERNAL_URL',
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; } });
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** What the three MOCK_OIDC call sites are observably doing for one env value. */
type Observation = {
  helper: boolean;
  /** Call site 1 — the bypass: a requiresAuth-guarded route answers without any login. */
  guardedRoute: { status: number } | null;
  /** Call site 2 — the auth-state probe's mode string and the identity it reports. */
  authState: { authenticated: boolean; mode: string; sub: unknown };
  /** Call site 3 — the demo /login, /logout, /api/auth/user mount. */
  demo: { mounted: boolean; logoutStatus: number; logoutLocation: string | null };
};

/**
 * Mount the real pieces server.ts mounts, in server.ts's order — the application auth set
 * (which reaches isMockOidcEnabled through createOidcMiddleware), the auth-state probe, then
 * the demo mount — and drive them over a real HTTP listener. Nothing about the flag is doubled.
 *
 * `withAuthSet: false` is the off posture: with MOCK_OIDC off and no session secret,
 * createOidcMiddleware throws by design (tests/unit/mock-oidc-failclosed.spec.ts owns that leg),
 * so the auth set is left out entirely rather than faked.
 */
async function observe(value: string | undefined, options: { withAuthSet: boolean }): Promise<Observation> {
  if (value === undefined) delete process.env.MOCK_OIDC;
  else process.env.MOCK_OIDC = value;

  const app = express();
  if (options.withAuthSet) {
    // `{} as never` is the pool: in this posture (no LOCAL_AUTH, no Entra bridge) the set is the
    // OIDC/mock branch, which never touches Postgres.
    const set = createApplicationAuthMiddlewareSet({} as never, process.env);
    app.use(set.authMiddleware);
    app.get('/probe/guarded', set.requiresAuth, (_req, res) => { res.status(200).json({ ok: true }); });
  }
  app.use('/api/auth/user', createAuthStateRoutes());
  const mounted = mountDemoAuthRoutes(app);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done, fail) => { server.once('listening', () => done()); server.once('error', fail); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const guarded = options.withAuthSet ? await fetch(`${base}/probe/guarded`, { redirect: 'manual' }) : null;
    const state = await fetch(`${base}/api/auth/user`, { redirect: 'manual' });
    const stateBody = await state.json() as { authenticated: boolean; mode: string; user?: { sub?: unknown } | null };
    const logout = await fetch(`${base}/logout`, { redirect: 'manual' });
    return {
      helper: isMockOidcEnabled(),
      guardedRoute: guarded ? { status: guarded.status } : null,
      authState: { authenticated: stateBody.authenticated, mode: stateBody.mode, sub: stateBody.user?.sub ?? null },
      demo: { mounted, logoutStatus: logout.status, logoutLocation: logout.headers.get('location') },
    };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('MOCK_OIDC is one predicate across all three call sites', () => {
  it('the canonical MOCK_OIDC=true turns on the bypass, the demo mode string AND the demo routes', async () => {
    expect(await observe('true', { withAuthSet: true })).toEqual({
      helper: true,
      guardedRoute: { status: 200 },
      authState: { authenticated: true, mode: 'demo', sub: 'mock-user-001' },
      demo: { mounted: true, logoutStatus: 302, logoutLocation: '/' },
    });
  });

  it('every value the helper accepts behaves identically to MOCK_OIDC=true at all three sites', async () => {
    const canonical = await observe('true', { withAuthSet: true });
    for (const value of ['1', 'yes', 'TRUE', 'Yes', ' 1 ']) {
      // The failure this guard exists for: MOCK_OIDC=1 bypassed auth (guarded route 200) while
      // the probe reported mode 'oidc' and the demo routes were never mounted (logout 404).
      const observed = await observe(value, { withAuthSet: true });
      expect(observed, `MOCK_OIDC=${JSON.stringify(value)} must behave exactly like MOCK_OIDC=true`).toEqual(canonical);
    }
  });

  it('a value the helper refuses leaves the mode string and the demo mount closed with it', async () => {
    for (const value of [undefined, '', 'false', '0', 'no', 'banana', 'TRUE-ish']) {
      const observed = await observe(value, { withAuthSet: false });
      expect(observed, `MOCK_OIDC=${JSON.stringify(value)} must not open the demo surface`).toEqual({
        helper: false,
        guardedRoute: null,
        authState: { authenticated: false, mode: 'oidc', sub: null },
        demo: { mounted: false, logoutStatus: 404, logoutLocation: null },
      });
    }
  });
});

type ServerCallSites = {
  /** 1-based lines of every MOCK_OIDC env read in server.ts. */
  envReads: number[];
  /** Plain-identifier calls by callee name. */
  byName: Map<string, ts.CallExpression[]>;
  /** Every call whose first argument is the literal '/api/auth/user'. */
  authStateMounts: ts.CallExpression[];
  /** Start offset of each `app.use(<identifier>)` mount, by identifier name. */
  appUseIdentifiers: Map<string, number[]>;
};

/**
 * Parse server.ts and collect real call/read nodes — an AST walk, never a substring scan: a
 * commented-out call is not a call, and a renamed symbol is a different identifier.
 */
function readServerCallSites(): ServerCallSites {
  const sourceFile = ts.createSourceFile(SERVER_FILE, readFileSync(SERVER_FILE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const envReads: number[] = [];
  const authStateMounts: ts.CallExpression[] = [];
  const byName = new Map<string, ts.CallExpression[]>();
  const appUseIdentifiers = new Map<string, number[]>();

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'MOCK_OIDC') envReads.push(line(node));
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'MOCK_OIDC') envReads.push(line(node));
    if (ts.isBindingElement(node)) {
      const bound = node.propertyName ?? node.name;
      if (ts.isIdentifier(bound) && bound.text === 'MOCK_OIDC') envReads.push(line(node));
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        byName.set(node.expression.text, [...(byName.get(node.expression.text) ?? []), node]);
      }
      const [first] = node.arguments;
      if (ts.isPropertyAccessExpression(node.expression)) {
        if (first && ts.isStringLiteralLike(first) && first.text === '/api/auth/user') authStateMounts.push(node);
        if (node.expression.expression.getText(sourceFile) === 'app' && node.expression.name.text === 'use'
          && node.arguments.length === 1 && first && ts.isIdentifier(first)) {
          appUseIdentifiers.set(first.text, [...(appUseIdentifiers.get(first.text) ?? []), node.getStart(sourceFile)]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { envReads, byName, authStateMounts, appUseIdentifiers };
}

describe('server.ts owns no MOCK_OIDC reading of its own', () => {
  it('reaches both of its call sites through the shared registrars, in the order the HTTP guard mounts them', () => {
    const { envReads, byName, authStateMounts, appUseIdentifiers } = readServerCallSites();

    // The defect shape: a second (and third) spelling of the flag living in this file.
    expect(envReads, `server.ts must read MOCK_OIDC only through isMockOidcEnabled (lines: ${envReads.join(', ')})`).toEqual([]);
    // The demo router is mounted by the helper that owns the predicate, never directly.
    expect((byName.get('createDemoAuthRoutes') ?? []).length).toBe(0);

    const probe = byName.get('createAuthStateRoutes') ?? [];
    const demo = byName.get('mountDemoAuthRoutes') ?? [];
    expect(probe.length).toBe(1);
    expect(demo.length).toBe(1);
    expect(demo[0].arguments.length).toBe(1);
    const demoArgument = demo[0].arguments[0];
    expect(ts.isIdentifier(demoArgument) && demoArgument.text).toBe('app');

    // The path is registered EXACTLY ONCE, and by the shared router: a second inline handler
    // on it would shadow the probe and could carry its own spelling of the flag. The mount is
    // `app.use('/api/auth/user', createAuthStateRoutes())` with no guard argument — ungated, as
    // the HTTP guard above mounts it and as tests/helpers/unguarded-route-allowlist.ts reviews
    // it; a requiresAuth here would 302 the cockpit's profile widget instead of reporting it.
    expect(authStateMounts.length).toBe(1);
    const mountCall = authStateMounts[0];
    expect(probe[0].parent).toBe(mountCall);
    expect(ts.isPropertyAccessExpression(mountCall.expression)
      && mountCall.expression.expression.getText() === 'app'
      && mountCall.expression.name.text === 'use').toBe(true);
    expect(mountCall.arguments.length).toBe(2);

    // Order: the global auth middleware first (so req.oidc exists), then the probe, then the demo
    // mount — whose own /api/auth/user stays shadowed by the probe. Same order as the HTTP guard.
    const authMounts = appUseIdentifiers.get('authMiddleware') ?? [];
    expect(authMounts.length).toBe(1);
    expect(authMounts[0]).toBeLessThan(mountCall.getStart());
    expect(mountCall.getStart()).toBeLessThan(demo[0].getStart());
  });
});
