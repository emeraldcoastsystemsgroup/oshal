/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the ADR-040 DevOps/Vault console gate: ENUMERATES the live router (router.stack) so a newly added endpoint that forgets requireSuperAdmin fails automatically; pins the confirm:true (428) write guard on every mutating endpoint; and proves the owner-scoped trace path (devopsTraceHub + safeSummary) never carries secret values (KV secret data, broker-minted client tokens) even though the HTTP response legitimately does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { createDevopsRoutes } from '@/app/routes/devops-routes';
import { devopsTraceHub, type TraceFrame } from '@/features/devops-vault';

/**
 * The native fetch, captured BEFORE any test stubs the global: the redaction tests replace
 * globalThis.fetch (to fake Vault's HTTP surface) while this file's own HTTP client still
 * needs to reach the local express server under test.
 */
const realFetch = globalThis.fetch;

const ENV_KEYS = [
  'OSHAL_DEV_CONSOLE_ENABLED',
  'OSHAL_SUPERADMIN_SUBS',
  'OSHAL_SUPERADMIN_EMAILS',
  'OSHAL_OPERATOR_SUBS',
  'VAULT_TOKEN',
  'VAULT_ADDR',
];

/** The HTML surfaces directory the real server.ts hands to createDevopsRoutes. */
const API_DIR = path.resolve(process.cwd(), 'src', 'api');

/**
 * The ONLY endpoints documented as reachable without super-admin (devops-routes.ts header):
 * /console serves the self-gating HTML shell; /access reports the caller's own gate status.
 * EVERYTHING else — enumerated live from router.stack below — must 403 a plain authed user.
 */
const NON_PRIVILEGED = new Set(['/console', '/access']);

/** POST endpoints that are Vault READS (no confirm:true demanded; they 503 when unconfigured). */
const READ_POSTS = ['/kv/read', '/kv/list', '/lookup'];

/** POST endpoints that MUTATE Vault — each must enforce the confirm:true (428) write guard. */
const MUTATION_POSTS = ['/issue', '/kv/delete', '/kv/write', '/policy', '/revoke', '/setup-db'];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** Minimal AppContext double: audit writes are fire-and-forget against a no-op pool. */
function fakeCtx(): never {
  return {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  } as unknown as never;
}

/** Build an app whose fake OIDC session is `user` (null = unauthenticated). */
function appFor(user: Record<string, string> | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/devops', createDevopsRoutes(fakeCtx(), API_DIR));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null; raw: string }

async function hit(app: express.Express, method: string, route: string, body?: unknown): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/devops${route}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: method.toUpperCase() === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed, raw };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface EnumeratedRoute { path: string; methods: string[] }

/**
 * Enumerate every endpoint the REAL router registers, straight off router.stack — so an
 * endpoint added tomorrow is swept into the 403 assertion automatically instead of relying
 * on this spec being updated by hand.
 */
function enumerateRoutes(): EnumeratedRoute[] {
  const router = createDevopsRoutes(fakeCtx(), API_DIR) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  };
  const routes: EnumeratedRoute[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]);
    routes.push({ path: layer.route.path, methods });
  }
  return routes;
}

const ADMIN = { sub: 'vault-super-sub-1', email: 'vault-boss@example.test' };
const INTRUDER = { sub: 'vault-intruder-sub', email: 'vault-intruder@example.test' };

describe('DevOps/Vault console route gate (ADR-040)', () => {
  beforeEach(clearEnv);
  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
  });

  it('sanity: enumeration sees the full known surface (a broken walk cannot pass vacuously)', () => {
    const paths = enumerateRoutes().map((r) => r.path);
    for (const known of [
      '/console', '/access', '/trace/stream', '/status',
      ...READ_POSTS, ...MUTATION_POSTS,
    ]) {
      expect(paths, `router.stack no longer lists ${known} — did the stack shape change?`).toContain(known);
    }
    expect(paths.length).toBeGreaterThanOrEqual(13);
  });

  it('classifies every POST endpoint: a NEW POST route must be added to READ_POSTS or MUTATION_POSTS here', () => {
    const posts = enumerateRoutes().filter((r) => r.methods.includes('post')).map((r) => r.path).sort();
    // Forces a conscious decision for each new endpoint — and once classified as a mutation,
    // the 428 test below enforces its confirm:true guard.
    expect(posts).toEqual([...READ_POSTS, ...MUTATION_POSTS].sort());
  });

  it('EVERY endpoint except /console and /access returns 403 to an authed NON-superadmin', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = 'someone-else-entirely';
    const app = appFor(INTRUDER);
    for (const route of enumerateRoutes()) {
      for (const method of route.methods) {
        const res = await hit(app, method, route.path);
        if (NON_PRIVILEGED.has(route.path)) {
          expect(res.status, `${method.toUpperCase()} ${route.path} is documented non-privileged`).not.toBe(403);
        } else {
          expect(res.status, `${method.toUpperCase()} ${route.path} must be requireSuperAdmin-gated`).toBe(403);
          expect(res.body?.error).toBe('Super-admin privilege required');
        }
      }
    }
  });

  it('EVERY privileged endpoint also denies an UNAUTHENTICATED caller (fail-closed)', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    const app = appFor(null);
    for (const route of enumerateRoutes()) {
      if (NON_PRIVILEGED.has(route.path)) continue;
      for (const method of route.methods) {
        const res = await hit(app, method, route.path);
        expect(res.status, `${method.toUpperCase()} ${route.path} must deny anonymous callers`).toBe(403);
      }
    }
  });

  it('denies even an allowlisted superadmin while the console capability flag is unset (double gate)', async () => {
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub; // on allowlist, but OSHAL_DEV_CONSOLE_ENABLED unset
    const res = await hit(appFor(ADMIN), 'GET', '/status');
    expect(res.status).toBe(403);
  });

  it('an operator is NOT a superadmin — the Vault console stays closed to operators', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_OPERATOR_SUBS = INTRUDER.sub; // operator, but not on OSHAL_SUPERADMIN_SUBS
    const res = await hit(appFor(INTRUDER), 'POST', '/kv/read', { path: 'app/db' });
    expect(res.status).toBe(403);
  });

  it('a denial never leaks the allowlist, and /access self-gates to a bare superAdmin:false', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = 'top-secret-owner-sub-9000';
    const app = appFor(INTRUDER);
    const denied = await hit(app, 'POST', '/kv/read', { path: 'app/db' });
    expect(denied.status).toBe(403);
    expect(denied.raw).not.toContain('top-secret-owner-sub-9000');
    const access = await hit(app, 'GET', '/access');
    expect(access.status).toBe(200);
    expect(access.body?.superAdmin).toBe(false);
    expect(access.raw).not.toContain('top-secret-owner-sub-9000');
  });
});

