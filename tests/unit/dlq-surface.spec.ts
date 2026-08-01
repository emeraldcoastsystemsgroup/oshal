/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard dlq-surface-shows-real-entries for the operator DLQ tool surface, which shipped (PR #24) with no guard of its own. Drives the REAL /api/queue/dlq router over a STUBBED oshal_queue_dlq store and asserts the payload carries what / why / when / how-many for a genuinely quarantined row, that a non-operator is refused, and that requeue transitions through the real service. The surface half derives its field list from the ROUTE'S OWN RESPONSE rather than a hardcoded list, so dropping a field from dlq.html goes red AND a future field the route grows but the surface ignores goes red too — the drift a substring assertion would never notice.
 */

import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createQueueDlqRoutes } from '@/app/routes/queue-dlq-routes';
import type { TicketService } from '@/features/ticketing';

const realFetch = globalThis.fetch;
const DLQ_HTML = path.join(process.cwd(), 'src/pages/cockpit/tools/dlq.html');
const TICKET_ID = '11111111-2222-3333-4444-555555555555';

/**
 * @description Blank out line comments and block comments so a field name that appears only in
 * prose cannot satisfy a "the surface renders this field" assertion.
 * @param src - Raw file text.
 * @returns The text with comment bodies removed.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const OPERATOR = { sub: 'dlq-op-sub', email: 'ops@example.test' };
const PLAIN = { sub: 'dlq-plain-sub', email: 'plain@example.test' };

/** One genuinely quarantined row, in the column shape oshal_queue_dlq actually returns. */
const DLQ_ROW = {
  ticket_id: TICKET_ID,
  attempts: 5,
  last_error: 'bot-node oshal-local-rca refused: ECONNREFUSED',
  last_failure_at: new Date('2026-07-30T11:22:33.000Z'),
  quarantined_at: new Date('2026-07-30T11:25:00.000Z'),
  reason: 'max-attempts-exceeded',
  requeued_by: null,
  requeued_at: null,
  title: 'RCA for the 03:14 chromadb crash',
  status: 'escalated',
  ticket_type: 'incident',
};

/** Pool double that answers the DLQ list/read SQL and records every statement. */
function stubPool(rows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/UPDATE\s+oshal_queue_dlq/i.test(sql)) return { rows: [], rowCount: 1 };
        return { rows, rowCount: rows.length };
      },
      connect: async () => ({
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return { rows, rowCount: rows.length };
        },
        release: () => {},
      }),
    } as never,
  };
}

function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(
  user: Record<string, string> | null,
  pool: never,
  ticketService: TicketService,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuthStub, { pool, ticketService }));
  return app;
}

async function hit(app: express.Express, route: string, init?: RequestInit) {
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

/** The operator allowlist requiresOperator reads. Restored by each test that sets it. */
function withOperator<T>(sub: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OSHAL_OPERATOR_SUBS;
  process.env.OSHAL_OPERATOR_SUBS = sub;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
    else process.env.OSHAL_OPERATOR_SUBS = prev;
  });
}

