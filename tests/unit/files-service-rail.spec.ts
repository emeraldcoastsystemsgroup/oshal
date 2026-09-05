/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 doc-hub redeem guard (the fix's boundary, crossed for real): the /api/files mount composition — serviceSecretOr(requiresAuth) + createFilesRoutes — must accept the internal service rail (x-service-secret + x-oshal-user-sub) and resolve the trusted sub, because the artifact-handle relay redeems a files-browser source by re-fetching /download AS the minting caller over exactly that rail. Before the fix the mount was session-only and callerSub ignored the trusted header, so every doc-hub "Send to…" dispatch died as a 502 — this spec goes red if either half regresses. A wrong secret must still 401.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { serviceSecretOr } from '@/shared/middleware/authz';
import { createFilesRoutes } from '@/app/routes/files-routes';
import type { AppContext } from '@/app/composition/app-context';

const SECRET = 'files-rail-spec-secret';
const SUB = 'auth0|files-rail-user';

/** The session fallback: always 401 — exactly what an internal loopback fetch gets from OIDC. */
function sessionOnly401(_req: Request, res: Response, _next: NextFunction): void {
  res.status(401).json({ authenticated: false, error: 'unauthorized' });
}

let server: Server;
let base = '';
let prevSecret: string | undefined;

beforeAll(async () => {
  prevSecret = process.env.SWARM_SERVICE_SECRET;
  process.env.SWARM_SERVICE_SECRET = SECRET;
  const app = express();
  const ctx = { pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } } as unknown as AppContext;
  app.use('/api/files', serviceSecretOr(sessionOnly401), createFilesRoutes(ctx, process.cwd()));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = prevSecret;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/api/files over the internal service rail (ADR-139 doc-hub redeem)', () => {
  it('accepts the service secret + trusted sub and resolves the caller (roots include oshal-local)', async () => {
    const r = await fetch(`${base}/api/files/roots`, {
      headers: { 'x-service-secret': SECRET, 'x-oshal-user-sub': SUB },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { roots: Array<{ provider: string }> };
    expect(j.roots.some((root) => root.provider === 'oshal-local')).toBe(true);
  });

  it('still 401s without the rail (session fallback) and with a wrong secret', async () => {
    const bare = await fetch(`${base}/api/files/roots`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${base}/api/files/roots`, {
      headers: { 'x-service-secret': 'not-the-secret', 'x-oshal-user-sub': SUB },
    });
    expect(wrong.status).toBe(401);
  });

  it('the rail without a sub is authenticated but sub-less — files routes refuse it', async () => {
    const r = await fetch(`${base}/api/files/roots`, { headers: { 'x-service-secret': SECRET } });
    expect(r.status).toBe(401);
  });
});
