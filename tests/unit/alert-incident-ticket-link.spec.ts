/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-19 guard: a delivery whose incident revision moves between consolidation and the ticket link must end LINKED, and a revision that never settles must be reported at ERROR with the incident id, never dropped. Runs the real receiver over a disposable migrated PostgreSQL; the only interposition is a second writer bumping the row's revision at the exact moment a concurrent pump's refire would, so the optimistic-concurrency miss is the database's own.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => {
  const spies = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  };
  spies.child.mockReturnValue(spies);
  return spies;
});
vi.mock('@/shared/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => logSpies,
}));

import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const database = new DisposableAlertPostgres();
const TOKEN = 'ticket-link-spec-token';
const RUN = `lnk-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const ALERTNAME = 'SwarmContainerDown';

/** When set, runs on the REAL pool just before the matching statement — a second writer. */
let interpose: ((sql: string, values: unknown[]) => Promise<void>) | null = null;
let realPool: Pool;
let server: Server;
let baseUrl: string;
let ticketService: TicketService;

/**
 * @description The receiver's pool: the real disposable pool, with a hook that can run a
 * competing write immediately before a chosen statement. Connections, transactions and every
 * statement still execute on the real database.
 * @param real - The disposable pool.
 * @returns A pool the receiver cannot tell apart from the real one.
 */
function interposingPool(real: Pool): Pool {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: string, values: unknown[] = []) => {
          if (interpose) await interpose(String(sql), values);
          return target.query(sql, values);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A concurrent pump's refire of the same incident: it moves the revision and nothing else. */
async function bumpRevision(incidentId: unknown): Promise<void> {
  await realPool.query('UPDATE oshal_incident SET revision = revision + 1 WHERE incident_id = $1', [incidentId]);
}

/** Posts one firing alert for `target`. */
async function postAlert(target: string): Promise<Response> {
  return fetch(`${baseUrl}/api/alerts/alertmanager`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      receiver: 'oshal-incident-intake',
      status: 'firing',
      groupKey: `{}:{alertname="${ALERTNAME}"}`,
      alerts: [{
        status: 'firing',
        labels: { alertname: ALERTNAME, container: target, severity: 'critical' },
        annotations: { summary: `${target} is down` },
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        fingerprint: `${target}-fp`,
      }],
    }),
  });
}

/** Waits for the drain transaction to commit this target's event. */
async function settle(target: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const { rows } = await realPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM oshal_alert_event WHERE target = $1 AND processed_at IS NOT NULL', [target]);
    if (rows[0].n === 1) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the drain never decided the event for ${target}`);
}

/** This target's incident row, read past the store. */
async function incidentFor(target: string): Promise<{ incident_id: string; ticket_id: string | null; revision: string }> {
  const { rows } = await realPool.query(
    'SELECT incident_id, ticket_id, revision FROM oshal_incident WHERE primary_target = $1', [target]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeAll(async () => {
  vi.stubEnv('ALERT_WEBHOOK_TOKEN', TOKEN);
  vi.stubEnv('ALERT_APPROVED_NAMES', ALERTNAME);
  for (const key of ['ALERT_WEBHOOK_HMAC_SECRET', 'ALERT_CLAIMS_FILE', 'ALERT_BACKLOG_NAMES']) vi.stubEnv(key, '');
  vi.stubEnv('ALERT_DEFAULT_INTAKE', 'backlog');
  realPool = await database.start();
  ticketService = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(ticketService, { pool: interposingPool(realPool), startPendingSweep: false }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 90_000);

afterAll(async () => {
  try { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
  finally { await database.stop(); vi.unstubAllEnvs(); }
}, 60_000);

beforeEach(() => {
  interpose = null;
  logSpies.error.mockClear();
});

describe('the incident is linked to its ticket even when its revision moves (BUG-19)', { timeout: 60_000 }, () => {
  it('re-reads and lands the link when a concurrent refire moves the revision first', async () => {
    const target = `${RUN}-once-container`;
    let bumped = false;
    interpose = async (sql, values) => {
      // The member upsert runs between consolidation and the link — where a second pump's refire lands.
      if (!bumped && /INSERT INTO oshal_incident_member/.test(sql)) {
        bumped = true;
        await bumpRevision(values[0]);
      }
    };
    expect((await postAlert(target)).status).toBe(202);
    await settle(target);

    expect(bumped).toBe(true);
    const row = await incidentFor(target);
    expect(row.ticket_id).toBeTruthy();
    expect(await ticketService.getTicket(row.ticket_id as string)).toBeTruthy();
    const { rows: events } = await realPool.query('SELECT incident_id FROM oshal_alert_event WHERE target = $1', [target]);
    expect(events[0].incident_id).toBe(row.incident_id);
  });

  it('reports a link that never settles at ERROR with the incident id instead of dropping it', async () => {
    const target = `${RUN}-never-container`;
    let collisions = 0;
    interpose = async (sql, values) => {
      // Every ticket-link attempt loses: the revision moves just before each patch.
      if (/UPDATE oshal_incident\s+SET ticket_id/.test(sql)) {
        collisions += 1;
        await bumpRevision(values[0]);
      }
    };
    expect((await postAlert(target)).status).toBe(202);
    await settle(target);

    const row = await incidentFor(target);
    expect(collisions).toBeGreaterThan(0);
    expect(row.ticket_id).toBeNull();
    const reported = logSpies.error.mock.calls.some(([fields]) =>
      (fields as { incidentId?: string } | undefined)?.incidentId === row.incident_id);
    expect(reported, 'no ERROR log names the unlinked incident').toBe(true);
  });
});