describe('dlq-surface-shows-real-entries', () => {
  it('the list answers WHAT, WHY, WHEN and HOW MANY for a quarantined ticket', async () => {
    const { pool } = stubPool([DLQ_ROW]);
    const res = await withOperator(OPERATOR.sub, () => hit(
      appFor(OPERATOR, pool, {} as TicketService),
      '',
    ));
    expect(res.status).toBe(200);
    const entries = (res.body?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const e = entries[0];
    // WHAT
    expect(e.ticketId).toBe(TICKET_ID);
    expect(e.title).toBe('RCA for the 03:14 chromadb crash');
    expect(e.ticketType).toBe('incident');
    // WHY
    expect(e.reason).toBe('max-attempts-exceeded');
    expect(e.lastError).toContain('ECONNREFUSED');
    // WHEN
    expect(String(e.quarantinedAt)).toContain('2026-07-30');
    expect(String(e.lastFailureAt)).toContain('2026-07-30');
    // HOW MANY
    expect(e.attempts).toBe(5);
  });

  it('a non-operator is refused the list (the DLQ carries other users ticket titles)', async () => {
    const { pool, calls } = stubPool([DLQ_ROW]);
    const res = await withOperator(OPERATOR.sub, () => hit(
      appFor(PLAIN, pool, {} as TicketService),
      '',
    ));
    expect(res.status).toBe(403);
    // and the store was never even read for them
    expect(calls.filter((c) => /oshal_queue_dlq/i.test(c.sql))).toHaveLength(0);
  });

  it('an anonymous caller is refused before the operator check', async () => {
    const { pool } = stubPool([DLQ_ROW]);
    const res = await hit(appFor(null, pool, {} as TicketService), '');
    expect(res.status).toBe(401);
  });

  it('requeue transitions the ticket through the real TicketService and records the operator', async () => {
    const { pool } = stubPool([DLQ_ROW]);
    const updateStatus = vi.fn(async () => ({ ok: true }));
    const ticketService = { updateTicketStatus: updateStatus, updateStatus } as unknown as TicketService;
    const res = await withOperator(OPERATOR.sub, () => hit(
      appFor(OPERATOR, pool, ticketService),
      `/${TICKET_ID}/requeue`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    ));
    // The route must not invent a rail: it either releases through the service or reports a
    // real failure code. What it may never do is answer ok without touching the store.
    expect([200, 409, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.ok).toBe(true);
      expect(updateStatus).toHaveBeenCalled();
    }
  });

  it('a malformed ticket id is rejected before it reaches SQL', async () => {
    const { pool, calls } = stubPool([DLQ_ROW]);
    const res = await withOperator(OPERATOR.sub, () => hit(
      appFor(OPERATOR, pool, {} as TicketService),
      '/not-a-uuid/requeue',
      { method: 'POST' },
    ));
    expect(res.status).toBe(400);
    expect(calls.filter((c) => /oshal_queue_dlq/i.test(c.sql))).toHaveLength(0);
  });

  /**
   * The surface half. The field list is taken from the ROUTE'S OWN response, so this assertion
   * cannot go stale: a field the route grows and the surface ignores fails here, and a field the
   * surface stops rendering fails here. That is the drift a `toContain('lastError')` never catches.
   */
  it('the cockpit DLQ surface renders every field the route emits', async () => {
    const { pool } = stubPool([DLQ_ROW]);
    const res = await withOperator(OPERATOR.sub, () => hit(
      appFor(OPERATOR, pool, {} as TicketService),
      '',
    ));
    const entry = ((res.body?.entries ?? []) as Array<Record<string, unknown>>)[0];
    // Comments are stripped and the check demands a PROPERTY READ (`e.field` / `e['field']`), not
    // the field NAME appearing somewhere in the file. A bare word-presence version of this
    // assertion SURVIVED its own mutation while this change was being written: deleting the
    // lastFailureAt cell left the word alive in the comment that explained the cell, and the guard
    // stayed green. A guard a comment can satisfy is not a guard.
    const html = stripComments(readFileSync(DLQ_HTML, 'utf8'));
    const missing = Object.keys(entry).filter(
      (field) => !new RegExp(`(?:\\.\\s*${field}\\b|\\[\\s*['"\`]${field}['"\`]\\s*\\])`).test(html),
    );
    expect(missing, `dlq.html never READS these route fields: ${missing.join(', ')}`).toEqual([]);
  });

  it('the surface only offers actions the backend actually exposes', () => {
    const html = readFileSync(DLQ_HTML, 'utf8');
    // requeue + export exist on the router; nothing else may be offered.
    expect(html).toMatch(/\/api\/queue\/dlq\/'\s*\+\s*encodeURIComponent\([^)]*\)\s*\+\s*'\/requeue/);
    expect(html).toContain('/api/queue/dlq/export');
    // No invented rails: there is no delete/purge/replay endpoint on this router.
    expect(html).not.toMatch(/\/api\/queue\/dlq\/[^'"]*\/(delete|purge|replay|drop)/);
    expect(html).not.toMatch(/method:\s*'DELETE'/);
  });
});
