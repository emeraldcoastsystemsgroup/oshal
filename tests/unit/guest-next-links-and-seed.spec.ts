/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pins the public guest-demo entry rails: (1) /guest?next= deep links are same-origin only — the landing form carries a sanitized next, start redirects there, off-origin/protocol-relative/oversized values fall back to /cockpit/, and an already-authenticated visitor skips the landing; (2) the demo seed runs inside ONE transaction with a transaction-local oshal.current_sub GUC (FORCE-RLS rejected every guest's seed until 2026-07-18) and only ever plants queue-INERT ticket statuses (complete/backlog) so a seeded ticket can never be dispatched to a bot and spend LLM.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuestRoutes } from '../../src/app/routes/guest-routes';
import { seedGuestDemoData } from '../../src/app/routes/guest-demo-seed';

const NEXT_ENCODED = '%2Fcockpit%2F%3Fapp%3Djarvis';
const NEXT_DECODED = '/cockpit/?app=jarvis';

describe('guest ?next= deep links', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.ENABLE_GUEST_MODE = process.env.ENABLE_GUEST_MODE;
    savedEnv.SESSION_SECRET = process.env.SESSION_SECRET;
    process.env.ENABLE_GUEST_MODE = 'true';
    process.env.SESSION_SECRET = 'unit-test-secret';
  });

  afterEach(async () => {
    process.env.ENABLE_GUEST_MODE = savedEnv.ENABLE_GUEST_MODE;
    process.env.SESSION_SECRET = savedEnv.SESSION_SECRET;
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(resolve))));
    servers.length = 0;
  });

  /**
   * @description Boots a throwaway express app with the guest routes mounted.
   * @param authed - When true, injects an authenticated req.oidc before the routes.
   * @returns The app's base URL.
   */
  function boot(authed = false): string {
    const app = express();
    if (authed) {
      app.use((req, _res, next) => {
        (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub: 'guest-existing' } };
        next();
      });
    }
    app.use(createGuestRoutes());
    const server = app.listen(0);
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('carries a sanitized next through the landing form action', async () => {
    const html = await (await fetch(`${boot()}/guest?next=${NEXT_ENCODED}`)).text();
    expect(html).toContain(`action="/api/guest/start?next=${NEXT_ENCODED}"`);
  });

  it('redirects the started session to next', async () => {
    const res = await fetch(`${boot()}/api/guest/start?next=${NEXT_ENCODED}`, { method: 'POST', redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(NEXT_DECODED);
    expect(res.headers.get('set-cookie')).toContain('oshal_guest=');
  });

  it.each([
    ['absolute URL', 'https%3A%2F%2Fevil.example'],
    ['protocol-relative', '%2F%2Fevil.example'],
    ['backslash smuggle', '%2F%5Cevil.example'],
    ['oversized', encodeURIComponent('/' + 'a'.repeat(301))],
  ])('rejects %s next and falls back to /cockpit/', async (_label, bad) => {
    const base = boot();
    const landing = await (await fetch(`${base}/guest?next=${bad}`)).text();
    expect(landing).toContain('action="/api/guest/start"');
    const res = await fetch(`${base}/api/guest/start?next=${bad}`, { method: 'POST', redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/cockpit/');
  });

  it('skips the landing for an already-authenticated visitor with a next', async () => {
    const res = await fetch(`${boot(true)}/guest?next=${NEXT_ENCODED}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(NEXT_DECODED);
  });

  it('still renders the plain landing without a next', async () => {
    const html = await (await fetch(`${boot()}/guest`)).text();
    expect(html).toContain('Continue as guest');
    expect(html).toContain('action="/api/guest/start"');
  });

  it('is inert (404) when guest mode is off', async () => {
    process.env.ENABLE_GUEST_MODE = 'false';
    const res = await fetch(`${boot()}/guest?next=${NEXT_ENCODED}`);
    expect(res.status).toBe(404);
  });
});

describe('guest demo seed (RLS + queue safety)', () => {
  /**
   * @description Pool mock capturing every query the seed issues on one client.
   * @param failOn - Substring of a SQL statement that should throw, if any.
   */
  function mockPool(failOn?: string) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (failOn && sql.includes(failOn)) throw new Error(`forced failure on: ${failOn}`);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client) } as never, client, calls };
  }

  it('seeds inside one transaction with a transaction-local guest GUC', async () => {
    const { pool, client, calls } = mockPool();
    await seedGuestDemoData(pool, 'guest-abc');

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain("set_config('oshal.current_sub', $1, true)");
    expect(calls[1].params).toEqual(['guest-abc']);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('stamps every ticket with the guest sub and only queue-inert statuses', async () => {
    const { pool, calls } = mockPool();
    await seedGuestDemoData(pool, 'guest-abc');

    const ticketInserts = calls.filter((c) => c.sql.includes('INSERT INTO tickets'));
    expect(ticketInserts.length).toBeGreaterThanOrEqual(4);
    const statuses = ticketInserts.map((insert) => (insert.params as unknown[])[4] as string);
    for (const insert of ticketInserts) {
      const params = insert.params as unknown[];
      expect(params).toContain('guest-abc'); // owner_sub
    }
    // Queue-inert only: the poll loop dispatches `approved` and the orphan sweeps
    // re-queue in_process_* — none of these may ever appear here, or an anonymous
    // visitor's seed becomes dispatchable work that spends real LLM tokens.
    for (const status of statuses) {
      expect(['complete', 'backlog', 'customer_action']).toContain(status);
    }
    // The Tickets view defaults to "Active" (hides complete/cancelled) — at least one
    // seeded ticket must be active-visible or the guest's first view looks empty.
    expect(statuses.some((s) => s !== 'complete' && s !== 'cancelled')).toBe(true);
  });

  it('rolls back, releases, and never throws when a ticket insert fails', async () => {
    const { pool, client, calls } = mockPool('INSERT INTO tickets');
    await expect(seedGuestDemoData(pool, 'guest-abc')).resolves.toBeUndefined();
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.map((c) => c.sql)).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('keeps the tickets when the finance seed fails (package-owned tables may be absent)', async () => {
    const { pool, calls } = mockPool('INSERT INTO oshal_finance_items');
    await expect(seedGuestDemoData(pool, 'guest-abc')).resolves.toBeUndefined();
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT finance_seed');
    expect(sqls[sqls.length - 1]).toBe('COMMIT'); // tickets still land
  });
});
