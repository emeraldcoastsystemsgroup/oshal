/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ops-rails DLQ export surface: GET /api/queue/dlq/export must reject an unauthenticated caller (401) and an authed non-operator (403) BEFORE reading the DLQ, and hand an operator a downloadable JSON export (attachment Content-Disposition + export metadata + the dead-lettered envelopes) over the SAME DeadLetterService — no DB read past a denial.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { createQueueDlqRoutes } from '@/app/routes/queue-dlq-routes';
import type { TicketService } from '@/features/ticketing';

const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'ops-rails-dlq-operator', email: 'ops@example.test' };
const PLAIN = { sub: 'plain-dlq-user', email: 'plain@example.test' };

/** One raw oshal_queue_dlq (+ joined tickets) row, as LIST_SQL returns it. */
const DLQ_ROW = {
  ticket_id: '11111111-2222-3333-4444-555555555555',
  attempts: 3,
  last_error: 'boom',
  last_failure_at: '2026-07-19T00:00:00Z',
  quarantined_at: '2026-07-19T00:01:00Z',
  reason: 'max_dispatch_attempts_poison',
  requeued_by: null,
  requeued_at: null,
  title: 'stuck ticket',
  status: 'dead_letter',
  ticket_type: 'build',
};

/** Fake pool + a spy so denied requests can be proven never to read the DLQ. */
function fakePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [DLQ_ROW] }));
  return { pool: { query } as unknown as Pool, query };
}

const fakeTicketService = {} as unknown as TicketService;

/** requiresAuth stub mirroring OIDC: 401 with no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, pool: Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuthStub, { pool, ticketService: fakeTicketService }));
  return app;
}

interface HitResult { status: number; contentDisposition: string | null; body: Record<string, unknown> | null }

async function get(app: express.Express, route: string): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/queue/dlq${route}`);
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, contentDisposition: res.headers.get('content-disposition'), body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /api/queue/dlq/export — ops-rails operator DLQ export', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 before reading the DLQ', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, query } = fakePool();
    const res = await get(appFor(null, pool), '/export');
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('denies an authenticated NON-operator with 403 before reading the DLQ', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // PLAIN not on the allowlist
    const { pool, query } = fakePool();
    const res = await get(appFor(PLAIN, pool), '/export');
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('Operator privilege required');
    expect(query).not.toHaveBeenCalled();
  });

  it('hands an operator a downloadable JSON export of the dead-lettered envelopes', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, query } = fakePool();
    const res = await get(appFor(OPERATOR, pool), '/export');
    expect(res.status).toBe(200);
    expect(res.contentDisposition).toContain('attachment');
    expect(res.contentDisposition).toContain('.json');
    expect(query).toHaveBeenCalledTimes(1);
    expect(res.body?.kind).toBe('oshal-queue-dlq-export');
    expect(res.body?.count).toBe(1);
    const entries = res.body?.entries as Array<Record<string, unknown>>;
    expect(entries[0]?.ticketId).toBe(DLQ_ROW.ticket_id);
    expect(entries[0]?.reason).toBe('max_dispatch_attempts_poison');
    expect(res.body?.exportedBy).toBe(OPERATOR.email);
  });
});
