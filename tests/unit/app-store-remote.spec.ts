/**
 * Guards for the app-store remote rail (ADR-085 D7): catalog parsing (fail-soft per row,
 * fail-closed per document), the honest private-store degrade, install-remote's fail-closed
 * shapes (nothing reaches the installer or the loader on a refused request), and the
 * OPERATOR gate on POST /install-remote — asserted on CALLS (installer/loadApp never
 * invoked for a denied caller), never on substrings.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D7 guards: catalog parse/degrade, catalog-pinned install fail-closed shapes, and the operator gate on install-remote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';

// Intercept the installer spawn — a unit guard must never sparse-clone a git repo. The mock
// records every invocation so the specs can assert the installer is NOT reached on refusals.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => cb(null, 'installed (mock)', ''),
  ),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: execFileMock as unknown as typeof actual.execFile };
});

import {
  marketplaceUrl,
  parseCatalog,
  fetchStoreCatalog,
  installRemoteApp,
  registerAppStoreRemoteRoutes,
} from '../../src/app/routes/app-store-remote';

/** Native fetch captured before any test stubs the global. */
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'store-rails-operator-sub', email: 'store-ops@example.test' };
const PLAIN = { sub: 'plain-user-sub', email: 'plain@example.test' };

/** A minimal but realistic marketplace.json body (the store's machine-derived shape). */
function marketplaceBody(): string {
  return JSON.stringify({
    version: 1,
    apps: [
      {
        name: 'hello-oshal', suite: 'ai-engineering', displayName: 'Hello OSHAL',
        description: 'The minimal working example.', version: '1.1.0', status: 'ready',
        source: { type: 'git-subdir', url: 'https://github.com/emeraldcoastsystemsgroup/oshal-applications', path: 'hello-oshal', ref: 'main' },
      },
      {
        name: 'little-monsters', suite: 'ai-home', displayName: 'Little Monsters',
        description: 'Study companion.', version: '1.0.7', status: 'packaging',
        source: { type: 'git-subdir', url: 'https://github.com/emeraldcoastsystemsgroup/oshal-applications', path: 'little-monsters', ref: 'main' },
      },
      { name: 'INVALID NAME WITH SPACES', displayName: 'Broken row' }, // fail-soft: skipped, never fatal
      { name: 'sourceless-app', suite: 'ai-creative', displayName: 'No Source', description: 'x', version: '1.0.0', status: 'ready' },
    ],
  });
}

/** Stub global.fetch to answer the marketplace URL with the given status/body. */
function stubCatalogFetch(status: number, body: string): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

/** Prime the module's catalog cache from the current fetch stub (refresh bypasses TTL). */
async function primeCatalog(): Promise<void> {
  await fetchStoreCatalog(true);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  execFileMock.mockClear();
  delete process.env.OSHAL_STORE_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.OSHAL_OPERATOR_EMAILS;
});

describe('marketplaceUrl — the catalog lives beside the packages', () => {
  it('resolves the default store repo to its raw marketplace.json', () => {
    expect(marketplaceUrl('https://github.com/org/store', 'main'))
      .toBe('https://raw.githubusercontent.com/org/store/main/marketplace.json');
  });

  it('tolerates .git and a trailing slash, and returns null for non-GitHub repos', () => {
    expect(marketplaceUrl('https://github.com/org/store.git/', 'main'))
      .toBe('https://raw.githubusercontent.com/org/store/main/marketplace.json');
    expect(marketplaceUrl('https://gitlab.com/org/store', 'main')).toBeNull();
  });
});

describe('parseCatalog — fail-soft per row, fail-closed per document', () => {
  it('parses valid rows and silently skips a malformed one (one bad store row must not hide the rest)', () => {
    const apps = parseCatalog(marketplaceBody());
    expect(apps.map((a) => a.name)).toEqual(['hello-oshal', 'little-monsters', 'sourceless-app']);
    expect(apps[0]).toMatchObject({ suite: 'ai-engineering', version: '1.1.0', status: 'ready' });
    expect(apps[0].source).toMatchObject({ path: 'hello-oshal', ref: 'main' });
    expect(apps[2].source).toBeNull();
  });

  it('throws on a document with no apps[] (a broken store is not a partial one)', () => {
    expect(() => parseCatalog('{"nope": true}')).toThrow(/no apps\[\] array/);
    expect(() => parseCatalog('not json at all')).toThrow();
  });
});

