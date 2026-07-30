/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the self-scoped /api/notify endpoints the new cockpit Notifications surface consumes, which had none (only the operator /operator + /alert rails were pinned): GET/POST /prefs and POST /test. Pins 401 before Postgres is touched, that the persisted/read sub comes ONLY from the session (a body-supplied userSub cannot redirect another user's notifications), that /test is confirm-gated (428) so a page load can never send, and that a non-delivered test answers 409 carrying the real reason — the surface reports that reason verbatim, so a 200-on-skip here would put a green tick on a send that never happened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createNotifyRoutes } from '@/app/routes/notify-routes';
import type { AppContext } from '@/app/composition/app-context';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const ME = { sub: 'notify-me-sub', email: 'me@example.test' };
const OTHER_SUB = 'notify-someone-else-sub';

interface QueryCall { sql: string; params: unknown[] }

/**
 * A Postgres double that records every statement. The prefs read and the gmail-readiness probe
 * both go through it, so the recorded params are the proof of which sub the route scoped to.
 * `prefRows` seeds oshal_user_notification_prefs; `gmailScopes` seeds oshal_connections.
 */
function fakePool(opts: { prefRows?: Array<Record<string, unknown>>; gmailScopes?: string | null } = {}): {
  pool: AppContext['pool'];
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/oshal_connections/.test(sql)) {
      return { rows: opts.gmailScopes ? [{ scopes: opts.gmailScopes }] : [] };
    }
    if (/INSERT INTO|UPDATE /i.test(sql)) return { rows: [] };
    return { rows: opts.prefRows ?? [] };
  });
  return { pool: { query } as unknown as AppContext['pool'], calls };
}

/** requiresAuth stub mirroring OIDC: 401 when there is no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, pool: AppContext['pool']): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/notify', createNotifyRoutes({ pool } as AppContext, requiresAuthStub));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(app: express.Express, route: string, init?: RequestInit): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/notify${route}`, init);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('GET /api/notify/prefs — the topic list the Notifications surface renders', () => {
  it('rejects an unauthenticated caller with 401 before Postgres is touched', async () => {
    const { pool, calls } = fakePool();
    const res = await hit(appFor(null, pool), '/prefs');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("reads ONLY the caller's own prefs — every statement is parameterised with the session sub", async () => {
    const { pool, calls } = fakePool({ prefRows: [] });
    const res = await hit(appFor(ME, pool), '/prefs');
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.params).toContain(ME.sub);
      expect(call.params).not.toContain(OTHER_SUB);
    }
  });

  it('reports the resolved default channel and the channel list the surface must offer', async () => {
    const { pool } = fakePool({ gmailScopes: 'https://www.googleapis.com/auth/gmail.send' });
    const res = await hit(appFor(ME, pool), '/prefs');
    expect(res.status).toBe(200);
    expect(res.body?.defaultChannel).toBe('email');
    expect(res.body?.channels).toEqual(['email', 'sms', 'telegram', 'none']);
  });

  it("reports defaultChannel 'none' when the caller has no gmail.send connection (never a fake default)", async () => {
    const { pool } = fakePool({ gmailScopes: null });
    const res = await hit(appFor(ME, pool), '/prefs');
    expect(res.status).toBe(200);
    expect(res.body?.defaultChannel).toBe('none');
  });
});

describe('POST /api/notify/prefs — saving one topic card', () => {
  it('rejects an unauthenticated caller with 401 before Postgres is touched', async () => {
    const { pool, calls } = fakePool();
    const res = await hit(appFor(null, pool), '/prefs', postJson({ topic: 'career-digest', channel: 'email' }));
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('IGNORES a body-supplied userSub and persists under the session sub only', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/prefs', postJson({
      userSub: OTHER_SUB, // hostile: try to redirect someone else's notifications
      topic: 'career-digest', channel: 'email', enabled: true,
      quietHoursStart: null, quietHoursEnd: null,
    }));
    expect(res.status).toBe(200);
    expect((res.body?.pref as Record<string, unknown>)?.userSub).toBe(ME.sub);
  });

  it('lowercases the stored topic (a mixed-case topic would be a silent no-op pref)', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/prefs', postJson({ topic: 'Career-Digest', channel: 'email' }));
    expect(res.status).toBe(200);
    expect((res.body?.pref as Record<string, unknown>)?.topic).toBe('career-digest');
  });

  it('rejects an unknown channel with 400 rather than saving an undeliverable routing', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/prefs', postJson({ topic: 'x', channel: 'carrier-pigeon' }));
    expect(res.status).toBe(400);
  });

  it('rejects a half-specified quiet window with 400 (start without end never suppresses anything)', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/prefs', postJson({
      topic: 'x', channel: 'email', quietHoursStart: 22, quietHoursEnd: null,
    }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/notify/test — the confirm-gated real send', () => {
  beforeEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('rejects an unauthenticated caller with 401', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(null, pool), '/test', postJson({ confirm: true }));
    expect(res.status).toBe(401);
  });

  it('refuses to send without confirm:true (428) — a page load can never fire a notification', async () => {
    const { pool } = fakePool();
    const res = await hit(appFor(ME, pool), '/test', postJson({ topic: 'test' }));
    expect(res.status).toBe(428);
    expect(res.body?.error).toBe('confirm required');
  });

  it('answers 409 with the REAL reason when nothing was delivered (never a 200 on a skip)', async () => {
    // No saved pref + no gmail.send connection => the router resolves 'none' and skips. The
    // surface prints this reason verbatim, so the honest status code + reason are the contract.
    const { pool } = fakePool({ prefRows: [], gmailScopes: null });
    const res = await hit(appFor(ME, pool), '/test', postJson({ confirm: true, topic: 'test' }));
    expect(res.status).toBe(409);
    expect(res.body?.delivered).toBe(false);
    expect(typeof res.body?.reason).toBe('string');
    expect(String(res.body?.reason).length).toBeGreaterThan(0);
  });
});
