/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ops-rails notify surface: POST /api/notify/operator must reject an unauthenticated caller (401) and an authed non-operator (403) BEFORE any send, demand confirm:true (428) because it can page a human, refuse an empty text (400), deliver on the happy path (200), and FAIL LOUD (502) when the transport skips/does not deliver so a monitoring operator is never fooled by a silent no-op.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createNotifyRoutes } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';
import { notifyOperator } from '@/features/notifications';

// Keep every real export (NotificationRouter/TelegramTransport/etc. that createNotifyRoutes
// constructs at build time) and override ONLY the deployment operator-transport send.
vi.mock('@/features/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/notifications')>();
  return {
    ...actual,
    notifyOperator: vi.fn(async () => ({ delivered: true, transport: 'telegram' as const })),
  };
});

const notifyOperatorMock = vi.mocked(notifyOperator);
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'ops-rails-notify-operator', email: 'ops@example.test' };
const PLAIN = { sub: 'plain-notify-user', email: 'plain@example.test' };

/** Minimal AppContext double — buildNotificationRouter only reads ctx.pool at construction. */
function fakeCtx(): AppContext {
  return { pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext;
}

/** requiresAuth stub mirroring OIDC: 401 with no session, else pass through. */
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

interface HitResult { status: number; body: Record<string, unknown> | null }

async function post(app: express.Express, body: unknown): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/notify/operator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /api/notify/operator — ops-rails operator page-a-human rail', () => {
  beforeEach(() => {
    notifyOperatorMock.mockReset();
    notifyOperatorMock.mockResolvedValue({ delivered: true, transport: 'telegram' } as never);
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 (nothing sent)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(null), { text: 'hi', confirm: true });
    expect(res.status).toBe(401);
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('denies an authenticated NON-operator with 403 (nothing sent)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // PLAIN not on the allowlist
    const res = await post(appFor(PLAIN), { text: 'hi', confirm: true });
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('Operator privilege required');
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('demands confirm:true (428) before an operator can page a human', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { text: 'urgent' });
    expect(res.status).toBe(428);
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('refuses an empty text with 400 even when confirmed', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { text: '   ', confirm: true });
    expect(res.status).toBe(400);
    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });

  it('delivers on the happy path (200) and passes the bounded text to notifyOperator', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const res = await post(appFor(OPERATOR), { text: 'deploy finished', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(notifyOperatorMock).toHaveBeenCalledWith({ text: 'deploy finished' });
  });

  it('fails LOUD (502) when the transport skips/does not deliver', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    notifyOperatorMock.mockResolvedValueOnce({ delivered: false, skipped: true, transport: 'telegram', error: 'telegram_not_configured' } as never);
    const res = await post(appFor(OPERATOR), { text: 'page me', confirm: true });
    expect(res.status).toBe(502);
    expect(res.body?.ok).toBe(false);
  });
});