describe('fetchStoreCatalog — the honest degrade', () => {
  it('reports available:false with a set-OSHAL_STORE_TOKEN hint on an anonymous 404 (private store)', async () => {
    stubCatalogFetch(404, '');
    const cat = await fetchStoreCatalog(true);
    expect(cat.available).toBe(false);
    expect(cat.apps).toEqual([]);
    expect(cat.reason).toMatch(/OSHAL_STORE_TOKEN/);
  });

  it('does not blame a missing token when a token IS configured', async () => {
    process.env.OSHAL_STORE_TOKEN = 'tok-store-rails-test';
    stubCatalogFetch(403, '');
    const cat = await fetchStoreCatalog(true);
    expect(cat.available).toBe(false);
    expect(cat.reason).not.toMatch(/set OSHAL_STORE_TOKEN/);
  });

  it('serves the parsed catalog on success', async () => {
    stubCatalogFetch(200, marketplaceBody());
    const cat = await fetchStoreCatalog(true);
    expect(cat.available).toBe(true);
    expect(cat.apps.map((a) => a.name)).toContain('hello-oshal');
  });
});

describe('installRemoteApp — catalog-pinned, fail-closed at every step', () => {
  const loadApp = vi.fn(async () => ({}));

  beforeEach(() => {
    loadApp.mockClear();
  });

  it('400s a malformed name before any network or installer work', async () => {
    const fetchStub = stubCatalogFetch(200, marketplaceBody());
    const r = await installRemoteApp('../../etc/passwd', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(loadApp).not.toHaveBeenCalled();
  });

  it('404s a name the catalog does not publish (no arbitrary-package fetch surface)', async () => {
    stubCatalogFetch(200, marketplaceBody());
    await primeCatalog();
    const r = await installRemoteApp('not-in-the-store', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('409s an entry the store has not marked ready', async () => {
    stubCatalogFetch(200, marketplaceBody());
    await primeCatalog();
    const r = await installRemoteApp('little-monsters', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toMatch(/packaging/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('409s an entry with no resolvable GitHub source', async () => {
    stubCatalogFetch(200, marketplaceBody());
    await primeCatalog();
    const r = await installRemoteApp('sourceless-app', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('503s when the catalog is unavailable — never a blind install', async () => {
    stubCatalogFetch(404, '');
    await primeCatalog();
    const r = await installRemoteApp('hello-oshal', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('runs the installer with the CATALOG entry source (never caller input) then hot-loads with the owner', async () => {
    stubCatalogFetch(200, marketplaceBody());
    await primeCatalog();
    const r = await installRemoteApp('hello-oshal', OPERATOR.sub, { loadApp });
    expect(r).toMatchObject({ ok: true, name: 'hello-oshal' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('install');
    expect(args).toContain('hello-oshal');
    expect(args[args.indexOf('--repo') + 1]).toBe('https://github.com/emeraldcoastsystemsgroup/oshal-applications');
    expect(args[args.indexOf('--ref') + 1]).toBe('main');
    expect(loadApp).toHaveBeenCalledTimes(1);
    expect(loadApp.mock.calls[0][0]).toMatch(/hello-oshal[\\/]oshal-app\.yaml$/);
    expect(loadApp.mock.calls[0][1]).toMatchObject({ ownerSub: OPERATOR.sub });
  });
});

// ── Route-level: the operator gate on POST /install-remote ────────────────────

function appFor(user: Record<string, string> | null, loadApp: (p: string) => Promise<unknown>): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  const router = Router();
  registerAppStoreRemoteRoutes(router, { loadApp });
  app.use('/api/swarm/apps', router);
  return app;
}

async function post(app: express.Express, route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/swarm/apps${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /install-remote — installing code is an operator action, fail-closed', () => {
  it('403s an authenticated NON-operator and never touches the catalog, installer, or loader', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const fetchStub = stubCatalogFetch(200, marketplaceBody());
    const loadApp = vi.fn(async () => ({}));
    const res = await post(appFor(PLAIN, loadApp), '/install-remote', { name: 'hello-oshal' });
    expect(res.status).toBe(403);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(loadApp).not.toHaveBeenCalled();
  });

  it('403s everyone when the operator allowlist is EMPTY (nobody is an operator by default)', async () => {
    const loadApp = vi.fn(async () => ({}));
    const res = await post(appFor(OPERATOR, loadApp), '/install-remote', { name: 'hello-oshal' });
    expect(res.status).toBe(403);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('lets an allowlisted operator through to the fail-closed pipeline (400 on a bad name proves the gate passed)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    stubCatalogFetch(200, marketplaceBody());
    const loadApp = vi.fn(async () => ({}));
    const res = await post(appFor(OPERATOR, loadApp), '/install-remote', { name: 'Bad Name!' });
    expect(res.status).toBe(400);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
