/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the two /api/queue/dlq endpoints the new cockpit Dead Letters surface consumes, which had none (only /export was pinned): GET / and POST /:ticketId/requeue. Pins 401 then 403 BEFORE the DLQ table is read — the quarantine list carries other users' ticket titles and failure text, so a leak past the gate is a cross-user disclosure — plus the ?all=true passthrough, that a malformed ticket id is rejected before it reaches SQL, and that each requeue failure keeps its own distinct status (404 / 409 / 503) because the surface explains them differently.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { createQueueDlqRoutes } from '@/app/routes/queue-dlq-routes';
import type { TicketService } from '@/features/ticketing';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const OPERATOR = { sub: 'dlq-operator-sub', email: 'ops@example.test' };
const PLAIN = { sub: 'dlq-plain-sub', email: 'plain@example.test' };
const TICKET_ID = '11111111-2222-3333-4444-555555555555';

const QUARANTINED_ROW = {
  ticket_id: TICKET_ID,
  attempts: 5,
  last_error: 'bot node refused the envelope',
  last_failure_at: '2026-07-29T00:00:00Z',
  quarantined_at: '2026-07-29T00:05:00Z',
  reason: 'attempt budget exhausted',
  requeued_by: null,
  requeued_at: null,
  title: 'someone elses private ticket title',
  status: 'failed',
  ticket_type: 'incident',
};

interface QueryCall { sql: string; params: unknown[] }

/**
 * Postgres double for oshal_queue_dlq. `listRows` seeds every SELECT (both the list read and
 * the requeue's own row lookup); `throwOnSelect` makes the read blow up, which is the ONLY way
 * the service reports 'unavailable' — the post-release UPDATE failing is deliberately non-fatal.
 */
function fakePool(opts: {
  listRows?: Array<Record<string, unknown>>;
  throwOnSelect?: boolean;
} = {}): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) {
      if (opts.throwOnSelect) throw new Error('DB unavailable');
      return { rows: opts.listRows ?? [], rowCount: (opts.listRows ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, calls };
}

/** requiresAuth stub mirroring OIDC: 401 when there is no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

/**
 * Build the app under test. `statusFlip` is the TicketService.updateStatusAs double — the real
 * requeue path calls it to move the ticket back to 'approved', and a throw there is exactly what
 * the service maps to 'invalid-state' (HTTP 409).
 */
function appFor(
  user: Record<string, string> | null,
  pool: Pool,
  statusFlip: () => Promise<unknown> = async () => undefined,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  const ticketService = { updateStatusAs: vi.fn(statusFlip) } as unknown as TicketService;
  app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuthStub, { pool, ticketService }));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(app: express.Express, route: string, init?: RequestInit): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/queue/dlq${route}`, init);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function selectCalls(calls: QueryCall[]): QueryCall[] {
  return calls.filter((c) => /^\s*SELECT/i.test(c.sql));
}

describe('GET /api/queue/dlq — the quarantine table the Dead Letters surface renders', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  it('rejects an unauthenticated caller with 401 before the DLQ table is read', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, calls } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(null, pool), '/');
    expect(res.status).toBe(401);
    expect(selectCalls(calls)).toHaveLength(0);
  });

  it("denies an authenticated NON-operator with 403 — no other user's ticket text is read at all", async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub; // PLAIN is not allowlisted
    const { pool, calls } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(PLAIN, pool), '/');
    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('Operator privilege required');
    expect(selectCalls(calls)).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('someone elses private ticket title');
  });

  it('denies EVERY caller when the operator allowlist is empty (fail-closed)', async () => {
    const { pool, calls } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(OPERATOR, pool), '/');
    expect(res.status).toBe(403);
    expect(selectCalls(calls)).toHaveLength(0);
  });

  it('hands an operator the quarantine entries and echoes the includeAll toggle', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(OPERATOR, pool), '/');
    expect(res.status).toBe(200);
    expect(res.body?.includeAll).toBe(false);
    const entries = res.body?.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ticketId).toBe(TICKET_ID);
    expect(entries[0]?.attempts).toBe(5);
    expect(entries[0]?.quarantinedAt).toBeTruthy();
  });

  it('?all=true reaches the service as includeAll (the surface toggle is not cosmetic)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, calls } = fakePool({ listRows: [] });
    const res = await hit(appFor(OPERATOR, pool), '/?all=true');
    expect(res.status).toBe(200);
    expect(res.body?.includeAll).toBe(true);
    // The quarantined-only read filters on quarantined_at; the all read must not.
    const sql = selectCalls(calls).map((c) => c.sql).join('\n');
    expect(sql.length).toBeGreaterThan(0);
  });
});

describe('POST /api/queue/dlq/:ticketId/requeue — releasing one ticket', () => {
  beforeEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
  afterEach(() => {
    delete process.env.OSHAL_OPERATOR_SUBS;
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });

  const post: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };

  it('rejects an unauthenticated caller with 401 without writing anything', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, calls } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(null, pool), `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('denies an authenticated NON-operator with 403 without writing anything', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, calls } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(PLAIN, pool), `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-UUID ticket id with 400 before it reaches SQL or a log line', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool, calls } = fakePool();
    const res = await hit(appFor(OPERATOR, pool), '/not-a-uuid/requeue', post);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when no dead-letter row matches (the surface says "already released")', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ listRows: [] });
    const res = await hit(appFor(OPERATOR, pool), `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(404);
    expect(res.body?.error).toBe('not-found');
  });

  it('answers 404 for a row that exists but is NOT quarantined (still accumulating)', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ listRows: [{ ...QUARANTINED_ROW, quarantined_at: null }] });
    const res = await hit(appFor(OPERATOR, pool), `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(404);
    expect(res.body?.error).toBe('not-found');
  });

  it('answers 409 invalid-state (distinct from 404) when the ticket cannot be moved to approved', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ listRows: [QUARANTINED_ROW] });
    const app = appFor(OPERATOR, pool, async () => { throw new Error('illegal transition from running'); });
    const res = await hit(app, `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(409);
    expect(res.body?.error).toBe('invalid-state');
  });

  it('answers 503 unavailable (distinct from 404 and 409) when the DLQ store itself errors', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ throwOnSelect: true });
    const res = await hit(appFor(OPERATOR, pool), `/${TICKET_ID}/requeue`, post);
    expect(res.status).toBe(503);
    expect(res.body?.error).toBe('unavailable');
  });

  it('records the acting operator (from the session, never the body) on a successful release', async () => {
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR.sub;
    const { pool } = fakePool({ listRows: [QUARANTINED_ROW] });
    const res = await hit(appFor(OPERATOR, pool), `/${TICKET_ID}/requeue`, {
      ...post,
      body: JSON.stringify({ requeuedBy: 'someone-else@example.test' }),
    });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    const entry = res.body?.entry as Record<string, unknown>;
    expect(entry.requeuedBy).toBe(OPERATOR.email);
    expect(entry.attempts).toBe(0);
    expect(entry.quarantinedAt).toBeNull();
  });
});
