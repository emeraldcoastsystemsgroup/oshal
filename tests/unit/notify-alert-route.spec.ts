/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the severity-routed operator alert: POST /api/notify/alert rejects unauthenticated (401) + non-operator (403) BEFORE any send, demands confirm:true (428), validates severity (400) and non-empty text (400), delivers (200) when notifyBySeverity reports a delivered leg, and FAILS LOUD (502) when every configured transport skipped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createNotifyRoutes } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';
import { notifyBySeverity } from '@/features/notifications';

// Keep every real export createNotifyRoutes builds at construction time; override only notifyBySeverity.
vi.mock('@/features/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/notifications')>();
  return {
    ...actual,
    notifyBySeverity: vi.fn(async () => [{ delivered: true, transport: 'telegram' as const }]),
  };
});

const notifyBySeverityMock = vi.mocked(notifyBySeverity);
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'alert-route-operator', email: 'ops@example.test' };
const PLAIN = { sub: 'alert-route-plain', email: 'plain@example.test' };

function fakeCtx(): AppContext {
  return { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;
}

function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/notify', createNotifyRoutes(fakeCtx(), requiresAuthStub));
  return app;
}

async function post(app: express.Express, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/notify/alert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /api/notify/alert — severity-routed operator alert', () => {
  beforeEach(() => {
    notifyBySeverityMock.mockReset();
    notifyBySeverityMock.mockResolvedValue([{ delivered: true, transport: 'telegram' }] as never);
    delete process.env.OSHAL_OPERATOR_SUBS;
  });
  afterEach(() => { delete process.env.OSHAL_OPERATOR_SUBS; });

  it('rejects an unauthenticated caller (401), nothing sent', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(null), { severity: 'error', text: 'hi', confirm: true });
    expect(res.status).toBe(401);
    expect(notifyBySeverityMock).not.toHaveBeenCalled();
  });

  it('denies an authenticated non-operator (403), nothing sent', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(PLAIN), { severity: 'error', text: 'hi', confirm: true });
    expect(res.status).toBe(403);
    expect(notifyBySeverityMock).not.toHaveBeenCalled();
  });

  it('demands confirm:true (428)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { severity: 'error', text: 'urgent' });
    expect(res.status).toBe(428);
    expect(notifyBySeverityMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid severity (400)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { severity: 'catastrophic', text: 'hi', confirm: true });
    expect(res.status).toBe(400);
    expect(notifyBySeverityMock).not.toHaveBeenCalled();
  });

  it('rejects empty text (400)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { severity: 'error', text: '   ', confirm: true });
    expect(res.status).toBe(400);
    expect(notifyBySeverityMock).not.toHaveBeenCalled();
  });

  it('delivers (200) when a transport reports delivered', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { severity: 'critical', text: 'DB down', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(notifyBySeverityMock).toHaveBeenCalledWith('critical', { text: 'DB down' }, expect.anything());
  });

  it('fails LOUD (502) when every transport skipped', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    notifyBySeverityMock.mockResolvedValueOnce([{ delivered: false, skipped: true, transport: 'noop', error: 'no_transport_for_severity' }] as never);
    const res = await post(appFor(OPERATOR), { severity: 'info', text: 'quiet', confirm: true });
    expect(res.status).toBe(502);
    expect(res.body?.ok).toBe(false);
  });
});