describe('DevOps/Vault mutation write guard (confirm:true → 428)', () => {
  beforeEach(() => {
    clearEnv();
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    // VAULT_TOKEN deliberately UNSET: a 428 proves the confirm gate fires before Vault is
    // even consulted (a 503 here would mean config was checked first — wrong order).
  });
  afterEach(clearEnv);

  it('every mutating endpoint returns 428 confirmation_required to a superadmin without confirm:true', async () => {
    const app = appFor(ADMIN);
    for (const route of MUTATION_POSTS) {
      const res = await hit(app, 'POST', route, { path: 'app/db', data: { k: 'v' } });
      expect(res.status, `POST ${route} must demand confirm:true`).toBe(428);
      expect(res.body?.error).toBe('confirmation_required');
    }
  });

  it('confirm:false is NOT a confirmation', async () => {
    const res = await hit(appFor(ADMIN), 'POST', '/kv/write', { confirm: false, path: 'p', data: {} });
    expect(res.status).toBe(428);
  });

  it('read endpoints do not demand confirm — an unconfigured Vault yields a clean 503', async () => {
    const res = await hit(appFor(ADMIN), 'POST', '/kv/read', { path: 'app/db' });
    expect(res.status).toBe(503);
    expect(res.body?.error).toBe('vault_not_configured');
  });
});

describe('DevOps/Vault trace path never carries secret values (safeSummary + devopsTraceHub)', () => {
  beforeEach(() => {
    clearEnv();
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    process.env.VAULT_TOKEN = 'unit-test-vault-token';
    process.env.VAULT_ADDR = 'http://vault.unit.test:8200';
  });
  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
  });

  /** Collect the frames the acting superadmin's live trace stream would receive. */
  async function tracedRequest(route: string, body: unknown, vaultJson: unknown): Promise<{ res: HitResult; frames: TraceFrame[] }> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(vaultJson), { status: 200 })));
    const frames: TraceFrame[] = [];
    const unsubscribe = devopsTraceHub.subscribe(ADMIN.sub, (f) => frames.push(f));
    try {
      const res = await hit(appFor(ADMIN), 'POST', route, body);
      return { res, frames };
    } finally {
      unsubscribe();
    }
  }

  it('a KV secret read returns the secret to the superadmin but the trace frames never contain it', async () => {
    const SECRET = 'sv-kv-password-3f9a1c-SENTINEL';
    const { res, frames } = await tracedRequest('/kv/read', { path: 'app/db' }, {
      data: { data: { password: SECRET, apiKey: `${SECRET}-api` }, metadata: { version: 4 } },
    });
    expect(res.status).toBe(200);
    expect(res.raw).toContain(SECRET); // the console's legitimate job…
    expect(frames.length).toBeGreaterThan(0); // …while the trace observed the action…
    const traceText = JSON.stringify(frames);
    expect(traceText).toContain('vault.kv.read');
    expect(traceText).not.toContain(SECRET); // …without ever carrying the secret value.
  });

  it('a broker-minted client token reaches the response but NEVER the start/ok trace frames', async () => {
    const MINTED = 'hvs.unit-minted-client-token-SENTINEL';
    const { res, frames } = await tracedRequest('/issue', { confirm: true, policy: 'read-only' }, {
      auth: { client_token: MINTED, accessor: 'accessor-abc123', lease_duration: 900, policies: ['read-only'] },
    });
    expect(res.status).toBe(200);
    expect(res.body?.token).toBe(MINTED);
    const levels = frames.map((f) => f.level);
    expect(levels).toContain('start');
    expect(levels).toContain('ok');
    const traceText = JSON.stringify(frames);
    expect(traceText).toContain('vault.broker.issue');
    expect(traceText).toContain('accessor-abc123'); // safe metadata IS summarized…
    expect(traceText).not.toContain(MINTED); // …the credential itself never is.
  });
});
