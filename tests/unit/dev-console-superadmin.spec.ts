/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security tests for the ADR-077 super-admin double-gate on the Developer Console.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact, case-sensitive super-admin subject matching at both request and queue-side gates; email matching remains case-insensitive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDevConsoleRoutes, shouldAuditDeny } from '@/app/routes/dev-console-routes';
import { isSuperAdminSub } from '@/shared/middleware/superadmin';

const ENV_KEYS = [
  'OSHAL_DEV_CONSOLE_ENABLED',
  'OSHAL_SUPERADMIN_SUBS',
  'OSHAL_SUPERADMIN_EMAILS',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_OPERATOR_EMAILS',
];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

/** Minimal AppContext double: a no-op pool (audit is fire-and-forget) + empty task store. */
function fakeCtx(): any {
  return {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    taskStore: { list: async () => [] },
  };
}

/** Build an app whose fake OIDC session is `user` (null = unauthenticated). */
function appFor(user: Record<string, string> | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/dev-console', createDevConsoleRoutes(fakeCtx()));
  return app;
}

async function hit(app: express.Express, path: string): Promise<{ status: number; body: any; raw: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const raw = await res.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    return { status: res.status, body, raw };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const ADMIN = { sub: 'super-sub-1', email: 'boss@example.test' };

describe('Developer Console super-admin double-gate (ADR-077)', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('DENIES a privileged route when the capability flag is unset, even for an allowlisted caller', async () => {
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub; // on allowlist…
    // …but OSHAL_DEV_CONSOLE_ENABLED is unset → capability does not exist.
    const res = await hit(appFor(ADMIN), '/api/dev-console/status');
    expect(res.status).toBe(403);
    expect(res.body.reason).toMatch(/disabled/i);
  });

  it('DENIES when enabled but the caller is not on the super-admin allowlist', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = 'someone-else';
    const res = await hit(appFor(ADMIN), '/api/dev-console/status');
    expect(res.status).toBe(403);
    expect(res.body.reason).toMatch(/allowlist/i);
  });

  it('ALLOWS a privileged route only when enabled AND the caller is allowlisted (by sub)', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    const res = await hit(appFor(ADMIN), '/api/dev-console/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.capabilities.diagnostics).toBe(true);
    expect(res.body.capabilities.recover).toBe(false);
    // `edit` reflects whether the self-edit runtime (repo + docker) is reachable on this node.
    expect(typeof res.body.capabilities.edit).toBe('boolean');
  });

  it('DENIES case and whitespace variants of an allowlisted subject', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    expect((await hit(appFor({ ...ADMIN, sub: 'Super-Sub-1' }), '/api/dev-console/status')).status).toBe(403);
    expect((await hit(appFor({ ...ADMIN, sub: ` ${ADMIN.sub}` }), '/api/dev-console/status')).status).toBe(403);
    expect((await hit(appFor({ ...ADMIN, sub: `${ADMIN.sub} ` }), '/api/dev-console/status')).status).toBe(403);
  });

  it('matches queue-side super-admin subjects exactly too', () => {
    process.env.OSHAL_SUPERADMIN_SUBS = ` ${ADMIN.sub} , another-sub `;
    expect(isSuperAdminSub(ADMIN.sub)).toBe(true);
    expect(isSuperAdminSub('Super-Sub-1')).toBe(false);
    expect(isSuperAdminSub(` ${ADMIN.sub}`)).toBe(false);
    expect(isSuperAdminSub(`${ADMIN.sub} `)).toBe(false);
  });

  it('matches the allowlist by email, case-insensitively', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_EMAILS = 'boss@example.test';
    const res = await hit(appFor({ sub: 'x', email: 'BOSS@EXAMPLE.TEST' }), '/api/dev-console/health-snapshot');
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(0);
  });

  it('is a SEPARATE role from operator — an operator is NOT a super-admin', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_OPERATOR_SUBS = ADMIN.sub; // operator…
    // …but not on OSHAL_SUPERADMIN_SUBS → still denied.
    const res = await hit(appFor(ADMIN), '/api/dev-console/status');
    expect(res.status).toBe(403);
  });

  it('never leaks the allowlist contents in a denial response', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = 'top-secret-owner-sub-9000';
    process.env.OSHAL_SUPERADMIN_EMAILS = 'owner-secret@example.test';
    const res = await hit(appFor({ sub: 'intruder', email: 'intruder@example.test' }), '/api/dev-console/status');
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain('top-secret-owner-sub-9000');
    expect(res.raw).not.toContain('owner-secret@example.test');
  });

  it('/access returns a BARE {superAdmin:false} to a non-admin — no checks, no config, no allowlist', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = 'top-secret-owner-sub-9000';
    const res = await hit(appFor({ sub: 'intruder', email: 'intruder@example.test' }), '/api/dev-console/access');
    expect(res.status).toBe(200); // reachable by any authed user (the router mounts only when enabled)…
    expect(res.body.superAdmin).toBe(false); // …but a non-admin gets nothing else
    expect(res.body.checks).toBeUndefined();
    expect(res.body.reason).toBeUndefined();
    expect(res.body.enabled).toBeUndefined();
    expect(res.raw).not.toContain('top-secret-owner-sub-9000');
    expect(res.raw).not.toContain('OSHAL_DEV_CONSOLE_ENABLED');
    expect(res.raw).not.toContain('capabilityEnabled');
  });

  it('/access returns the full trace ONLY to an enabled, allowlisted super-admin', async () => {
    process.env.OSHAL_DEV_CONSOLE_ENABLED = 'true';
    process.env.OSHAL_SUPERADMIN_SUBS = ADMIN.sub;
    const res = await hit(appFor(ADMIN), '/api/dev-console/access');
    expect(res.body.superAdmin).toBe(true);
    expect(res.body.enabled).toBe(true);
    expect(res.body.checks.onAllowlist).toBe(true);
  });
});

describe('deny-audit throttle — DoS write-amplification mitigation (ADR-077 red-team)', () => {
  it('audits a given caller at most once per 60s window', () => {
    const base = 1_700_000_000_000;
    expect(shouldAuditDeny('flood-sub', base)).toBe(true); // first denial is recorded
    expect(shouldAuditDeny('flood-sub', base + 500)).toBe(false); // flood within window is not
    expect(shouldAuditDeny('flood-sub', base + 30_000)).toBe(false);
    expect(shouldAuditDeny('flood-sub', base + 61_000)).toBe(true); // records again after the window
  });

  it('throttles each caller independently', () => {
    const base = 1_700_000_100_000;
    expect(shouldAuditDeny('caller-a', base)).toBe(true);
    expect(shouldAuditDeny('caller-b', base)).toBe(true);
    expect(shouldAuditDeny('caller-a', base + 1_000)).toBe(false);
  });
});
